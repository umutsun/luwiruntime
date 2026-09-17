import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createGraphifyObserver,
  GRAPHIFY_OUTPUT_RELATIVE_PATH,
  GRAPHIFY_PROVENANCE,
  GraphifyObserverError,
  type GraphifyObservation,
} from './graphify-observer.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'luwi-graphify-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A graphify node: a symbol rooted in a file, in a community. */
function node(
  id: string,
  sourceFile: string,
  community = 0,
  communityName = `community-${String(community)}`,
): Record<string, unknown> {
  return {
    id,
    label: id,
    _origin: 'ast',
    community,
    community_name: communityName,
    file_type: 'code',
    source_file: sourceFile,
    source_location: 'L1',
  };
}

function link(
  source: string,
  target: string,
  relation: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source,
    target,
    relation,
    _origin: 'ast',
    confidence: 'EXTRACTED',
    source_location: 'L5',
    ...overrides,
  };
}

async function writeGraph(
  document: Record<string, unknown>,
  options: { mtime?: Date } = {},
): Promise<void> {
  const path = join(root, GRAPHIFY_OUTPUT_RELATIVE_PATH);
  await mkdir(join(root, 'graphify-out'), { recursive: true });
  await writeFile(path, JSON.stringify(document), 'utf8');
  if (options.mtime !== undefined) await utimes(path, options.mtime, options.mtime);
}

async function writeSource(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), '// source\n', 'utf8');
  }
}

async function observe(
  options: { maximumFileBytes?: number; maximumFiles?: number } = {},
): Promise<GraphifyObservation> {
  const result = await createGraphifyObserver(options).observe({ localPath: root });
  if (result === null) throw new Error('expected an observation');
  return result;
}

describe('graphify observer', () => {
  it('reports no layer at all when the project has no graphify output', async () => {
    await writeSource('src/a.ts');

    await expect(createGraphifyObserver().observe({ localPath: root })).resolves.toBeNull();
    await expect(
      createGraphifyObserver().observe({ localPath: join(root, 'missing') }),
    ).resolves.toBeNull();
  });

  it('reads graphify output from an overridden relative path, and only there', async () => {
    await writeSource('src/a.ts');
    await mkdir(join(root, 'kg'), { recursive: true });
    await writeFile(
      join(root, 'kg', 'graph.json'),
      JSON.stringify({ nodes: [node('a', 'src/a.ts')], links: [] }),
      'utf8',
    );

    const overridden = await createGraphifyObserver({
      outputRelativePath: 'kg/graph.json',
    }).observe({ localPath: root });
    expect(overridden?.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
    // The default location is not consulted once the override names another.
    await expect(createGraphifyObserver().observe({ localPath: root })).resolves.toBeNull();
  });

  it('joins nodes on source_file, because graphify writes no file node', async () => {
    await writeSource('src/a.ts', 'src/b.ts');
    await writeGraph({
      nodes: [
        node('a_one', 'src/a.ts', 3, 'core'),
        node('a_two', 'src/a.ts', 3, 'core'),
        node('b_one', 'src/b.ts', 3, 'core'),
        node('b_two', 'src/b.ts', 4, 'edge'),
      ],
      links: [],
    });

    const result = await observe();

    expect(result.files).toEqual([
      { relativePath: 'src/a.ts', symbolCount: 2, communityCount: 1, community: 'core' },
      // A file whose symbols sit in two communities is named by neither.
      { relativePath: 'src/b.ts', symbolCount: 2, communityCount: 2 },
    ]);
  });

  it('aggregates symbol imports into file-level pairs, strongest claim first', async () => {
    await writeSource('src/a.ts', 'src/b.ts', 'src/c.ts');
    await writeGraph({
      nodes: [node('a', 'src/a.ts'), node('b', 'src/b.ts'), node('c', 'src/c.ts')],
      links: [
        link('a', 'b', 'imports_from', { confidence: 'INFERRED', source_location: 'L9' }),
        link('a', 'b', 'imports_from', { source_location: 'L2' }),
        link('b', 'c', 're_exports', { confidence: 'INFERRED', source_location: 'L1' }),
        link('c', 'a', 'dynamic_import', { source_location: 'not-a-line' }),
        // A symbol importing another symbol of its own file is not a file import.
        link('a', 'a', 'imports'),
      ],
    });

    const result = await observe();

    expect(result.imports).toEqual([
      { fromPath: 'src/a.ts', toPath: 'src/b.ts', confidence: 'medium', line: 2 },
      { fromPath: 'src/b.ts', toPath: 'src/c.ts', confidence: 'low', line: 1 },
      // `source_location` that is not `L<n>` yields no line rather than a wrong one.
      { fromPath: 'src/c.ts', toPath: 'src/a.ts', confidence: 'medium' },
    ]);
  });

  it('never carries an import as high: graphify resolved it by name and this reader did not verify it', async () => {
    await writeSource('src/a.ts', 'src/b.ts');
    await writeGraph({
      nodes: [node('a', 'src/a.ts'), node('b', 'src/b.ts')],
      links: [
        link('a', 'b', 'imports_from'),
        link('b', 'a', 'imports', { confidence: 'AMBIGUOUS' }),
      ],
    });

    const result = await observe();

    expect(result.imports.map(({ confidence }) => confidence)).toEqual(['medium']);
    expect(result.skippedLinkCount).toBe(1);
  });

  it('keeps only paths that name a real file inside the project, and counts the rest', async () => {
    await writeSource('src/a.ts');
    await mkdir(join(root, 'src', 'dir'), { recursive: true });
    await writeGraph({
      nodes: [
        node('a', 'src/a.ts'),
        node('builtin', 'node:net'),
        node('gone', 'src/deleted.ts'),
        node('absolute', join(root, 'src/a.ts')),
        node('escape', '../outside.ts'),
        node('directory', 'src/dir'),
      ],
      links: [
        link('a', 'builtin', 'dynamic_import'),
        link('a', 'gone', 'imports_from'),
        link('a', 'unknown-id', 'imports_from'),
      ],
    });

    const result = await observe();

    expect(result.files.map(({ relativePath }) => relativePath)).toEqual(['src/a.ts']);
    expect(result.skippedNodeCount).toBe(5);
    expect(result.externalImportCount).toBe(2);
    expect(result.skippedLinkCount).toBe(1);
    expect(result.imports).toEqual([]);
  });

  it('counts calls, containment and inheritance without bending them into imports', async () => {
    await writeSource('src/a.ts', 'src/b.ts');
    await writeGraph({
      nodes: [node('a', 'src/a.ts'), node('b', 'src/b.ts')],
      links: [link('a', 'b', 'calls'), link('a', 'b', 'contains'), link('b', 'a', 'extends')],
    });

    const result = await observe();

    expect(result.imports).toEqual([]);
    expect(result.otherRelationCount).toBe(3);
  });

  it('skips a malformed entry and counts it rather than repairing it', async () => {
    await writeSource('src/a.ts');
    await writeGraph({
      nodes: [node('a', 'src/a.ts'), { id: 'no-file' }, 'not an object', null],
      links: [{ source: 'a' }, 42],
    });

    const result = await observe();

    expect(result.files).toHaveLength(1);
    expect(result.skippedNodeCount).toBe(3);
    expect(result.skippedLinkCount).toBe(2);
  });

  it('refuses a document that is not a graph, and one over the size bound', async () => {
    await writeGraph({ nodes: 'nope' });
    await expect(createGraphifyObserver().observe({ localPath: root })).rejects.toMatchObject({
      code: 'GRAPHIFY_OUTPUT_INVALID',
    });

    await writeGraph({ nodes: [], links: [] });
    const oversize = createGraphifyObserver({ maximumFileBytes: 8 }).observe({ localPath: root });
    await expect(oversize).rejects.toBeInstanceOf(GraphifyObserverError);
    await expect(oversize).rejects.toMatchObject({ code: 'GRAPHIFY_OUTPUT_TOO_LARGE' });
  });

  it('carries the build commit only when it is a sha, and dates the layer by the file', async () => {
    const mtime = new Date('2026-09-02T10:00:00.000Z');
    await writeSource('src/a.ts');
    await writeGraph(
      { nodes: [node('a', 'src/a.ts')], links: [], built_at_commit: 'b'.repeat(40) },
      { mtime },
    );
    const dated = await observe();
    expect(dated.builtAtCommit).toBe('b'.repeat(40));
    expect(dated.observedAt).toBe(mtime.toISOString());

    // A project that is not a git repository builds with no commit to name.
    await writeGraph({ nodes: [node('a', 'src/a.ts')], links: [], built_at_commit: 'unknown' });
    expect(await observe()).not.toHaveProperty('builtAtCommit');
  });

  it('stops at the file bound and says so', async () => {
    await writeSource('src/a.ts', 'src/b.ts', 'src/c.ts');
    await writeGraph({
      nodes: [node('a', 'src/a.ts'), node('b', 'src/b.ts'), node('c', 'src/c.ts')],
      links: [link('a', 'c', 'imports_from')],
    });

    const result = await observe({ maximumFiles: 2 });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(2);
    // The dropped file can be no endpoint: its node is not a project file here.
    expect(result.imports).toEqual([]);
  });

  it('carries paths, counts and a sha only — never a symbol name', async () => {
    await writeSource('src/a.ts');
    await writeGraph({
      nodes: [node('secretSymbolName', 'src/a.ts', 1, 'community-name')],
      links: [],
    });

    const result = await observe();

    expect(JSON.stringify(result)).not.toContain('secretSymbolName');
    expect(GRAPHIFY_PROVENANCE).toMatch(/^graphify-graph-json@\d+$/);
  });
});
