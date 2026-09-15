import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GraphifyObserverError } from './graphify-observer.js';
import { readGraphifyKnowledge } from './graphify-knowledge.js';

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
