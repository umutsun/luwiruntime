import {
  configDriftCollectionSchema,
  configPlanCollectionSchema,
  configSnapshotCollectionSchema,
} from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * Native configuration management, read-only.
 *
 * These three collections are one chain: a plan proposes changes to an agent's
 * native configuration files, applying it writes a snapshot of what was there
 * first, and drift is what the runtime finds when a managed file no longer
 * matches what it wrote. Twelve `config.*` event types have been reaching
 * Activity since Phase 3, each recording that a step happened and none of them
 * saying which files, which agent, or what changed.
 *
 * Loaded only while `#/config` is open.
 *
 * Nothing here plans, approves, applies, rolls back, rescans, or reconciles.
 * Every one of those is a POST the daemon serves, and AGENTS.md section 21
 * keeps them off read surfaces — which matters more here than anywhere else in
 * the dashboard, because these are the operations that write to the developer's
 * own agent configuration files.
 */

export type DriftSeverity = 'info' | 'warning' | 'error';
export type DriftResolution = 'import' | 'reapply' | 'manual' | 'none';

/**
 * What the two recorded hashes actually say.
 *
 * "Drift" alone does not distinguish a managed file that was edited from one
 * that was deleted, and those call for opposite responses. The classification
 * is derived here rather than in the view so it can be tested without a render.
 */
export type DriftKind = 'edited' | 'removed' | 'appeared' | 'unchanged' | 'unrecorded';

export function driftKind(hashes: {
  expectedHash: string | null;
  observedHash: string | null;
}): DriftKind {
  const { expectedHash, observedHash } = hashes;
  if (expectedHash === null && observedHash === null) return 'unrecorded';
  if (expectedHash === null) return 'appeared';
  if (observedHash === null) return 'removed';
  return expectedHash === observedHash ? 'unchanged' : 'edited';
}

export type ConfigDriftRecord = {
  id: string;
  agentId: string;
  projectId?: string;
  path: string;
  expectedHash: string | null;
  observedHash: string | null;
  severity: DriftSeverity;
  resolution: DriftResolution;
  detectedAt: string;
  kind: DriftKind;
};

export type PlanChange = {
  path: string;
  operation: 'create' | 'update' | 'delete';
  managementMode: 'managed-fragment' | 'managed-file';
  /** Already redacted by the daemon; the dashboard never redacts a second time. */
  redactedDiff: string;
  warnings: string[];
};

export type ConfigPlanRecord = {
  id: string;
  agentId: string;
  projectId?: string;
  state: 'prepared' | 'approved' | 'applying' | 'applied' | 'failed' | 'expired' | 'superseded';
  kind: 'import' | 'render' | 'rollback' | 'optimization';
  changes: PlanChange[];
  createdAt: string;
  expiresAt: string;
  snapshotId?: string;
  operationId?: string;
};

export type SnapshotFile = {
  targetPath: string;
  /**
   * Whether the file was there before the apply. `false` means the apply
   * created it, so rolling back means deleting it rather than restoring it.
   */
  existed: boolean;
  originalHash: string | null;
};

export type ConfigSnapshotRecord = {
  id: string;
  planId: string;
  operationId: string;
  agentId: string;
  projectId?: string;
  createdAt: string;
  adapterVersion: string;
  files: SnapshotFile[];
};

export type ConfigResources = {
  drifts: ResourceState<ConfigDriftRecord[]>;
  plans: ResourceState<ConfigPlanRecord[]>;
  snapshots: ResourceState<ConfigSnapshotRecord[]>;
};

export type ConfigResourceKey = keyof ConfigResources;

export const configResourceKeys: readonly ConfigResourceKey[] = ['drifts', 'plans', 'snapshots'];

const DRIFT_EVENTS = new Set(['config.drift.detected', 'config.drift.resolved']);
const PLAN_EVENTS = new Set([
  'config.import.planned',
  'config.plan.created',
  'config.plan.approved',
  'config.plan.superseded',
]);
/**
 * An apply moves the plan, writes a snapshot, and can clear or create drift in
 * one operation, so the whole chain is invalidated rather than one third of it.
 */
const CHAIN_EVENTS = new Set([
  'config.apply.started',
  'config.applied',
  'config.apply.failed',
  'config.rollback.started',
  'config.rolled_back',
  'config.reconciled',
]);

export function configResourcesForEvent(eventType: string): ConfigResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...configResourceKeys];
  if (CHAIN_EVENTS.has(eventType)) return [...configResourceKeys];
  if (DRIFT_EVENTS.has(eventType)) return ['drifts'];
  if (PLAN_EVENTS.has(eventType)) return ['plans'];
  // `config.inspected` reads native configuration and records nothing here.
  return [];
}

/** What a plan does, in one line, without opening it. */
export function changeSummary(
  changes: readonly { operation: 'create' | 'update' | 'delete'; warnings: readonly string[] }[],
): { create: number; update: number; delete: number; warned: number } {
  return {
    create: changes.filter((change) => change.operation === 'create').length,
    update: changes.filter((change) => change.operation === 'update').length,
    delete: changes.filter((change) => change.operation === 'delete').length,
    warned: changes.filter((change) => change.warnings.length > 0).length,
  };
}

export async function loadConfigScope(
  client: DaemonClient,
  keys: readonly ConfigResourceKey[],
  options: { signal?: AbortSignal } = {},
): Promise<Partial<ConfigResources>> {
  const get = options.signal === undefined ? {} : { signal: options.signal };
  const result: Partial<ConfigResources> = {};

  if (keys.includes('drifts')) {
    const response = await client.get('/api/v1/config/drift', configDriftCollectionSchema, get);
    result.drifts =
      response.state === 'ready'
        ? {
            state: 'ready',
            data: response.data.drifts.map((entry) => ({
              id: entry.id,
              agentId: entry.agentId,
              ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
              path: entry.path,
              expectedHash: entry.expectedHash,
              observedHash: entry.observedHash,
              severity: entry.severity,
              resolution: entry.resolution,
              detectedAt: entry.detectedAt,
              kind: driftKind(entry),
            })),
          }
        : { state: 'unavailable' };
  }

  if (keys.includes('plans')) {
    const response = await client.get('/api/v1/config/plans', configPlanCollectionSchema, get);
    result.plans =
      response.state === 'ready'
        ? {
            state: 'ready',
            data: response.data.plans.map((entry) => ({
              id: entry.id,
              agentId: entry.agentId,
              ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
              state: entry.state,
              kind: entry.kind,
              changes: entry.changes.map((change) => ({
                path: change.path,
                operation: change.operation,
                managementMode: change.managementMode,
                redactedDiff: change.redactedDiff,
                warnings: [...change.warnings],
              })),
              createdAt: entry.createdAt,
              expiresAt: entry.expiresAt,
              ...(entry.snapshotId === undefined ? {} : { snapshotId: entry.snapshotId }),
              ...(entry.operationId === undefined ? {} : { operationId: entry.operationId }),
            })),
          }
        : { state: 'unavailable' };
  }

  if (keys.includes('snapshots')) {
    const response = await client.get(
      '/api/v1/config/snapshots',
      configSnapshotCollectionSchema,
      get,
    );
    result.snapshots =
      response.state === 'ready'
        ? {
            state: 'ready',
            data: response.data.snapshots.map((entry) => ({
              id: entry.id,
              planId: entry.planId,
              operationId: entry.operationId,
              agentId: entry.agentId,
              ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
              createdAt: entry.createdAt,
              adapterVersion: entry.adapterVersion,
              files: entry.files.map((file) => ({
                targetPath: file.targetPath,
                existed: file.existed,
                originalHash: file.originalHash,
              })),
            })),
          }
        : { state: 'unavailable' };
  }

  return result;
}
