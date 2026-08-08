import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { afterEach, describe, expect, it } from 'vitest';

import { buildDaemon, type DaemonApp } from './app.js';
import type { DaemonConfig } from './config.js';

class HealthyRedis implements RedisGateway {
  async connect() {
    return true;
  }
  async checkHealth(): Promise<RedisHealth> {
    return { connected: true, status: 'connected', latencyMs: 1 };
  }
  async close() {}
}

const config: DaemonConfig = {
  host: '127.0.0.1',
  port: 80,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'local',
};

describe('dashboard HTTP route', () => {
  let app: DaemonApp | undefined;
  let distRoot: string | undefined;

  afterEach(async () => {
    await app?.close();
    if (distRoot !== undefined) await rm(distRoot, { recursive: true, force: true });
  });

  it('serves the built shell from the loopback-protected daemon origin', async () => {
    distRoot = await mkdtemp(join(tmpdir(), 'luwi-dashboard-route-'));
    await mkdir(join(distRoot, 'assets'));
    await writeFile(join(distRoot, 'index.html'), '<main>LUWI Pulse</main>');
    await writeFile(join(distRoot, 'assets', 'index-abc.css'), 'body{}');
    app = buildDaemon({
      config,
      redis: new HealthyRedis(),
      logger: false,
      dashboardDistRoot: distRoot,
    });

    const index = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost:80' } });
    expect(index.statusCode).toBe(200);
    expect(index.headers['cache-control']).toBe('no-store');
    expect(index.body).toContain('LUWI Pulse');

    const asset = await app.inject({
      method: 'GET',
      url: '/assets/index-abc.css',
      headers: { host: 'localhost:80' },
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });
});
