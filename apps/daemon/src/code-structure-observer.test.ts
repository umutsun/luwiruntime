import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CodeStructureError,
  createCodeStructureObserver,
  moduleDependencyPairs,
  type StructuralImport,
} from './code-structure-observer.js';

const timestamp = '2026-08-08T00:00:00.000Z';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'luwi-code-structure-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function observer(options: { maximumFiles?: number; maximumFileBytes?: number } = {}) {
  return createCodeStructureObserver({ now: () => new Date(timestamp), ...options });
}

function importOf(imports: StructuralImport[], specifier: string): StructuralImport {
  const found = imports.find((value) => value.specifier === specifier);
  if (found === undefined) throw new Error(`no import for ${specifier}`);
  return found;
}

describe('code structure observer', () => {
  it('resolves a relative import to exactly one file with high confidence', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'target.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(
      join(root, 'src', 'entry.ts'),
      "import { value } from './target.js';\n",
      'utf8',
    );

    const result = await observer().scan({ localPath: root });

    const edge = importOf(result.imports, './target.js');
    expect(edge.fromPath).toBe('src/entry.ts');
    expect(edge.toPath).toBe('src/target.ts');
    expect(edge.confidence).toBe('high');
    expect(edge.line).toBe(1);
  });

  it('records an unresolvable import as unknown with no target', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'entry.ts'), "import './missing.js';\n", 'utf8');

    const result = await observer().scan({ localPath: root });

    const edge = importOf(result.imports, './missing.js');
    expect(edge.confidence).toBe('unknown');
    expect(edge.toPath).toBeUndefined();
  });

  it('records a dynamic import with a non-literal specifier as unknown, never a guess', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'other.ts'), 'export const x = 1;\n', 'utf8');
    await writeFile(
      join(root, 'src', 'entry.ts'),
      'const name = "other";\nexport const load = () => import(`./${name}.js`);\n',
      'utf8',
    );

    const result = await observer().scan({ localPath: root });

    const dynamic = result.imports.filter((value) => value.dynamic);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]!.confidence).toBe('unknown');
    expect(dynamic[0]!.toPath).toBeUndefined();
    // The only plausible target on disk must not be adopted as the answer.
    expect(dynamic[0]!.specifier).not.toBe('./other.js');
  });

  it('leaves an external package import out of the file graph entirely', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'entry.ts'), "import fastify from 'fastify';\n", 'utf8');

    const result = await observer().scan({ localPath: root });

    // Not a file in this project, so not a file-to-file edge and not an
    // unknown either — it is simply a different question.
    expect(result.imports).toHaveLength(0);
    expect(result.externalImportCount).toBe(1);
  });

  it('extracts exported symbol names without retaining source text', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'api.ts'),
      'const secret = "do-not-retain";\nexport function publicOne() {\n  return secret;\n}\nexport const publicTwo = 2;\n',
      'utf8',
    );

    const result = await observer().scan({ localPath: root });

    expect(result.exports.map((value) => value.symbol).toSorted()).toEqual([
      'publicOne',
      'publicTwo',
    ]);
    expect(JSON.stringify(result)).not.toContain('do-not-retain');
  });

  it('discloses truncation instead of silently scanning fewer files', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(root, 'src', `file-${index}.ts`), 'export const x = 1;\n', 'utf8');
    }

    const result = await observer({ maximumFiles: 3 }).scan({ localPath: root });

    expect(result.truncated).toBe(true);
    expect(result.files.length).toBe(3);
  });

  it('skips a file over the byte bound and counts it rather than parsing it', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'small.ts'), 'export const x = 1;\n', 'utf8');
    await writeFile(
      join(root, 'src', 'huge.ts'),
      `export const y = "${'a'.repeat(4000)}";\n`,
      'utf8',
    );

    const result = await observer({ maximumFileBytes: 1024 }).scan({ localPath: root });

    expect(result.files).toContain('src/small.ts');
    expect(result.files).not.toContain('src/huge.ts');
    expect(result.skippedFileCount).toBe(1);
  });

  it('rejects a tracked path that escapes the project root', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'entry.ts'), 'export const x = 1;\n', 'utf8');

    await expect(
      observer().scan({ localPath: root, trackedPaths: ['../outside.ts'] }),
    ).rejects.toBeInstanceOf(CodeStructureError);
  });

  it('discloses whether the file set came from Git or the filesystem', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'entry.ts'), 'export const x = 1;\n', 'utf8');

    await expect(observer().scan({ localPath: root })).resolves.toMatchObject({
      evidenceScope: 'filesystem',
    });
    await expect(
      observer().scan({ localPath: root, trackedPaths: ['src/entry.ts'] }),
    ).resolves.toMatchObject({ evidenceScope: 'git-tracked' });
  });

  it('aggregates module dependencies at the strongest proven confidence', () => {
    const moduleOf = (path: string): string | null =>
      path.startsWith('packages/a/') ? 'mod-a' : path.startsWith('packages/b/') ? 'mod-b' : null;

    const pairs = moduleDependencyPairs(
      [
        {
          fromPath: 'packages/a/one.ts',
          toPath: 'packages/b/one.ts',
          specifier: '@luwi/b',
          confidence: 'medium',
          dynamic: false,
          line: 1,
        },
        {
          fromPath: 'packages/a/two.ts',
          toPath: 'packages/b/two.ts',
          specifier: '../b/two.js',
          confidence: 'high',
          dynamic: false,
          line: 1,
        },
      ],
      moduleOf,
    );

    // One proven import proves the module dependency; the weaker sibling does
    // not drag it down and does not add a second edge.
    expect(pairs).toEqual([{ from: 'mod-a', to: 'mod-b', confidence: 'high' }]);
  });

  it('never lets an unresolved import create a module dependency', () => {
    const moduleOf = (path: string): string => (path.startsWith('packages/a/') ? 'mod-a' : 'mod-b');

    // No target at all.
    expect(
      moduleDependencyPairs(
        [
          {
            fromPath: 'packages/a/one.ts',
            specifier: './missing.js',
            confidence: 'unknown',
            dynamic: false,
            line: 1,
          },
        ],
        moduleOf,
      ),
    ).toEqual([]);

    // A target the caller guessed at while still admitting it does not know.
    // The observer never emits this shape, but the guard is the contract, and
    // without this case the test would pass with the guard deleted.
    expect(
      moduleDependencyPairs(
        [
          {
            fromPath: 'packages/a/one.ts',
            toPath: 'packages/b/one.ts',
            specifier: './missing.js',
            confidence: 'unknown',
            dynamic: false,
            line: 1,
          },
        ],
        moduleOf,
      ),
    ).toEqual([]);
  });

  it('ignores an import that stays inside one module', () => {
    const pairs = moduleDependencyPairs(
      [
        {
          fromPath: 'packages/a/one.ts',
          toPath: 'packages/a/two.ts',
          specifier: './two.js',
          confidence: 'high',
          dynamic: false,
          line: 1,
        },
      ],
      () => 'mod-a',
    );

    expect(pairs).toEqual([]);
  });

  it('never executes the code it parses', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    const marker = join(root, 'executed.txt');
    await writeFile(
      join(root, 'src', 'entry.ts'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\n`,
      'utf8',
    );

    await observer().scan({ localPath: root });

    await expect(rm(marker)).rejects.toThrow();
  });
});
