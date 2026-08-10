import { describe, expect, it, vi } from 'vitest';

import { createConfigMutations } from './config-mutations.js';

const timestamp = '2026-08-10T00:00:00.000Z';

const plan = {
  id: 'plan-1',
  agentId: 'codex-main',
  projectId: 'proj-1',
  state: 'prepared',
  kind: 'render',
  changes: [
    {
      path: 'C:/fixture/.codex/config.toml',
      operation: 'update',
      managementMode: 'managed-fragment',
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64),
      redactedDiff: '+ enabled = true',
      warnings: [],
    },
  ],
  preconditionHashes: { 'C:/fixture/.codex/config.toml': 'a'.repeat(64) },
  createdAt: timestamp,
  expiresAt: '2026-08-10T00:15:00.000Z',
};

const receipt = {
  id: 'op-1',
  planId: 'plan-1',
  agentId: 'codex-main',
  projectId: 'proj-1',
  state: 'completed',
  targetPaths: ['C:/fixture/.codex/config.toml'],
  expectedHashes: { 'C:/fixture/.codex/config.toml': 'a'.repeat(64) },
  committedHashes: { 'C:/fixture/.codex/config.toml': 'b'.repeat(64) },
  startedAt: timestamp,
  updatedAt: timestamp,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('config mutations', () => {
  it('sends a JSON media type on every request, which the daemon now requires', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(plan, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    await mutations.createRenderPlan({ agentId: 'codex-main', adoptUnmanaged: false });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('creates an import plan and a render plan at their own endpoints', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(plan, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    await mutations.createImportPlan({ agentId: 'codex-main', adoptUnmanaged: true });
    await mutations.createRenderPlan({
      agentId: 'codex-main',
      projectId: 'proj-1',
      adoptUnmanaged: false,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/config/import-plan');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/config/render-plan');
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      agentId: 'codex-main',
      adoptUnmanaged: true,
    });
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      agentId: 'codex-main',
      projectId: 'proj-1',
      adoptUnmanaged: false,
    });
  });

  it('returns the plan a rollback produced', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...plan, kind: 'rollback' }, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.createRollbackPlan('snap-1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/config/snapshots/snap-1/rollback-plan');
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.data.kind).toBe('rollback');
  });

  it('percent-encodes an identifier so it cannot escape its path segment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(plan, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    await mutations.createRollbackPlan('../../config/reconcile');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/v1/config/snapshots/..%2F..%2Fconfig%2Freconcile/rollback-plan',
    );
  });

  it('approves then applies, passing the token the approval returned', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ plan: { ...plan, state: 'approved' }, approvalToken: 't'.repeat(48) }),
      )
      .mockResolvedValueOnce(jsonResponse(receipt));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.applyPlanWithApproval('plan-1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/config/plans/plan-1/approve');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/config/plans/plan-1/apply');
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      approvalToken: 't'.repeat(48),
    });
    expect(result.state).toBe('ok');
  });

  it('never applies when the approval failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'CONFIG_PLAN_EXPIRED',
            message: 'The configuration plan has expired.',
          },
        },
        409,
      ),
    );
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.applyPlanWithApproval('plan-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'CONFIG_PLAN_EXPIRED',
      message: 'The configuration plan has expired.',
    });
  });

  it('reports an apply failure as its own, so an approved-but-dead plan is not called success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ plan: { ...plan, state: 'approved' }, approvalToken: 't'.repeat(48) }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'CONFIG_APPLY_FAILED',
              message: 'Another configuration operation currently owns a target file.',
            },
          },
          409,
        ),
      );
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.applyPlanWithApproval('plan-1');

    expect(result.state).toBe('failed');
    if (result.state !== 'failed' || result.reason !== 'http') return;
    expect(result.code).toBe('CONFIG_APPLY_FAILED');
  });

  it('keeps the daemon code and message for a refused runtime', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'RUNTIME_NOT_READY',
            message: 'The runtime is not ready to accept mutations.',
          },
        },
        503,
      ),
    );
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.scanDrift();

    expect(result).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 503,
      code: 'RUNTIME_NOT_READY',
      message: 'The runtime is not ready to accept mutations.',
    });
  });

  it('reports a transport rejection without inventing a status', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network'));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.scanDrift()).toEqual({ state: 'failed', reason: 'transport' });
  });

  it('reports a body that does not validate as invalid rather than trusting it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ plans: 'not a plan' }, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    expect(
      await mutations.createRenderPlan({ agentId: 'codex-main', adoptUnmanaged: false }),
    ).toEqual({ state: 'failed', reason: 'invalid', httpStatus: 201 });
  });

  it('reports an unparseable error body as invalid rather than as a coded failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.scanDrift()).toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 502,
    });
  });
});
