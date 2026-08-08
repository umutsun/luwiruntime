import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  packageRecordSchema,
  technologyRecordSchema,
  type PackageDependencyType,
  type PackageEcosystem,
  type PackageRecord,
  type TechnologyRecord,
} from '@luwi/protocol';

const MAX_SCAN_FILES = 20_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MANIFEST_READ_CHUNK_BYTES = 64 * 1024;
const ignoredDirectories = new Set([
  '.git',
  '.dart_tool',
  '.pnpm-store',
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  'coverage',
]);

export type PackageInventoryErrorCode =
  'PACKAGE_MANIFEST_UNSUPPORTED' | 'PACKAGE_MANIFEST_PARSE_FAILED' | 'PACKAGE_SCAN_FAILED';

export class PackageInventoryError extends Error {
  constructor(
    readonly code: PackageInventoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PackageInventoryError';
  }
}

export type PackageInventoryResult = {
  packages: PackageRecord[];
  technologies: TechnologyRecord[];
  scannedAt: string;
  manifestCount: number;
  /**
   * Every directory whose manifest was parsed, regardless of whether it
   * declared a dependency. ADR 0014: module identity is a fact about
   * manifests, not about dependency records.
   */
  workspaceLocations: string[];
  fileCount: number;
  truncated: boolean;
  evidenceScope: 'git-tracked' | 'filesystem';
};

export type PackageInventoryScanInput = {
  projectId: string;
  localPath: string;
  trackedPaths?: readonly string[];
};

export type PackageInventoryScannerOptions = {
  now?: () => Date;
  maximumFiles?: number;
};

export interface PackageInventoryScanner {
  scan(input: PackageInventoryScanInput): Promise<PackageInventoryResult>;
}

type CandidatePackage = {
  ecosystem: PackageEcosystem;
  packageName: string;
  declaredVersion?: string | undefined;
  dependencyType: PackageDependencyType;
  direct?: boolean | undefined;
  workspaceLocation: string;
  manifestPath: string;
  manifestHash: string;
};

type TechnologyCandidate = {
  name: string;
  category: TechnologyRecord['category'];
  confidence: TechnologyRecord['confidence'];
  evidence: TechnologyRecord['evidence'];
};

function normalizedRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return value === '' ? '.' : value;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function packageId(projectId: string, candidate: CandidatePackage): string {
  return `pkg-${digest(
    [
      projectId,
      candidate.ecosystem,
      candidate.packageName,
      candidate.manifestPath,
      candidate.dependencyType,
    ].join('\0'),
  ).slice(0, 32)}`;
}

function technologyId(projectId: string, name: string, category: string): string {
  return `tech-${digest(`${projectId}\0${category}\0${name}`).slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function dependencyCandidates(
  ecosystem: PackageEcosystem,
  values: Record<string, string>,
  dependencyType: PackageDependencyType,
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): CandidatePackage[] {
  return Object.entries(values).map(([packageName, declaredVersion]) => ({
    ...common,
    ecosystem,
    packageName,
    declaredVersion,
    dependencyType,
  }));
}

function parseJson(text: string, manifestPath: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new PackageInventoryError(
      'PACKAGE_MANIFEST_PARSE_FAILED',
      `A supported package manifest could not be parsed: ${manifestPath}`,
    );
  }
}

function parseNode(
  text: string,
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): { packages: CandidatePackage[]; technologies: TechnologyCandidate[] } {
  const manifest = parseJson(text, common.manifestPath);
  const packages = [
    ...dependencyCandidates('node', stringRecord(manifest['dependencies']), 'production', common),
    ...dependencyCandidates(
      'node',
      stringRecord(manifest['devDependencies']),
      'development',
      common,
    ),
    ...dependencyCandidates(
      'node',
      stringRecord(manifest['optionalDependencies']),
      'optional',
      common,
    ),
    ...dependencyCandidates('node', stringRecord(manifest['peerDependencies']), 'peer', common),
  ];
  const technologies: TechnologyCandidate[] = [];
  const packageManager = manifest['packageManager'];
  if (typeof packageManager === 'string') {
    technologies.push({
      name: packageManager.split('@')[0] ?? packageManager,
      category: 'package-manager',
      confidence: 'high',
      evidence: [{ kind: 'manifest', value: packageManager, path: common.manifestPath }],
    });
  }
  return { packages, technologies };
}

function parseRequirements(
  text: string,
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): CandidatePackage[] {
  const packages: CandidatePackage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('-')) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(.*)$/);
    if (match?.[1] === undefined) continue;
    packages.push({
      ...common,
      ecosystem: 'python',
      packageName: match[1],
      ...(match[2]?.trim() === '' ? {} : { declaredVersion: match[2]?.trim() }),
      dependencyType: /test|dev/i.test(common.manifestPath) ? 'development' : 'production',
    });
  }
  return packages;
}

function parsePyproject(
  text: string,
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): CandidatePackage[] {
  const packages: CandidatePackage[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch?.[1] !== undefined) {
      section = sectionMatch[1];
      continue;
    }
    if (section === 'project' && line.startsWith('dependencies')) {
      for (const match of line.matchAll(/"([A-Za-z0-9_.-]+)([^"]*)"/g)) {
        const packageName = match[1];
        if (packageName !== undefined) {
          packages.push({
            ...common,
            ecosystem: 'python',
            packageName,
            ...(match[2]?.trim() === '' ? {} : { declaredVersion: match[2]?.trim() }),
            dependencyType: 'production',
          });
        }
      }
    }
    if (
      section === 'tool.poetry.dependencies' ||
      section === 'tool.poetry.group.dev.dependencies'
    ) {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/);
      if (match?.[1] !== undefined && match[1].toLowerCase() !== 'python') {
        packages.push({
          ...common,
          ecosystem: 'python',
          packageName: match[1],
          ...(match[2] === undefined ? {} : { declaredVersion: match[2] }),
          dependencyType: section.includes('.dev.') ? 'development' : 'production',
        });
      }
    }
  }
  return packages;
}

function parseIndentedDependencies(
  text: string,
  ecosystem: 'dart',
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): CandidatePackage[] {
  const packages: CandidatePackage[] = [];
  let dependencyType: PackageDependencyType | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (/^dependencies:\s*$/.test(raw)) dependencyType = 'production';
    else if (/^dev_dependencies:\s*$/.test(raw)) dependencyType = 'development';
    else if (/^[^\s#][^:]*:\s*/.test(raw)) dependencyType = undefined;
    else if (dependencyType !== undefined) {
      const match = raw.match(/^ {2}([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (match?.[1] !== undefined) {
        packages.push({
          ...common,
          ecosystem,
          packageName: match[1],
          ...(match[2]?.trim() === '' ? {} : { declaredVersion: match[2]?.trim() }),
          dependencyType,
        });
      }
    }
  }
  return packages;
}

function parseComposer(
  text: string,
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): CandidatePackage[] {
  const manifest = parseJson(text, common.manifestPath);
  return [
    ...dependencyCandidates('php', stringRecord(manifest['require']), 'production', common),
    ...dependencyCandidates('php', stringRecord(manifest['require-dev']), 'development', common),
  ];
}

function parseCargo(
  text: string,
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): CandidatePackage[] {
  const packages: CandidatePackage[] = [];
  let dependencyType: PackageDependencyType | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[(?:target\..+\.)?dependencies\]$/.test(line)) dependencyType = 'production';
    else if (/^\[dev-dependencies\]$/.test(line)) dependencyType = 'development';
    else if (/^\[build-dependencies\]$/.test(line)) dependencyType = 'build';
    else if (line.startsWith('[')) dependencyType = undefined;
    else if (dependencyType !== undefined) {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]+)"|\{)/);
      if (match?.[1] !== undefined) {
        packages.push({
          ...common,
          ecosystem: 'rust',
          packageName: match[1],
          ...(match[2] === undefined ? {} : { declaredVersion: match[2] }),
          dependencyType,
        });
      }
    }
  }
  return packages;
}

function parseGoMod(
  text: string,
  common: Omit<CandidatePackage, 'ecosystem' | 'packageName' | 'dependencyType'>,
): CandidatePackage[] {
  const packages: CandidatePackage[] = [];
  let inRequire = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'require (') {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ')') {
      inRequire = false;
      continue;
    }
    const value = inRequire ? line : line.replace(/^require\s+/, '');
    if (!inRequire && value === line) continue;
    const match = value.match(/^(\S+)\s+(\S+)/);
    if (match?.[1] !== undefined) {
      packages.push({
        ...common,
        ecosystem: 'go',
        packageName: match[1],
        ...(match[2] === undefined ? {} : { declaredVersion: match[2] }),
        dependencyType: 'production',
      });
    }
  }
  return packages;
}

const technologyDependencies: Record<
  string,
  { name: string; category: TechnologyRecord['category'] }
> = {
  fastify: { name: 'Fastify', category: 'framework' },
  react: { name: 'React', category: 'framework' },
  next: { name: 'Next.js', category: 'framework' },
  redis: { name: 'Redis', category: 'database' },
  vitest: { name: 'Vitest', category: 'test-tool' },
  jest: { name: 'Jest', category: 'test-tool' },
  typescript: { name: 'TypeScript', category: 'language' },
  flutter: { name: 'Flutter', category: 'framework' },
  django: { name: 'Django', category: 'framework' },
  pytest: { name: 'pytest', category: 'test-tool' },
  'laravel/framework': { name: 'Laravel', category: 'framework' },
  'phpunit/phpunit': { name: 'PHPUnit', category: 'test-tool' },
};

const languageExtensions: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.dart': 'Dart',
  '.php': 'PHP',
  '.rs': 'Rust',
  '.go': 'Go',
};

async function walk(root: string, maximumFiles: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length <= maximumFiles) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(path);
      } else if (entry.isFile()) {
        files.push(path);
        if (files.length > maximumFiles) break;
      }
    }
  }
  return files;
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export type ManifestFileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  isFile(): boolean;
};

export type ManifestReadHandle = {
  stat(): Promise<ManifestFileIdentity>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

export type ManifestFileOperations = {
  lstat(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<ManifestReadHandle>;
  stat(path: string): Promise<ManifestFileIdentity>;
};

const manifestFileOperations: ManifestFileOperations = {
  lstat: async (path) => {
    await lstat(path);
  },
  realpath,
  open: async (path) => {
    const handle = await open(path, 'r');
    return {
      stat: async () => await handle.stat({ bigint: true }),
      read: async (buffer, offset, length, position) =>
        await handle.read(buffer, offset, length, position),
      close: async () => await handle.close(),
    };
  },
  stat: async (path) => await stat(path, { bigint: true }),
};

function identitiesMatch(opened: ManifestFileIdentity, finalPath: ManifestFileIdentity): boolean {
  return (
    opened.isFile() &&
    finalPath.isFile() &&
    opened.dev > 0n &&
    opened.ino > 0n &&
    finalPath.dev > 0n &&
    finalPath.ino > 0n &&
    opened.dev === finalPath.dev &&
    opened.ino === finalPath.ino
  );
}

export async function readBoundedManifest(
  root: string,
  path: string,
  operations: ManifestFileOperations = manifestFileOperations,
): Promise<Buffer> {
  await operations.lstat(path);
  const canonicalTarget = await operations.realpath(path);
  if (!isWithin(root, canonicalTarget)) {
    throw new PackageInventoryError(
      'PACKAGE_SCAN_FAILED',
      'A package manifest resolved outside the canonical project root.',
    );
  }

  const handle = await operations.open(canonicalTarget);
  try {
    const openedIdentity = await handle.stat();
    if (!openedIdentity.isFile()) {
      throw new PackageInventoryError(
        'PACKAGE_SCAN_FAILED',
        'A package manifest target is not a regular file.',
      );
    }
    if (openedIdentity.size > BigInt(MAX_MANIFEST_BYTES)) {
      throw new PackageInventoryError(
        'PACKAGE_SCAN_FAILED',
        'A package manifest exceeded the configured size bound.',
      );
    }

    const stableTarget = await operations.realpath(path);
    if (!isWithin(root, stableTarget)) {
      throw new PackageInventoryError(
        'PACKAGE_SCAN_FAILED',
        'A package manifest resolved outside the canonical project root.',
      );
    }
    const finalIdentity = await operations.stat(stableTarget);
    if (!identitiesMatch(openedIdentity, finalIdentity)) {
      throw new PackageInventoryError(
        'PACKAGE_SCAN_FAILED',
        'A package manifest target changed during validation.',
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let position = 0;
    while (totalBytes <= MAX_MANIFEST_BYTES) {
      const remaining = MAX_MANIFEST_BYTES + 1 - totalBytes;
      if (remaining === 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(MANIFEST_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      if (bytesRead < 0 || bytesRead > buffer.byteLength) {
        throw new PackageInventoryError('PACKAGE_SCAN_FAILED', 'Package inventory scan failed.');
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
      position += bytesRead;
    }
    if (totalBytes > MAX_MANIFEST_BYTES) {
      throw new PackageInventoryError(
        'PACKAGE_SCAN_FAILED',
        'A package manifest exceeded the configured size bound.',
      );
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

export function createPackageInventoryScanner(
  options: PackageInventoryScannerOptions = {},
): PackageInventoryScanner {
  const now = options.now ?? (() => new Date());
  const maximumFiles = options.maximumFiles ?? MAX_SCAN_FILES;
  return {
    async scan(input) {
      const root = resolve(input.localPath);
      try {
        const canonicalRoot = await realpath(root);
        const evidenceScope = input.trackedPaths === undefined ? 'filesystem' : 'git-tracked';
        const selectedPaths =
          input.trackedPaths === undefined
            ? await walk(root, maximumFiles)
            : input.trackedPaths
                .map((path) => resolve(root, path))
                .filter((path) => {
                  const child = relative(root, path);
                  return child !== '..' && !child.startsWith(`..${sep}`);
                })
                .toSorted();
        const truncated = selectedPaths.length > maximumFiles;
        const files = selectedPaths.slice(0, maximumFiles);
        const detectedAt = now().toISOString();
        const candidates: CandidatePackage[] = [];
        const technologyCandidates: TechnologyCandidate[] = [];
        let manifestCount = 0;
        const workspaceLocations = new Set<string>();
        const languageCounts = new Map<string, number>();

        for (const path of files) {
          const extension = extname(path).toLowerCase();
          const language = languageExtensions[extension];
          if (language !== undefined) {
            languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
          }
          const name = path.split(/[\\/]/).at(-1) ?? '';
          const supported =
            [
              'package.json',
              'pyproject.toml',
              'pubspec.yaml',
              'composer.json',
              'Cargo.toml',
              'go.mod',
            ].includes(name) || /^requirements.*\.txt$/i.test(name);
          if (!supported) continue;

          manifestCount += 1;
          const content = await readBoundedManifest(canonicalRoot, path);
          workspaceLocations.add(normalizedRelative(root, dirname(path)));
          const text = content.toString('utf8');
          const manifestPath = normalizedRelative(root, path);
          const common = {
            direct: true,
            workspaceLocation: normalizedRelative(root, dirname(path)),
            manifestPath,
            manifestHash: digest(content),
          };
          if (name === 'package.json') {
            const parsed = parseNode(text, common);
            candidates.push(...parsed.packages);
            technologyCandidates.push(...parsed.technologies);
          } else if (/^requirements.*\.txt$/i.test(name)) {
            candidates.push(...parseRequirements(text, common));
          } else if (name === 'pyproject.toml') {
            candidates.push(...parsePyproject(text, common));
          } else if (name === 'pubspec.yaml') {
            candidates.push(...parseIndentedDependencies(text, 'dart', common));
          } else if (name === 'composer.json') {
            candidates.push(...parseComposer(text, common));
          } else if (name === 'Cargo.toml') {
            candidates.push(...parseCargo(text, common));
          } else if (name === 'go.mod') {
            candidates.push(...parseGoMod(text, common));
          }
        }

        for (const file of files) {
          const name = file.split(/[\\/]/).at(-1) ?? '';
          const manifestPath = normalizedRelative(root, file);
          if (name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml') {
            technologyCandidates.push({
              name: 'pnpm',
              category: 'package-manager',
              confidence: 'high',
              evidence: [{ kind: 'file-pattern', value: name, path: manifestPath }],
            });
          } else if (name === 'package-lock.json') {
            technologyCandidates.push({
              name: 'npm',
              category: 'package-manager',
              confidence: 'high',
              evidence: [{ kind: 'file-pattern', value: name, path: manifestPath }],
            });
          } else if (name === 'yarn.lock') {
            technologyCandidates.push({
              name: 'Yarn',
              category: 'package-manager',
              confidence: 'high',
              evidence: [{ kind: 'file-pattern', value: name, path: manifestPath }],
            });
          } else if (
            name === 'Dockerfile' ||
            name === 'compose.yaml' ||
            name === 'docker-compose.yml'
          ) {
            technologyCandidates.push({
              name: 'Docker',
              category: 'container',
              confidence: 'high',
              evidence: [{ kind: 'file-pattern', value: name, path: manifestPath }],
            });
          } else if (manifestPath.startsWith('.github/workflows/')) {
            technologyCandidates.push({
              name: 'GitHub Actions',
              category: 'ci',
              confidence: 'high',
              evidence: [{ kind: 'file-pattern', value: manifestPath, path: manifestPath }],
            });
          }
        }

        for (const [name, count] of languageCounts) {
          technologyCandidates.push({
            name,
            category: 'language',
            confidence: 'high',
            evidence: [{ kind: 'file-pattern', value: `${name} source files: ${count}` }],
          });
        }
        for (const candidate of candidates) {
          const known = technologyDependencies[candidate.packageName.toLowerCase()];
          if (known !== undefined) {
            technologyCandidates.push({
              ...known,
              confidence: 'high',
              evidence: [
                {
                  kind: 'package',
                  value: candidate.packageName,
                  path: candidate.manifestPath,
                },
              ],
            });
          }
        }

        const packages = candidates
          .map((candidate) =>
            packageRecordSchema.parse({
              id: packageId(input.projectId, candidate),
              projectId: input.projectId,
              ...candidate,
              detectedAt,
            }),
          )
          .toSorted((left, right) => left.id.localeCompare(right.id));

        const technologiesByIdentity = new Map<string, TechnologyCandidate>();
        for (const technology of technologyCandidates) {
          const identity = `${technology.category}\0${technology.name.toLowerCase()}`;
          const current = technologiesByIdentity.get(identity);
          if (current === undefined) technologiesByIdentity.set(identity, technology);
          else {
            current.evidence = [...current.evidence, ...technology.evidence].slice(0, 1000);
            if (technology.confidence === 'high') current.confidence = 'high';
          }
        }
        const technologies = [...technologiesByIdentity.values()]
          .map((technology) =>
            technologyRecordSchema.parse({
              id: technologyId(input.projectId, technology.name, technology.category),
              projectId: input.projectId,
              ...technology,
              detectedAt,
            }),
          )
          .toSorted((left, right) => left.id.localeCompare(right.id));

        return {
          packages,
          technologies,
          scannedAt: detectedAt,
          manifestCount,
          workspaceLocations: [...workspaceLocations].toSorted(),
          fileCount: files.length,
          truncated,
          evidenceScope,
        };
      } catch (error) {
        if (error instanceof PackageInventoryError) throw error;
        throw new PackageInventoryError('PACKAGE_SCAN_FAILED', 'Package inventory scan failed.');
      }
    },
  };
}
