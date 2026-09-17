import { describe, expect, it, vi } from 'vitest';

import { createMessageMutations } from './message-mutations.js';

const timestamp = '2026-08-24T12:00:00.000Z';
const created = {
  message: {
    id: 'message-1',
    correlationId: 'correlation-1',
    projectId: 'project-1',
    sourceSessionId: 'source-1',
    sourceAgentId: 'agent-source',
    targetSessionId: 'target-1',
    targetAgentId: 'agent-target',
    selectionReason: 'explicit target session',
    kind: 'question',
    subject: 'Ownership',
    content: 'Who owns the next change?',
    evidenceRequirements: [],
    state: 'queued',
    createdAt: timestamp,
    updatedAt: timestamp,
    deadlineAt: '2026-08-24T12:02:00.000Z',
  },
  selectedTargetSessionId: 'target-1',
  selectedTargetAgentId: 'agent-target',
  selectionReason: 'explicit target session',
  delivery: 'live',
  idempotent: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const input = {
  sourceSessionId: 'source-1',
  targetSessionId: 'target-1',
  subject: ' Ownership ',
  content: 'Who owns the next change?',
  timeoutMs: 120_000,
  idempotencyKey: 'ask-draft-1',
};

describe('message mutations', () => {
  it('sends one explicit session request with JSON and daemon idempotency', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(created, 202));
    const mutations = createMessageMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.ask(input);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/messages');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('ask-draft-1');
    expect(JSON.parse(init.body as string)).toEqual({
      sourceSessionId: 'source-1',
      targetSessionId: 'target-1',
      kind: 'question',
      subject: 'Ownership',
      content: 'Who owns the next change?',
      evidenceRequirements: [],
      timeoutMs: 120_000,
    });
    expect(result).toEqual({
      state: 'ok',
      data: {
        correlationId: 'correlation-1',
        targetSessionId: 'target-1',
        idempotent: false,
      },
      httpStatus: 202,
    });
  });

  it('rejects invalid local input before fetch', async () => {
    const fetchImpl = vi.fn();
    const mutations = createMessageMutations(fetchImpl as unknown as typeof fetch);

    await expect(
      mutations.ask({ ...input, content: '   ', idempotencyKey: 'bad\nkey' }),
    ).resolves.toMatchObject({
      state: 'failed',
      reason: 'input',
      code: 'REQUEST_VALIDATION_FAILED',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves a validated daemon refusal without trusting arbitrary bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'TARGET_SESSION_UNAVAILABLE',
            message: 'The target session is not online.',
          },
        },
        409,
      ),
    );

    const result = await createMessageMutations(fetchImpl as unknown as typeof fetch).ask(input);

    expect(result).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'TARGET_SESSION_UNAVAILABLE',
      message: 'The target session is not online.',
    });
  });

  it('reports transport and invalid response failures safely', async () => {
    const rejected = createMessageMutations(
      vi.fn().mockRejectedValue(new TypeError('network')) as unknown as typeof fetch,
    );
    await expect(rejected.ask(input)).resolves.toEqual({ state: 'failed', reason: 'transport' });

    const invalid = createMessageMutations(
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: 'not a receipt' }, 202),
        ) as unknown as typeof fetch,
    );
    await expect(invalid.ask(input)).resolves.toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 202,
    });
  });
});
