import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCanonicalStore } from './canonical-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('canonical LUWI manifest store', () => {
  it('reads the validated tracked projects used for startup restoration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luwi-canonical-projects-'));
    roots.push(root);
    const store = createCanonicalStore({ globalRoot: root });
    const project = {
      id: 'project-restore',
      name: 'Restore',
      localPath: 'C:/workspace/restore',
      canonicalPath: 'C:/workspace/restore',
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };

    await store.trackProject(project);

    await expect(store.loadTrackedProjects()).resolves.toEqual([project]);
  });

  it('untracks a project idempotently and leaves the others readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luwi-canonical-untrack-'));
    roots.push(root);
    const store = createCanonicalStore({ globalRoot: root });
    const project = (id: string) => ({
      id,
      name: id,
      localPath: `C:/workspace/${id}`,
      canonicalPath: `C:/workspace/${id}`,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    });
    await store.trackProject(project('keep'));
    await store.trackProject(project('gone'));

    await store.untrackProject('gone');
    await store.untrackProject('gone');
    await store.untrackProject('never-tracked');

    // The manifest is rewritten with its content hash, so it still validates.
    await expect(store.loadTrackedProjects()).resolves.toEqual([project('keep')]);
  });

  it('writes stable, hashed, human-readable global agent manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luwi-canonical-'));
    roots.push(root);
    const store = createCanonicalStore({
      globalRoot: root,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    });

    const first = await store.writeAgent({
      id: 'codex-main',
      kind: 'codex',
      displayName: 'Codex',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['/fake/.codex'],
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
      metadata: { beta: 2, alpha: 1 },
    });
    const second = await store.writeAgent({
      ...first.data,
      metadata: { alpha: 1, beta: 2 },
    });

    expect(second.contentHash).toBe(first.contentHash);
    expect(second).toMatchObject({
      schemaVersion: 1,
      id: 'codex-main',
      scope: 'global',
    });
    const text = await readFile(join(root, 'agents', 'codex-main.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(second);
  });

  it('stores project bindings only under the supplied project .luwi root', async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), 'luwi-global-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'luwi-project-'));
    roots.push(globalRoot, projectRoot);
    const store = createCanonicalStore({ globalRoot });

    const manifest = await store.writeProjectBindings(projectRoot, []);

    expect(manifest.scope).toBe('project');
    expect(manifest.id).toBe('project-agent-bindings');
    await expect(
      readFile(join(projectRoot, '.luwi', 'agent-bindings.json'), 'utf8'),
    ).resolves.toContain('"schemaVersion": 1');
  });

  it('fails reconciliation when a local operation receipt is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luwi-canonical-receipt-'));
    roots.push(root);
    const store = createCanonicalStore({ globalRoot: root });
    await mkdir(join(root, 'operations'), { recursive: true });
    await writeFile(join(root, 'operations', 'broken.receipt.json'), '{"state":"writing"}\n');

    await expect(store.listOperationReceipts()).rejects.toMatchObject({
      code: 'CONFIG_RECONCILIATION_REQUIRED',
    });
  });

  it('rejects an incompatible stored plan artifact instead of casting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luwi-canonical-plan-'));
    roots.push(root);
    const store = createCanonicalStore({ globalRoot: root });
    await mkdir(join(root, 'operations'), { recursive: true });
    await writeFile(
      join(root, 'operations', 'plan-1.plan.json'),
      '{"schemaVersion":1,"planId":"plan-1","adapterId":"codex-native-v1","files":[{"path":"x","content":42,"managementMode":"managed-file"}]}\n',
    );

    await expect(store.readPlanArtifact('plan-1')).rejects.toMatchObject({
      code: 'CONFIG_PLAN_PRECONDITION_FAILED',
    });
  });
});
