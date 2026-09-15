import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import type { KnowledgeGraphResponse } from '@luwi/protocol';

import {
  GRAPHIFY_OUTPUT_RELATIVE_PATH,
  GraphifyObserverError,
  MAX_OUTPUT_BYTES,
} from './graphify-observer.js';

/**
 * Reads graphify's own knowledge structure (symbols, communities, typed edges)
 * from `graphify-out/graph.json`, bounded the same way the ADR 0029 observer
 * reads it. Unlike the observer it does not collapse symbols into files — the
 * per-project knowledge view needs the raw structure. It never runs graphify and
 * never follows anything inside the file (§12, §18).
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
});
const documentSchema = z.looseObject({
  nodes: z.array(z.unknown()),
  links: z.array(z.unknown()),
  built_at_commit: z.unknown().optional(),
});

export type KnowledgeDocument = {
  nodes: { id: string; sourceFile: string; community?: number; communityName?: string }[];
  links: { source: string; target: string; relation: string }[];
  builtAtCommit?: string;
  observedAt: string;
};

export async function readGraphifyKnowledge(input: {
  localPath: string;
  maximumFileBytes?: number;
}): Promise<KnowledgeDocument | null> {
  const maximumFileBytes = input.maximumFileBytes ?? MAX_OUTPUT_BYTES;
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

  const nodes: KnowledgeDocument['nodes'] = [];
  for (const raw of document.nodes) {
    const parsed = nodeSchema.safeParse(raw);
    if (!parsed.success) continue; // skip a malformed node rather than fail the whole read
    nodes.push({
      id: parsed.data.id,
      sourceFile: parsed.data.source_file,
      ...(parsed.data.community === undefined ? {} : { community: parsed.data.community }),
      ...(parsed.data.community_name === undefined
        ? {}
        : { communityName: parsed.data.community_name }),
    });
  }
  const links: KnowledgeDocument['links'] = [];
  for (const raw of document.links) {
    const parsed = linkSchema.safeParse(raw);
    if (!parsed.success) continue;
    links.push({
      source: parsed.data.source,
      target: parsed.data.target,
      relation: parsed.data.relation,
    });
  }
  return {
    nodes,
    links,
    ...(typeof document.built_at_commit === 'string'
      ? { builtAtCommit: document.built_at_commit }
      : {}),
    observedAt: output.mtime.toISOString(),
  };
}

/** Relations graphify treats as an import edge; everything else is a call. Mirrors ADR 0029. */
const IMPORT_RELATIONS = new Set(['imports', 'imports_from', 're_exports', 'dynamic_import']);
const DEFAULT_GOD_NODE_COUNT = 6;
const DEFAULT_MAX_RENDER_NODES = 40;
const DEFAULT_MAX_COMMUNITIES = 12;

/**
 * The id's terminal segment: graphify ids are path-like (`a/b::symbol`).
 * Capped to the protocol's `label` limit (256) since an id can be up to 1024;
 * falls back to the (also-capped) id if the computed label is somehow empty.
 */
function labelOf(id: string): string {
  const tail = id.split(/[/:]/u).filter((part) => part !== '');
  return (tail[tail.length - 1] ?? id).slice(0, 256);
}

const EMPTY: KnowledgeGraphResponse = {
  summary: {
    nodeCount: 0,
    edgeCount: 0,
    communityCount: 0,
    hubCount: 0,
    embeddings: 0,
    truncated: false,
  },
  communities: [],
  nodes: [],
  edges: [],
};

export function projectKnowledgeGraph(
  document: KnowledgeDocument | null,
  options: { godNodeCount?: number; maxRenderNodes?: number; maxCommunities?: number } = {},
): KnowledgeGraphResponse {
  if (document === null) return EMPTY;
  const godNodeCount = options.godNodeCount ?? DEFAULT_GOD_NODE_COUNT;
  const maxRenderNodes = options.maxRenderNodes ?? DEFAULT_MAX_RENDER_NODES;
  const maxCommunities = options.maxCommunities ?? DEFAULT_MAX_COMMUNITIES;

  const byId = new Map(document.nodes.map((node) => [node.id, node]));

  // Undirected degree from links whose endpoints are both known nodes.
  const degree = new Map<string, number>();
  for (const node of document.nodes) degree.set(node.id, 0);
  for (const link of document.links) {
    if (byId.has(link.source)) degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    if (byId.has(link.target)) degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  const sortedByDegree = [...document.nodes].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );

  // God = the top-degree nodes overall.
  const godIds = new Set(sortedByDegree.slice(0, godNodeCount).map((node) => node.id));
  // Hub = the highest-degree node in each community not already a god.
  const hubIds = new Set<string>();
  const seenCommunity = new Set<number>();
  for (const node of sortedByDegree) {
    if (godIds.has(node.id) || node.community === undefined) continue;
    if (seenCommunity.has(node.community)) continue;
    seenCommunity.add(node.community);
    hubIds.add(node.id);
  }

  const kindOf = (id: string): 'god' | 'hub' | 'symbol' =>
    godIds.has(id) ? 'god' : hubIds.has(id) ? 'hub' : 'symbol';

  // Backbone: all god + hub, then the next-highest-degree symbols up to the cap.
  const kept: typeof document.nodes = [];
  const keptIds = new Set<string>();
  const add = (node: (typeof document.nodes)[number]) => {
    if (keptIds.has(node.id) || kept.length >= maxRenderNodes) return;
    kept.push(node);
    keptIds.add(node.id);
  };
  for (const node of sortedByDegree) if (kindOf(node.id) !== 'symbol') add(node);
  for (const node of sortedByDegree) add(node);

  const nodes = kept.map((node) => ({
    id: node.id,
    label: labelOf(node.id),
    sourceFile: node.sourceFile,
    ...(node.community === undefined ? {} : { community: node.community }),
    ...(node.communityName === undefined ? {} : { communityName: node.communityName }),
    kind: kindOf(node.id),
    degree: degree.get(node.id) ?? 0,
  }));

  const edges = document.links
    .filter((link) => keptIds.has(link.source) && keptIds.has(link.target))
    .map((link) => ({
      source: link.source,
      target: link.target,
      kind: IMPORT_RELATIONS.has(link.relation) ? ('import' as const) : ('call' as const),
    }));

  // Communities over the whole document, largest first, bounded.
  const communityAgg = new Map<number, { id: number; name: string; size: number }>();
  for (const node of document.nodes) {
    if (node.community === undefined) continue;
    // An empty/whitespace communityName is treated as absent — the protocol
    // requires a non-empty community name, but the reader's schema allows "".
    const named =
      node.communityName !== undefined && node.communityName.trim() !== ''
        ? node.communityName
        : undefined;
    const existing = communityAgg.get(node.community) ?? {
      id: node.community,
      name: named ?? `community ${String(node.community)}`,
      size: 0,
    };
    existing.size += 1;
    if (named !== undefined) existing.name = named;
    communityAgg.set(node.community, existing);
  }
  const communities = [...communityAgg.values()]
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .slice(0, maxCommunities);

  return {
    summary: {
      nodeCount: document.nodes.length,
      edgeCount: document.links.length,
      communityCount: communityAgg.size,
      hubCount: godIds.size + hubIds.size,
      embeddings: 0,
      ...(document.builtAtCommit === undefined ? {} : { builtAtCommit: document.builtAtCommit }),
      observedAt: document.observedAt,
      truncated: kept.length < document.nodes.length,
    },
    communities,
    nodes,
    edges,
  };
}
