import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GraphifyObserverError } from './graphify-observer.js';
import { readGraphifyKnowledge, projectKnowledgeGraph } from './graphify-knowledge.js';
import type { KnowledgeDocument } from './graphify-knowledge.js';

async function projectWith(graphJson: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'luwi-knowledge-'));
  if (graphJson !== undefined) {
    await mkdir(join(root, 'graphify-out'), { recursive: true });
    await writeFile(join(root, 'graphify-out', 'graph.json'), graphJson);
  }
  return root;
}

describe('readGraphifyKnowledge', () => {
  it('returns null when the project has no graphify output', async () => {
    const root = await projectWith(undefined);
    try {
      expect(await readGraphifyKnowledge({ localPath: root })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads nodes, links and provenance from graph.json', async () => {
    const root = await projectWith(
      JSON.stringify({
        built_at_commit: 'abc123',
        nodes: [
          { id: 'a::build', source_file: 'src/a.ts', community: 0, community_name: 'a' },
          { id: 'b::run', source_file: 'src/b.ts', community: 1 },
        ],
        links: [{ source: 'a::build', target: 'b::run', relation: 'imports' }],
      }),
    );
    try {
      const doc = await readGraphifyKnowledge({ localPath: root });
      expect(doc?.nodes).toHaveLength(2);
      expect(doc?.nodes[0]).toMatchObject({
        id: 'a::build',
        sourceFile: 'src/a.ts',
        community: 0,
        communityName: 'a',
      });
      expect(doc?.links[0]).toEqual({ source: 'a::build', target: 'b::run', relation: 'imports' });
      expect(doc?.builtAtCommit).toBe('abc123');
      expect(typeof doc?.observedAt).toBe('string');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws GRAPHIFY_OUTPUT_TOO_LARGE past the cap', async () => {
    const root = await projectWith(JSON.stringify({ nodes: [], links: [] }));
    try {
      await expect(
        readGraphifyKnowledge({ localPath: root, maximumFileBytes: 4 }),
      ).rejects.toBeInstanceOf(GraphifyObserverError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('projectKnowledgeGraph', () => {
  it('projects the empty response for a project with no output', () => {
    const out = projectKnowledgeGraph(null);
    expect(out.summary).toMatchObject({
      nodeCount: 0,
      edgeCount: 0,
      embeddings: 0,
      truncated: false,
    });
    expect(out.summary.observedAt).toBeUndefined();
    expect(out.nodes).toEqual([]);
  });

  it('derives kind by degree, bounds the backbone, and keeps only in-set edges', () => {
    // core::god has the highest total degree (4) overall; a::hub is next (3) and
    // is the highest-degree member of community 1; b::hub is the lone member of
    // community 2. See task-3-report.md for the degree table.
    const nodes: KnowledgeDocument['nodes'] = [
      { id: 'core::god', sourceFile: 'src/core.ts', community: 0, communityName: 'core' },
      { id: 'a::hub', sourceFile: 'src/a.ts', community: 1, communityName: 'a' },
      { id: 'a::l1', sourceFile: 'src/a1.ts', community: 1 },
      { id: 'a::l2', sourceFile: 'src/a2.ts', community: 1 },
      { id: 'a::l3', sourceFile: 'src/a3.ts', community: 1 },
      { id: 'b::hub', sourceFile: 'src/b.ts', community: 2, communityName: 'b' },
    ];
    const links: KnowledgeDocument['links'] = [
      { source: 'a::l1', target: 'core::god', relation: 'imports' },
      { source: 'a::l2', target: 'a::hub', relation: 'imports' },
      { source: 'a::l3', target: 'a::hub', relation: 'imports' },
      { source: 'a::hub', target: 'core::god', relation: 'imports' },
      { source: 'b::hub', target: 'core::god', relation: 'calls' },
      { source: 'core::god', target: 'a::l1', relation: 'imports' },
    ];
    const out = projectKnowledgeGraph(
      { nodes, links, builtAtCommit: 'c1', observedAt: '2026-09-15T00:00:00.000Z' },
      { godNodeCount: 1, maxRenderNodes: 4, maxCommunities: 12 },
    );
    expect(out.summary.nodeCount).toBe(6);
    expect(out.summary.edgeCount).toBe(6);
    expect(out.summary.communityCount).toBe(3);
    expect(out.summary.builtAtCommit).toBe('c1');
    // The highest-degree node overall is the god; per-community highest are hubs.
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('core::god')?.kind).toBe('god');
    expect(byId.get('a::hub')?.kind).toBe('hub');
    // maxRenderNodes=4 keeps god + 3 hubs/backbone; a leaf is dropped → truncated.
    expect(out.nodes.length).toBeLessThanOrEqual(4);
    expect(out.summary.truncated).toBe(true);
    // Every returned edge has both endpoints in the returned node set.
    const ids = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    }
    // relation classification
    expect(out.edges.every((e) => e.kind === 'import' || e.kind === 'call')).toBe(true);
    // label is the id's terminal segment
    expect(byId.get('a::hub')?.label).toBe('hub');
  });
});
