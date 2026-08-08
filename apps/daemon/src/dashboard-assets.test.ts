import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readDashboardAsset } from './dashboard-assets.js';

describe('dashboard production assets', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it('serves only the dashboard index and single-level Vite assets', async () => {
    root = await mkdtemp(join(tmpdir(), 'luwi-dashboard-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<main>Pulse</main>');
    await writeFile(join(root, 'assets', 'index-abc.js'), 'export {};');

    await expect(readDashboardAsset(root, '/')).resolves.toMatchObject({
      contentType: 'text/html; charset=utf-8',
    });
    await expect(readDashboardAsset(root, '/assets/index-abc.js')).resolves.toMatchObject({
      contentType: 'text/javascript; charset=utf-8',
    });
    await expect(readDashboardAsset(root, '/api/v1/projects')).resolves.toBeNull();
    await expect(readDashboardAsset(root, '/assets/../index.html')).resolves.toBeNull();
  });

  it('returns null when the dashboard bundle is not present', async () => {
    root = await mkdtemp(join(tmpdir(), 'luwi-dashboard-missing-'));
    await expect(readDashboardAsset(root, '/')).resolves.toBeNull();
  });
});
