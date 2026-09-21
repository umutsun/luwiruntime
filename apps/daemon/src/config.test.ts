import { describe, expect, it } from 'vitest';
import { delimiter, resolve } from 'node:path';

import { loadDaemonConfig, loadRuntimeInstanceId } from './config.js';

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
      sessionStartingGraceMs: 180000,
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
      nativeLinkRetentionMax: 1000,
      terminalSessionRetentionMs: 86400000,
      terminalSessionSweepBatchSize: 500,
      capabilityRoots: [],
      messageTimeoutSweepIntervalMs: 1000,
      messageTimeoutBatchSize: 100,
      messageMaxContentBytes: 32768,
      messageMaxSubjectBytes: 512,
      messageMaxResponseBytes: 65536,
      messageMaxEvidenceItems: 32,
      messageDefaultTimeoutMs: 120000,
      messageMaxTimeoutMs: 86400000,
      inboxClaimLimit: 10,
      inboxBlockMs: 5000,
      inboxMinIdleMs: 15000,
      inboxMaxClaimLimit: 100,
      terminalMessageRetentionMs: 604800000,
      messageIdempotencyRetentionMs: 86400000,
      sessionInboxMaxLength: 10000,
      drainTimeoutMs: 5000,
      reconnectInitialMs: 250,
      reconnectMaxMs: 5000,
      allowedOrigins: ['http://127.0.0.1:4782', 'http://localhost:4782'],
      configSnapshotRetentionCount: 50,
      gitCommandTimeoutMs: 5000,
      gitScanIntervalMs: 300000,
      transcriptScanIntervalMs: 300000,
      transcriptMaxFileBytes: 16777216,
      transcriptMaxFilesPerScan: 2000,
      usageRetentionDays: 30,
      gitObservationRetentionCount: 100,
      graphGenerationRetentionCount: 2,
      optimizationMinimumBaselineSessions: 3,
      optimizationMinimumPostSessions: 3,
      optimizationMinimumObservationHours: 24,
      optimizationMaximumFindings: 100,
      optimizationMaximumProposals: 25,
      optimizationOversizedContextTokens: 8000,
    });
  });

  it('parses bounded unique absolute capability roots without touching the filesystem', () => {
    const first = resolve('fixtures', 'capabilities-one');
    const second = resolve('fixtures', 'capabilities-two');

    expect(
      loadDaemonConfig({
        LUWI_CAPABILITY_ROOTS: [first, ` ${second} `, first].join(delimiter),
      }).capabilityRoots,
    ).toEqual([first, second]);
    expect(() => loadDaemonConfig({ LUWI_CAPABILITY_ROOTS: '   ' })).toThrow(/blank/i);
    expect(() =>
      loadDaemonConfig({ LUWI_CAPABILITY_ROOTS: [first, '', second].join(delimiter) }),
    ).toThrow(/blank/i);
  });

  it('validates an optional lifecycle-provided runtime instance identity', () => {
    expect(loadRuntimeInstanceId({})).toBeUndefined();
    expect(
      loadRuntimeInstanceId({
        LUWI_RUNTIME_INSTANCE_ID: 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b',
      }),
    ).toBe('f2e95fa4-f12d-4a42-92bb-fba0bb5f938b');
    expect(() => loadRuntimeInstanceId({ LUWI_RUNTIME_INSTANCE_ID: 'not-a-runtime-id' })).toThrow();
  });

  it('rejects relative or excessive capability roots', () => {
    expect(() => loadDaemonConfig({ LUWI_CAPABILITY_ROOTS: 'relative/skills' })).toThrow(
      /capability roots/i,
    );
    expect(() =>
      loadDaemonConfig({
        LUWI_CAPABILITY_ROOTS: Array.from({ length: 33 }, (_, index) =>
          resolve('fixtures', `capabilities-${String(index)}`),
        ).join(delimiter),
      }),
    ).toThrow(/capability roots/i);
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
      sessionStartingGraceMs: 180000,
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
      nativeLinkRetentionMax: 1000,
      terminalSessionRetentionMs: 86400000,
      terminalSessionSweepBatchSize: 500,
      messageTimeoutSweepIntervalMs: 1000,
      messageTimeoutBatchSize: 100,
      messageMaxContentBytes: 32768,
      messageMaxSubjectBytes: 512,
      messageMaxResponseBytes: 65536,
      messageMaxEvidenceItems: 32,
      messageDefaultTimeoutMs: 120000,
      messageMaxTimeoutMs: 86400000,
      inboxClaimLimit: 10,
      inboxBlockMs: 5000,
      inboxMinIdleMs: 15000,
      inboxMaxClaimLimit: 100,
      terminalMessageRetentionMs: 604800000,
      messageIdempotencyRetentionMs: 86400000,
      sessionInboxMaxLength: 10000,
      drainTimeoutMs: 5000,
      reconnectInitialMs: 250,
      reconnectMaxMs: 5000,
      allowedOrigins: ['http://127.0.0.1:5000', 'http://localhost:5000'],
      capabilityRoots: [],
      configSnapshotRetentionCount: 50,
      gitCommandTimeoutMs: 5000,
      gitScanIntervalMs: 300000,
      transcriptScanIntervalMs: 300000,
      transcriptMaxFileBytes: 16777216,
      transcriptMaxFilesPerScan: 2000,
      usageRetentionDays: 30,
      gitObservationRetentionCount: 100,
      graphGenerationRetentionCount: 2,
      optimizationMinimumBaselineSessions: 3,
      optimizationMinimumPostSessions: 3,
      optimizationMinimumObservationHours: 24,
      optimizationMaximumFindings: 100,
      optimizationMaximumProposals: 25,
      optimizationOversizedContextTokens: 8000,
    });
  });

  it('accepts explicit sandbox roots for LUWI state and native adapter inspection', () => {
    expect(
      loadDaemonConfig({
        LUWI_HOME: 'C:/fixture/luwi-home',
        LUWI_NATIVE_HOME: 'C:/fixture/native-home',
      }),
    ).toMatchObject({
      luwiHome: 'C:/fixture/luwi-home',
      nativeHome: 'C:/fixture/native-home',
    });
  });

  it('bounds retained native session links, with an overridable default', () => {
    expect(loadDaemonConfig({}).nativeLinkRetentionMax).toBe(1000);
    expect(loadDaemonConfig({ LUWI_NATIVE_LINK_RETENTION_MAX: '32' }).nativeLinkRetentionMax).toBe(
      32,
    );
  });

  it('rejects a native link retention bound that would retain nothing', () => {
    expect(() => loadDaemonConfig({ LUWI_NATIVE_LINK_RETENTION_MAX: '0' })).toThrow();
    expect(() => loadDaemonConfig({ LUWI_NATIVE_LINK_RETENTION_MAX: '-1' })).toThrow();
    expect(() => loadDaemonConfig({ LUWI_NATIVE_LINK_RETENTION_MAX: 'many' })).toThrow();
  });

  it('never lets terminal-session retention fall below the message max timeout (§7)', () => {
    // Default is the 24h message max timeout. A shorter retention could purge a
    // session while a message to it still had an open deadline, whose late
    // resolution would XADD-recreate the inbox as a groupless orphan stream.
    expect(loadDaemonConfig({}).terminalSessionRetentionMs).toBe(86_400_000);
    expect(() => loadDaemonConfig({ LUWI_TERMINAL_SESSION_RETENTION_MS: '3600000' })).toThrow();
    expect(
      loadDaemonConfig({ LUWI_TERMINAL_SESSION_RETENTION_MS: '604800000' })
        .terminalSessionRetentionMs,
    ).toBe(604_800_000);
  });

  it('keeps a graphify output override relative and inside the project', () => {
    expect(
      loadDaemonConfig({ LUWI_GRAPHIFY_OUTPUT_PATH: 'kg/graph.json' }).graphifyOutputPath,
    ).toBe('kg/graph.json');
    expect(loadDaemonConfig({}).graphifyOutputPath).toBeUndefined();
    for (const escaping of [
      '../graph.json',
      'kg/../../graph.json',
      '/tmp/graph.json',
      'C:/graph.json',
      '\\\\server\\share\\graph.json',
    ]) {
      expect(() => loadDaemonConfig({ LUWI_GRAPHIFY_OUTPUT_PATH: escaping })).toThrow(/inside/);
    }
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

  it('accepts the dashboard development origin only through an explicit exact allowlist', () => {
    const defaults = loadDaemonConfig({});
    const development = loadDaemonConfig({
      LUWI_ALLOWED_ORIGINS: 'http://127.0.0.1:4782,http://localhost:4782,http://127.0.0.1:4783',
    });

    expect(defaults.allowedOrigins).not.toContain('http://127.0.0.1:4783');
    expect(development.allowedOrigins).toEqual([
      'http://127.0.0.1:4782',
      'http://localhost:4782',
      'http://127.0.0.1:4783',
    ]);
    expect(development.allowedOrigins).not.toContain('http://127.0.0.1:4784');
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
    expect(() =>
      loadDaemonConfig({
        LUWI_MESSAGE_DEFAULT_TIMEOUT_MS: '2000',
        LUWI_MESSAGE_MAX_TIMEOUT_MS: '1000',
      }),
    ).toThrow();
    expect(() =>
      loadDaemonConfig({
        LUWI_INBOX_CLAIM_LIMIT: '11',
        LUWI_INBOX_MAX_CLAIM_LIMIT: '10',
      }),
    ).toThrow();
  });
});
