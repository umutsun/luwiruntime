import {
  configDriftCollectionSchema,
  configOperationReceiptSchema,
  configPlanApprovalResponseSchema,
  configPlanSchema,
  publicErrorResponseSchema,
} from '@luwi/protocol/browser';
import type { z } from 'zod';

import { driftKind, type ConfigDriftRecord, type ConfigPlanRecord } from './config-scope.js';

/**
 * The configuration plan chain, and the only production module in the dashboard
 * that issues a state-changing request.
 *
 * It builds its own request function rather than extending the read client, so
 * that `createDaemonClient` stays incapable of writing and the guard in
 * `product-independence.test.ts` can name exactly one legal module. AGENTS.md
 * section 21 approved dashboard mutations for this chain; `reconcile`,
 * optimization accept/reject/evaluate, graph rebuild and Git mutation are not
 * carried in by that approval and are absent here.
 *
 * Every request sends `content-type: application/json`, which the daemon
 * requires of a state-changing request that carries no Origin.
 */

export type MutationResult<T> =
  | { state: 'ok'; data: T; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number }
  | { state: 'failed'; reason: 'http'; httpStatus: number; code: string; message: string };

export type PlanCreateInput = {
  agentId: string;
  projectId?: string;
  adoptUnmanaged: boolean;
};

/** A daemon receipt for one applied plan. */
export type ConfigReceiptRecord = {
  id: string;
  planId: string;
  state: string;
  targetPaths: string[];
};

async function request<T>(
  fetchImpl: typeof fetch,
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
): Promise<MutationResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { state: 'failed', reason: 'transport' };
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { state: 'failed', reason: 'invalid', httpStatus: response.status };
  }

  if (!response.ok) {
    /**
     * The daemon's own code and message are carried through rather than
     * collapsed. `CONFIG_PLAN_EXPIRED` and `CONFIG_APPLY_FAILED` tell the
     * reader different true things, and this is the surface that writes their
     * configuration files.
     */
    const error = publicErrorResponseSchema.safeParse(value);
    return error.success
      ? {
          state: 'failed',
          reason: 'http',
          httpStatus: response.status,
          code: error.data.error.code,
          message: error.data.error.message,
        }
      : { state: 'failed', reason: 'invalid', httpStatus: response.status };
  }

  // `safeParse` can throw rather than return, which is how a rejected promise
  // once escaped every caller in the read client. Treated the same way here.
  let parsed: ReturnType<typeof schema.safeParse>;
  try {
    parsed = schema.safeParse(value);
  } catch {
    return { state: 'failed', reason: 'invalid', httpStatus: response.status };
  }
  return parsed.success
    ? { state: 'ok', data: parsed.data, httpStatus: response.status }
    : { state: 'failed', reason: 'invalid', httpStatus: response.status };
}

function toPlanRecord(plan: z.infer<typeof configPlanSchema>): ConfigPlanRecord {
  return {
    id: plan.id,
    agentId: plan.agentId,
    ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
    state: plan.state,
    kind: plan.kind,
    changes: plan.changes.map((change) => ({
      path: change.path,
      operation: change.operation,
      managementMode: change.managementMode,
      redactedDiff: change.redactedDiff,
      warnings: [...change.warnings],
    })),
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    ...(plan.snapshotId === undefined ? {} : { snapshotId: plan.snapshotId }),
    ...(plan.operationId === undefined ? {} : { operationId: plan.operationId }),
  };
}

export function createConfigMutations(fetchImpl: typeof fetch = fetch) {
  const planBody = (input: PlanCreateInput): Record<string, unknown> => ({
    agentId: input.agentId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    adoptUnmanaged: input.adoptUnmanaged,
  });

  const createPlanAt = async (
    path: string,
    input: PlanCreateInput,
  ): Promise<MutationResult<ConfigPlanRecord>> => {
    const result = await request(fetchImpl, path, configPlanSchema, planBody(input));
    return result.state === 'ok'
      ? { state: 'ok', data: toPlanRecord(result.data), httpStatus: result.httpStatus }
      : result;
  };

  return {
    createImportPlan: (input: PlanCreateInput) => createPlanAt('/api/v1/config/import-plan', input),

    createRenderPlan: (input: PlanCreateInput) => createPlanAt('/api/v1/config/render-plan', input),

    createRollbackPlan: async (snapshotId: string): Promise<MutationResult<ConfigPlanRecord>> => {
      const result = await request(
        fetchImpl,
        `/api/v1/config/snapshots/${encodeURIComponent(snapshotId)}/rollback-plan`,
        configPlanSchema,
        {},
      );
      return result.state === 'ok'
        ? { state: 'ok', data: toPlanRecord(result.data), httpStatus: result.httpStatus }
        : result;
    },

    scanDrift: async (): Promise<MutationResult<ConfigDriftRecord[]>> => {
      const result = await request(
        fetchImpl,
        '/api/v1/config/drift/scan',
        configDriftCollectionSchema,
        {},
      );
      return result.state === 'ok'
        ? {
            state: 'ok',
            httpStatus: result.httpStatus,
            data: result.data.drifts.map((entry) => ({
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
        : result;
    },

    /**
     * Approve and apply, in one call, deliberately.
     *
     * `approve` mints a one-time token and the plan state machine allows no
     * second approval, so a token that outlives this function is a plan the
     * runtime can never apply. It is held in a local variable and never written
     * to component state, storage, the URL or a log. The caller is responsible
     * for having obtained the user's confirmation before calling this.
     */
    applyPlanWithApproval: async (planId: string): Promise<MutationResult<ConfigReceiptRecord>> => {
      const id = encodeURIComponent(planId);
      const approval = await request(
        fetchImpl,
        `/api/v1/config/plans/${id}/approve`,
        configPlanApprovalResponseSchema,
        {},
      );
      if (approval.state !== 'ok') return approval;

      const applied = await request(
        fetchImpl,
        `/api/v1/config/plans/${id}/apply`,
        configOperationReceiptSchema,
        { approvalToken: approval.data.approvalToken },
      );
      return applied.state === 'ok'
        ? {
            state: 'ok',
            httpStatus: applied.httpStatus,
            data: {
              id: applied.data.id,
              planId: applied.data.planId,
              state: applied.data.state,
              targetPaths: [...applied.data.targetPaths],
            },
          }
        : applied;
    },
  };
}

export type ConfigMutations = ReturnType<typeof createConfigMutations>;
