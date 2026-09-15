import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { normalizeLeasePath } from '@luwi/protocol';
import { z } from 'zod';

/**
 * The graphify output observer from ADR 0029.
 *
 * Graphify (Graphify-Labs/graphify) is a Python tool the developer runs
 * themselves; it writes `graphify-out/graph.json` into a project. This module
 * reads that one file and nothing else. It never runs graphify, never speaks to
 * its MCP server or its model backends, and never follows a path out of the
 * project — reading a tool's output is where sections 12 and 18 draw the line,
 * and ADR 0012's rejection of graphify as a dependency or an executed scanner
 * stands unchanged.
 *
 * The file is untrusted input with no versioned contract, so only the fields
 * this reader needs are read, every entry is validated on its own, and an entry
 * that fails is skipped and counted rather than repaired. The observation
 * carries paths, counts, and a commit sha — never a symbol name, never text.
 */

/** Where graphify writes by default. There is no override; add one when a project needs it. */
export const GRAPHIFY_OUTPUT_RELATIVE_PATH = 'graphify-out/graph.json';
/** Identifies this reader on every record it produces; moves when what is read changes. */
export const GRAPHIFY_PROVENANCE = 'graphify-graph-json@1';

// ponytail: the document is parsed whole (5–15 MB measured across ten projects);
// stream it if a repository ever outgrows 64 MiB.
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20_000;
/** An evidence id holds at most this many characters, so a longer path would be refused at projection. */
const MAX_PATH_LENGTH = 256;
const MAX_COMMUNITY_NAME_LENGTH = 256;
const COMMIT_SHA = /^[a-fA-F0-9]{40,64}$/;
const SOURCE_LINE = /^L(\d{1,9})$/;

/** The graphify relations that assert one file depends on another by importing it. */
const IMPORT_RELATIONS = new Set(['imports', 'imports_from', 're_exports', 'dynamic_import']);

/**
 * Measured 2026-09-02 against graphify 0.9.53: a node is a symbol, a heading, or
 * a page, and every one names the file it came from. There is no file node —
 * the file is `source_file`, which is why this reader joins on it.
 */
const nodeSchema = z.looseObject({
  id: z.string().min(1).max(1024),
  source_file: z.string().min(1).max(4096),
  community: z.number().int().optional(),
  community_name: z.string().max(4096).optional(),
});
const linkSchema = z.looseObject({
  source: z.string().min(1).max(1024),
  target: z.string().min(1).max(1024),
  relation: z.string().min(1).max(64),
  confidence: z.string().max(64).optional(),
  source_location: z.string().max(64).optional(),
});
const documentSchema = z.looseObject({
  nodes: z.array(z.unknown()),
  links: z.array(z.unknown()),
  built_at_commit: z.unknown().optional(),
});

export class GraphifyObserverError extends Error {
  constructor(
    readonly code: 'GRAPHIFY_OUTPUT_TOO_LARGE' | 'GRAPHIFY_OUTPUT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'GraphifyObserverError';
  }
}

export type GraphifyFile = {
  relativePath: string;
  /** Graphify nodes rooted in the file: symbols in code, headings and the page in a document. */
  symbolCount: number;
  /** Distinct graphify communities those nodes fall into. */
  communityCount: number;
  /** The community's name, present only when every node in the file is in one community. */
  community?: string;
};

export type GraphifyImport = {
  fromPath: string;
  toPath: string;
  confidence: 'medium' | 'low';
  line?: number;
};

export type GraphifyObservation = {
  files: GraphifyFile[];
  imports: GraphifyImport[];
  builtAtCommit?: string;
  /** When graphify wrote the file, which is when the structure it describes was observed. */
  observedAt: string;
  truncated: boolean;
  skippedNodeCount: number;
  skippedLinkCount: number;
  externalImportCount: number;
  otherRelationCount: number;
};

export interface GraphifyObserver {
  /** `null` when the project has no graphify output; a document that cannot be read throws. */
  observe(input: { localPath: string }): Promise<GraphifyObservation | null>;
}

export type GraphifyObserverOptions = {
  maximumFileBytes?: number;
  maximumFiles?: number;
};

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

/**
 * Graphify labels an edge EXTRACTED when tree-sitter saw it and INFERRED when
 * it guessed. Neither is a statically resolved import in ADR 0012's sense —
 * graphify resolves the target by name and this reader did not verify it — so
 * the strongest claim carried is `medium`. Anything else is not an edge.
 */
function importConfidence(value: string | undefined): 'medium' | 'low' | null {
  if (value === 'EXTRACTED') return 'medium';
  if (value === 'INFERRED') return 'low';
  return null;
}

function lineOf(location: string | undefined): number | undefined {
  const match = location === undefined ? null : SOURCE_LINE.exec(location);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

type FileEntry = { symbolCount: number; communities: Set<number>; communityName?: string };

export function createGraphifyObserver(options: GraphifyObserverOptions = {}): GraphifyObserver {
  const maximumFileBytes = options.maximumFileBytes ?? MAX_OUTPUT_BYTES;
  const maximumFiles = options.maximumFiles ?? MAX_FILES;

  return {
    async observe(input) {
      let root: string;
      try {
        root = await realpath(resolve(input.localPath));
      } catch {
        return null;
      }
      const outputPath = resolve(root, GRAPHIFY_OUTPUT_RELATIVE_PATH);
      let output;
      try {
        output = await stat(outputPath);
      } catch {
        return null;
      }
      if (!output.isFile()) return null;
      if (Number(output.size) > maximumFileBytes) {
        throw new GraphifyObserverError(
          'GRAPHIFY_OUTPUT_TOO_LARGE',
          'The graphify output exceeds the bounded document size.',
        );
      }
      let document: z.infer<typeof documentSchema>;
      try {
        document = documentSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
      } catch {
        throw new GraphifyObserverError(
          'GRAPHIFY_OUTPUT_INVALID',
          'The graphify output could not be read as a graph document.',
        );
      }

      /**
       * A path counts only when it is project-relative, cannot escape, and names
       * a regular file that exists now. That one check drops graphify's external
       * endpoints (`node:net`, an npm package name), a path deleted since the
       * graph was built, and anything hostile, without a second rule for each.
       * The colon is refused outright: on NTFS it would address an alternate
       * data stream of a sibling file rather than fail.
       */
      const pathCache = new Map<string, string | null>();
      const projectFile = async (value: string): Promise<string | null> => {
        const cached = pathCache.get(value);
        if (cached !== undefined) return cached;
        let accepted: string | null = null;
        try {
          const normalized = normalizeLeasePath(value).path;
          if (
            normalized !== '.' &&
            normalized.length <= MAX_PATH_LENGTH &&
            !normalized.includes(':')
          ) {
            const absolute = resolve(root, normalized);
            if (isWithin(root, absolute) && (await stat(absolute)).isFile()) accepted = normalized;
          }
        } catch {
          accepted = null;
        }
        pathCache.set(value, accepted);
        return accepted;
      };

      const files = new Map<string, FileEntry>();
      /** Node id → its file, or `null` for a node that is not a project file. */
      const nodeFiles = new Map<string, string | null>();
      let truncated = false;
      let skippedNodeCount = 0;
      for (const raw of document.nodes) {
        const parsed = nodeSchema.safeParse(raw);
        if (!parsed.success) {
          skippedNodeCount += 1;
          continue;
        }
        const node = parsed.data;
        const relativePath = await projectFile(node.source_file);
        if (relativePath === null) {
          nodeFiles.set(node.id, null);
          skippedNodeCount += 1;
          continue;
        }
        let entry = files.get(relativePath);
        if (entry === undefined) {
          if (files.size >= maximumFiles) {
            // One past the bound proves truncation; the rest is not walked.
            truncated = true;
            skippedNodeCount += 1;
            continue;
          }
          entry = { symbolCount: 0, communities: new Set() };
          files.set(relativePath, entry);
        }
        entry.symbolCount += 1;
        if (node.community !== undefined) {
          entry.communities.add(node.community);
          if (
            entry.communityName === undefined &&
            node.community_name !== undefined &&
            node.community_name.length > 0 &&
            node.community_name.length <= MAX_COMMUNITY_NAME_LENGTH
          ) {
            entry.communityName = node.community_name;
          }
        }
        nodeFiles.set(node.id, relativePath);
      }

      const imports = new Map<string, GraphifyImport>();
      let skippedLinkCount = 0;
      let externalImportCount = 0;
      let otherRelationCount = 0;
      for (const raw of document.links) {
        const parsed = linkSchema.safeParse(raw);
        if (!parsed.success) {
          skippedLinkCount += 1;
          continue;
        }
        const link = parsed.data;
        if (!IMPORT_RELATIONS.has(link.relation)) {
          // A call, a containment, an inheritance: real structure, but not an
          // import, and the file-level edge kind says imports. Counted, not bent.
          otherRelationCount += 1;
          continue;
        }
        const fromPath = nodeFiles.get(link.source);
        const toPath = nodeFiles.get(link.target);
        if (fromPath === undefined || toPath === undefined) {
          skippedLinkCount += 1;
          continue;
        }
        if (fromPath === null || toPath === null) {
          // A dependency on something that is not a file in this project is a
          // different question, not a weaker answer to this one.
          externalImportCount += 1;
          continue;
        }
        if (fromPath === toPath) continue;
        const confidence = importConfidence(link.confidence);
        if (confidence === null) {
          skippedLinkCount += 1;
          continue;
        }
        const key = `${fromPath}\0${toPath}`;
        const current = imports.get(key);
        // A file-level import is as strong as its strongest proven symbol edge.
        if (current === undefined || (current.confidence === 'low' && confidence === 'medium')) {
          const line = lineOf(link.source_location);
          imports.set(key, {
            fromPath,
            toPath,
            confidence,
            ...(line === undefined ? {} : { line }),
          });
        }
      }

      const builtAtCommit =
        typeof document.built_at_commit === 'string' && COMMIT_SHA.test(document.built_at_commit)
          ? document.built_at_commit
          : undefined;

      return {
        files: [...files.entries()]
          .map(([relativePath, entry]) => ({
            relativePath,
            symbolCount: entry.symbolCount,
            communityCount: entry.communities.size,
            ...(entry.communities.size === 1 && entry.communityName !== undefined
              ? { community: entry.communityName }
              : {}),
          }))
          .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath)),
        imports: [...imports.values()].toSorted(
          (left, right) =>
            left.fromPath.localeCompare(right.fromPath) || left.toPath.localeCompare(right.toPath),
        ),
        ...(builtAtCommit === undefined ? {} : { builtAtCommit }),
        observedAt: new Date(output.mtimeMs).toISOString(),
        truncated,
        skippedNodeCount,
        skippedLinkCount,
        externalImportCount,
        otherRelationCount,
      };
    },
  };
}
