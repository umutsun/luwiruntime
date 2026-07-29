import { describe, expect, it } from 'vitest';

import { loadDaemonConfig } from './config.js';

describe('daemon configuration', () => {
  it('uses localhost-safe defaults', () => {
    expect(loadDaemonConfig({})).toEqual({
      host: '127.0.0.1',
      port: 4782,
      redisUrl: 'redis://127.0.0.1:6379',
      logLevel: 'info',
      workspaceId: 'local',
      ownerTtlMs: 15000,
      ownerRenewIntervalMs: 5000,
      sessionPresenceTtlMs: 15000,
      presenceSweepIntervalMs: 1000,
      heartbeatEventIntervalMs: 30000,
      consumerClaimIdleMs: 30000,
      relayBlockMs: 1000,
      relayBatchSize: 100,
      websocketQueueLimit: 256,
      websocketSendTimeoutMs: 1000,
      websocketMaxPayloadBytes: 65536,
      websocketMaxBufferedBytes: 1048576,
      globalStreamMaxLength: 100000,
      projectStreamMaxLength: 50000,
      deadLetterStreamMaxLength: 10000,
      retentionIntervalMs: 60000,
      drainTimeoutMs: 5000,
      reconnectInitialMs: 250,
      reconnectMaxMs: 5000,
      allowedOrigins: ['http://127.0.0.1:4782', 'http://localhost:4782'],
    });
  });

  it('validates environment overrides', () => {
    expect(
      loadDaemonConfig({
        HOST: '127.0.0.1',
        PORT: '5000',
        REDIS_URL: 'redis://redis.example.test:6380/2',
        LOG_LEVEL: 'debug',
        WORKSPACE_ID: 'workspace-1',
      }),
    ).toEqual({
      host: '127.0.0.1',
      port: 5000,
      redisUrl: 'redis://redis.example.test:6380/2',
      logLevel: 'debug',
      workspaceId: 'workspace-1',
      ownerTtlMs: 15000,
      ownerRenewIntervalMs: 5000,
      sessionPresenceTtlMs: 15000,
      presenceSweepIntervalMs: 1000,
      heartbeatEventIntervalMs: 30000,
      consumerClaimIdleMs: 30000,
      relayBlockMs: 1000,
      relayBatchSize: 100,
      websocketQueueLimit: 256,
      websocketSendTimeoutMs: 1000,
      websocketMaxPayloadBytes: 65536,
      websocketMaxBufferedBytes: 1048576,
      globalStreamMaxLength: 100000,
      projectStreamMaxLength: 50000,
      deadLetterStreamMaxLength: 10000,
      retentionIntervalMs: 60000,
      drainTimeoutMs: 5000,
      reconnectInitialMs: 250,
      reconnectMaxMs: 5000,
      allowedOrigins: ['http://127.0.0.1:5000', 'http://localhost:5000'],
    });
  });

  it('rejects non-loopback binding', () => {
    expect(() => loadDaemonConfig({ HOST: '0.0.0.0' })).toThrow();
  });

  it('rejects an invalid port', () => {
    expect(() => loadDaemonConfig({ PORT: '70000' })).toThrow();
  });

  it('rejects remote or wildcard-like WebSocket origins', () => {
    expect(() => loadDaemonConfig({ LUWI_ALLOWED_ORIGINS: 'https://example.test' })).toThrow();
    expect(() =>
      loadDaemonConfig({ LUWI_ALLOWED_ORIGINS: 'http://localhost.evil.test:4782' }),
    ).toThrow();
  });

  it('validates ownership and reconnect timing relationships', () => {
    expect(() =>
      loadDaemonConfig({
        LUWI_DAEMON_OWNER_TTL_MS: '5000',
        LUWI_DAEMON_OWNER_RENEW_INTERVAL_MS: '5000',
      }),
    ).toThrow();
    expect(() =>
      loadDaemonConfig({
        LUWI_RECONNECT_INITIAL_MS: '5000',
        LUWI_RECONNECT_MAX_MS: '1000',
      }),
    ).toThrow();
  });
});
