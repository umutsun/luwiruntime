import type { AgentKind, CapabilitySource } from '@luwi/protocol';
import { createHash } from 'node:crypto';
import { open, opendir, realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export type CapabilityObservationRoot = {
  path: string;
  scope: 'global' | 'project';
  projectId?: string;
  source: Extract<CapabilitySource, 'agent-native' | 'local-path'>;
  adapterId: string;
  compatibleAgentKinds: AgentKind[];
};

export type CapabilityObserverDirectoryEntry = {
  name: string;
  isDirectory: boolean;
};

export type CapabilityObserverDirectoryListing = {
  entries: CapabilityObserverDirectoryEntry[];
  truncated: boolean;
};

export interface CapabilityObserverFileSystem {
  canonicalize(path: string): Promise<string | undefined>;
  listDirectory(
    path: string,
    maxEntries: number,
  ): Promise<CapabilityObserverDirectoryListing | undefined>;
  readTextFile(
    path: string,
    maxBytes: number,
  ): Promise<{ content: string; truncated: boolean } | undefined>;
}

export type ObservedCapability = {
  id: string;
  kind: 'skill';
  name: string;
  version?: string;
  scope: 'global' | 'project';
  projectId?: string;
  source: Extract<CapabilitySource, 'agent-native' | 'local-path'>;
  path: string;
  checksum: string;
  compatibleAgentKinds: AgentKind[];
  manifest: {
    managementMode: 'observed';
    description: string;
    observation: {
      adapterId: string;
      root: string;
      manifestPath: string;
      observedAt: string;
    };
  };
};

export type CapabilityObservationResult = {
  capabilities: ObservedCapability[];
  diagnostics: {
    rootsScanned: number;
    rootsUnavailable: number;
    malformedManifests: number;
    ignoredEntries: number;
    truncated: boolean;
  };
};

export interface CapabilityObserver {
  scan(roots: readonly CapabilityObservationRoot[]): Promise<CapabilityObservationResult>;
}

export type CapabilityObserverOptions = {
  fileSystem?: CapabilityObserverFileSystem;
  platform?: NodeJS.Platform;
  now?: () => Date;
  clock?: () => number;
  maxRoots?: number;
  maxEntries?: number;
  maxManifestBytes?: number;
  maxDurationMs?: number;
};

const DEFAULT_MAX_ROOTS = 64;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_DURATION_MS = 2_500;

function unavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' ||
      error.code === 'EACCES' ||
      error.code === 'EPERM' ||
      error.code === 'ENOTDIR')
  );
}

export class NodeCapabilityObserverFileSystem implements CapabilityObserverFileSystem {
  async canonicalize(path: string): Promise<string | undefined> {
    try {
      return await realpath(path);
    } catch (error) {
      if (unavailable(error)) return undefined;
      throw error;
    }
  }

  async listDirectory(
    path: string,
    maxEntries: number,
  ): Promise<CapabilityObserverDirectoryListing | undefined> {
    let directory: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      directory = await opendir(path);
      const entries: CapabilityObserverDirectoryEntry[] = [];
      while (entries.length < maxEntries) {
        const entry = await directory.read();
        if (entry === null) return { entries, truncated: false };
        entries.push({ name: entry.name, isDirectory: entry.isDirectory() });
      }
      return { entries, truncated: true };
    } catch (error) {
      if (unavailable(error)) return undefined;
      throw error;
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  async readTextFile(
    path: string,
    maxBytes: number,
  ): Promise<{ content: string; truncated: boolean } | undefined> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, 'r');
      const metadata = await file.stat();
      const bytesToRead = Math.min(metadata.size, maxBytes);
      const buffer = Buffer.alloc(bytesToRead);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return {
        content: buffer.subarray(0, offset).toString('utf8'),
        truncated: metadata.size > maxBytes,
      };
    } catch (error) {
      if (unavailable(error)) return undefined;
      throw error;
    } finally {
      await file?.close();
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '|' || trimmed === '>') return undefined;
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  const result = quoted ? trimmed.slice(1, -1).trim() : trimmed;
  return result === '' ? undefined : result;
}

function parseFrontmatter(
  content: string,
): { name: string; description: string; version?: string } | undefined {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 2) return undefined;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match === null) continue;
    const key = match[1]?.toLowerCase();
    const value = scalar(match[2] ?? '');
    if (key !== undefined && value !== undefined && !fields.has(key)) fields.set(key, value);
  }
  const name = fields.get('name');
  const description = fields.get('description');
  const version = fields.get('version');
  if (
    name === undefined ||
    description === undefined ||
    name.length > 200 ||
    description.length > 2_000 ||
    (version !== undefined && version.length > 200)
  ) {
    return undefined;
  }
  return { name, description, ...(version === undefined ? {} : { version }) };
}

function isWithin(root: string, target: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

const OBSERVATION_TIMED_OUT = Symbol('observation-timed-out');

async function waitWithinDeadline<Value>(
  operation: Promise<Value>,
  remainingMs: number,
): Promise<Value | typeof OBSERVATION_TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof OBSERVATION_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(OBSERVATION_TIMED_OUT), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createCapabilityObserver(
  options: CapabilityObserverOptions = {},
): CapabilityObserver {
  const fileSystem = options.fileSystem ?? new NodeCapabilityObserverFileSystem();
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? Date.now;
  const maxRoots = positiveLimit(options.maxRoots ?? DEFAULT_MAX_ROOTS, 'maxRoots');
  const maxEntries = positiveLimit(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries');
  const maxManifestBytes = positiveLimit(
    options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
    'maxManifestBytes',
  );
  const maxDurationMs = positiveLimit(
    options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    'maxDurationMs',
  );
  const path = platform === 'win32' ? win32 : posix;

  return {
    async scan(roots) {
      const diagnostics: CapabilityObservationResult['diagnostics'] = {
        rootsScanned: 0,
        rootsUnavailable: 0,
        malformedManifests: 0,
        ignoredEntries: 0,
        truncated: roots.length > maxRoots,
      };
      const capabilities: ObservedCapability[] = [];
      const capabilityIds = new Set<string>();
      const rootKeys = new Set<string>();
      const startedAt = clock();
      let entriesSeen = 0;
      const remainingDuration = (): number => maxDurationMs - (clock() - startedAt);
      const observe = async <Value>(
        operation: () => Promise<Value>,
      ): Promise<Value | typeof OBSERVATION_TIMED_OUT> => {
        const remainingMs = remainingDuration();
        if (remainingMs <= 0) return OBSERVATION_TIMED_OUT;
        return await waitWithinDeadline(operation(), remainingMs);
      };

      rootLoop: for (const root of roots.slice(0, maxRoots)) {
        if (remainingDuration() <= 0) {
          diagnostics.truncated = true;
          break;
        }
        const declaredKey = [
          root.scope,
          root.projectId ?? '',
          root.adapterId,
          path.resolve(root.path),
        ].join('\0');
        if (rootKeys.has(declaredKey)) continue;
        rootKeys.add(declaredKey);

        const canonicalRootResult = await observe(
          async () => await fileSystem.canonicalize(root.path),
        );
        if (canonicalRootResult === OBSERVATION_TIMED_OUT) {
          diagnostics.truncated = true;
          break;
        }
        const canonicalRoot = canonicalRootResult;
        if (canonicalRoot === undefined) {
          diagnostics.rootsUnavailable += 1;
          continue;
        }
        const remainingEntries = maxEntries - entriesSeen;
        if (remainingEntries <= 0) {
          diagnostics.truncated = true;
          break;
        }
        const listingResult = await observe(
          async () => await fileSystem.listDirectory(canonicalRoot, remainingEntries),
        );
        if (listingResult === OBSERVATION_TIMED_OUT) {
          diagnostics.truncated = true;
          break;
        }
        if (listingResult === undefined) {
          diagnostics.rootsUnavailable += 1;
          continue;
        }
        diagnostics.rootsScanned += 1;

        for (const entry of listingResult.entries.toSorted((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          if (entriesSeen >= maxEntries || remainingDuration() <= 0) {
            diagnostics.truncated = true;
            break rootLoop;
          }
          entriesSeen += 1;
          if (!entry.isDirectory) {
            diagnostics.ignoredEntries += 1;
            continue;
          }
          const candidateResult = await observe(
            async () => await fileSystem.canonicalize(path.join(canonicalRoot, entry.name)),
          );
          if (candidateResult === OBSERVATION_TIMED_OUT) {
            diagnostics.truncated = true;
            break rootLoop;
          }
          const candidate = candidateResult;
          if (candidate === undefined || !isWithin(canonicalRoot, candidate, platform)) {
            diagnostics.ignoredEntries += 1;
            continue;
          }
          const declaredManifest = path.join(candidate, 'SKILL.md');
          const manifestPathResult = await observe(
            async () => await fileSystem.canonicalize(declaredManifest),
          );
          if (manifestPathResult === OBSERVATION_TIMED_OUT) {
            diagnostics.truncated = true;
            break rootLoop;
          }
          const manifestPath = manifestPathResult;
          if (
            manifestPath === undefined ||
            !isWithin(canonicalRoot, manifestPath, platform) ||
            !isWithin(candidate, manifestPath, platform)
          ) {
            diagnostics.ignoredEntries += 1;
            continue;
          }
          const fileResult = await observe(
            async () => await fileSystem.readTextFile(manifestPath, maxManifestBytes),
          );
          if (fileResult === OBSERVATION_TIMED_OUT) {
            diagnostics.truncated = true;
            break rootLoop;
          }
          const file = fileResult;
          if (file === undefined) {
            diagnostics.ignoredEntries += 1;
            continue;
          }
          if (file.truncated) {
            diagnostics.ignoredEntries += 1;
            diagnostics.truncated = true;
            continue;
          }
          const frontmatter = parseFrontmatter(file.content);
          if (frontmatter === undefined) {
            diagnostics.malformedManifests += 1;
            continue;
          }
          const id = `observed:${sha256(
            [root.scope, root.projectId ?? '', root.adapterId, candidate].join('\0'),
          ).slice(0, 24)}`;
          if (capabilityIds.has(id)) {
            diagnostics.ignoredEntries += 1;
            continue;
          }
          capabilityIds.add(id);
          capabilities.push({
            id,
            kind: 'skill',
            name: frontmatter.name,
            ...(frontmatter.version === undefined ? {} : { version: frontmatter.version }),
            scope: root.scope,
            ...(root.projectId === undefined ? {} : { projectId: root.projectId }),
            source: root.source,
            path: candidate,
            checksum: sha256(file.content),
            compatibleAgentKinds: [...new Set(root.compatibleAgentKinds)].sort(),
            manifest: {
              managementMode: 'observed',
              description: frontmatter.description,
              observation: {
                adapterId: root.adapterId,
                root: canonicalRoot,
                manifestPath,
                observedAt: now().toISOString(),
              },
            },
          });
        }
        if (listingResult.truncated) {
          diagnostics.truncated = true;
          break;
        }
      }

      return {
        capabilities: capabilities.toSorted((left, right) => left.id.localeCompare(right.id)),
        diagnostics,
      };
    },
  };
}
