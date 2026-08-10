import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { DaemonClient, ResourceResult } from './client.js';
import {
  changeSummary,
  configResourcesForEvent,
  driftKind,
  loadConfigScope,
} from './config-scope.js';

const timestamp = '2026-08-10T00:00:00.000Z';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function drift(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'drift-1',
    agentId: 'codex-main',
    projectId: 'proj-1',
    path: 'C:/fixture/.codex/config.toml',
    expectedHash: hashA,
    observedHash: hashB,
    severity: 'warning',
    resolution: 'reapply',
    detectedAt: timestamp,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-1',
    projectId: 'proj-1',
    agentId: 'codex-main',
    state: 'applied',
    kind: 'render',
    changes: [
      {
        path: 'C:/fixture/.codex/config.toml',
        operation: 'update',
        managementMode: 'managed-fragment',
        beforeHash: hashA,
        afterHash: hashB,
        redactedDiff: '+ enabled = true',
        warnings: ['Existing fragment replaced'],
      },
    ],
    preconditionHashes: { 'C:/fixture/.codex/config.toml': hashA },
    createdAt: timestamp,
    expiresAt: '2026-08-10T00:30:00.000Z',
    snapshotId: 'snapshot-1',
    operationId: 'op-1',
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'snapshot-1',
    operationId: 'op-1',
    planId: 'plan-1',
    agentId: 'codex-main',
    projectId: 'proj-1',
    createdAt: timestamp,
    schemaVersion: 1,
    adapterVersion: 'codex-native-v1',
    files: [
      {
        targetPath: 'C:/fixture/.codex/config.toml',
        existed: true,
        originalHash: hashA,
        snapshotPath: 'C:/fixture/.luwi/snapshots/snapshot-1/config.toml',
        permissions: 420,
      },
    ],
    redactedManifest: {},
    ...overrides,
  };
}

/** Runs the real protocol schemas, so a drifted fixture fails here, not in a browser. */
function stubClient(payloads: { drifts?: unknown[]; plans?: unknown[]; snapshots?: unknown[] }): {
  client: DaemonClient;
  paths: string[];
} {
  const paths: string[] = [];
  return {
    paths,
    client: {
      async get<T>(path: string, schema: z.ZodType<T>): Promise<ResourceResult<T>> {
        paths.push(path);
        const body = path.includes('drift')
          ? { drifts: payloads.drifts ?? [] }
          : path.includes('snapshots')
            ? { snapshots: payloads.snapshots ?? [] }
            : { plans: payloads.plans ?? [] };
        return { state: 'ready', data: schema.parse(body), httpStatus: 200, receivedAt: timestamp };
      },
    },
  };
}

describe('loadConfigScope', () => {
  it('reads the three collections from their own endpoints', async () => {
    const { client, paths } = stubClient({
      drifts: [drift()],
      plans: [plan()],
      snapshots: [snapshot()],
    });

    const result = await loadConfigScope(client, ['drifts', 'plans', 'snapshots']);

    expect(paths.sort()).toEqual([
      '/api/v1/config/drift',
      '/api/v1/config/plans',
      '/api/v1/config/snapshots',
    ]);
    expect(result.drifts).toMatchObject({
      state: 'ready',
      data: [{ id: 'drift-1', severity: 'warning', resolution: 'reapply', kind: 'edited' }],
    });
    expect(result.plans).toMatchObject({
      state: 'ready',
      data: [
        {
          id: 'plan-1',
          state: 'applied',
          kind: 'render',
          snapshotId: 'snapshot-1',
          changes: [{ operation: 'update', warnings: ['Existing fragment replaced'] }],
        },
      ],
    });
    expect(result.snapshots).toMatchObject({
      state: 'ready',
      data: [
        {
          id: 'snapshot-1',
          planId: 'plan-1',
          adapterVersion: 'codex-native-v1',
          files: [{ targetPath: 'C:/fixture/.codex/config.toml', existed: true }],
        },
      ],
    });
  });

  it('keeps a plan that never produced a snapshot free of an invented one', async () => {
    const { client } = stubClient({
      plans: [plan({ state: 'prepared', snapshotId: undefined, operationId: undefined })],
    });

    const result = await loadConfigScope(client, ['plans']);
    const item = result.plans?.state === 'ready' ? result.plans.data[0] : undefined;

    expect(item === undefined ? true : 'snapshotId' in item).toBe(false);
    expect(item === undefined ? true : 'operationId' in item).toBe(false);
  });

  it('reports each read as unavailable on its own', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'http', httpStatus: 500 }),
    } as unknown as DaemonClient;

    const result = await loadConfigScope(client, ['drifts', 'plans', 'snapshots']);

    expect(result.drifts).toEqual({ state: 'unavailable' });
    expect(result.plans).toEqual({ state: 'unavailable' });
    expect(result.snapshots).toEqual({ state: 'unavailable' });
  });

  it('issues no request for a key that was not asked for', async () => {
    const { client, paths } = stubClient({});

    await loadConfigScope(client, ['drifts']);

    expect(paths).toEqual(['/api/v1/config/drift']);
  });
});

describe('driftKind', () => {
  /**
   * Two nullable hashes carry four different facts, and "drift" alone carries
   * none of them. A managed file that was deleted and one that was edited need
   * opposite responses from the reader.
   */
  it('names an out-of-band edit', () => {
    expect(driftKind({ expectedHash: hashA, observedHash: hashB })).toBe('edited');
  });

  it('names a managed file that is gone', () => {
    expect(driftKind({ expectedHash: hashA, observedHash: null })).toBe('removed');
  });

  it('names a file that exists where the runtime expected none', () => {
    expect(driftKind({ expectedHash: null, observedHash: hashB })).toBe('appeared');
  });

  it('does not call matching hashes drift', () => {
    expect(driftKind({ expectedHash: hashA, observedHash: hashA })).toBe('unchanged');
  });

  it('says nothing was recorded rather than guessing, when neither hash exists', () => {
    expect(driftKind({ expectedHash: null, observedHash: null })).toBe('unrecorded');
  });
});

describe('changeSummary', () => {
  it('counts the operations a plan performs and the changes carrying warnings', () => {
    expect(
      changeSummary([
        { operation: 'create', warnings: [] },
        { operation: 'update', warnings: ['a'] },
        { operation: 'update', warnings: ['b', 'c'] },
        { operation: 'delete', warnings: [] },
      ]),
    ).toEqual({ create: 1, update: 2, delete: 1, warned: 2 });
  });

  it('counts nothing for a plan with no changes', () => {
    expect(changeSummary([])).toEqual({ create: 0, update: 0, delete: 0, warned: 0 });
  });
});

describe('configResourcesForEvent', () => {
  it('refreshes drift on a drift transition', () => {
    for (const type of ['config.drift.detected', 'config.drift.resolved']) {
      expect(configResourcesForEvent(type)).toEqual(['drifts']);
    }
  });

  it('refreshes plans on a plan transition', () => {
    for (const type of [
      'config.plan.created',
      'config.plan.approved',
      'config.plan.superseded',
      'config.import.planned',
    ]) {
      expect(configResourcesForEvent(type)).toEqual(['plans']);
    }
  });

  /**
   * Applying a plan moves the plan, writes a snapshot, and can produce drift in
   * the same breath, so the whole chain is invalidated by one event.
   */
  it('refreshes the whole chain on an apply, rollback, or reconcile', () => {
    for (const type of [
      'config.apply.started',
      'config.applied',
      'config.apply.failed',
      'config.rollback.started',
      'config.rolled_back',
      'config.reconciled',
    ]) {
      expect(configResourcesForEvent(type)).toEqual(['drifts', 'plans', 'snapshots']);
    }
  });

  it('refreshes the whole chain on a runtime lifecycle event', () => {
    expect(configResourcesForEvent('runtime.started')).toEqual(['drifts', 'plans', 'snapshots']);
  });

  /** `config.inspected` reads native configuration; it changes none of these records. */
  it('ignores an inspection and every unrelated family', () => {
    for (const type of [
      'config.inspected',
      'capability.registered',
      'session.heartbeat',
      'unknown.x',
    ]) {
      expect(configResourcesForEvent(type)).toEqual([]);
    }
  });
});
