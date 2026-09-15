import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

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
