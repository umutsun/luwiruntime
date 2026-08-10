import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { DaemonClient, ResourceResult } from './client.js';
import { loadMessageScope, messageResourcesForEvent } from './messages-scope.js';

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    correlationId: 'corr-1',
    projectId: 'proj-1',
    sourceSessionId: 'sess-a',
    sourceAgentId: 'agent-a',
    targetSessionId: 'sess-b',
    targetAgentId: 'agent-b',
    selectionReason: 'only online session for the target agent',
    kind: 'question',
    subject: 'Who owns retention?',
    content: 'Asking before I change the trimming interval.',
    evidenceRequirements: ['session_state'],
    state: 'responded',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:04:00.000Z',
    deadlineAt: '2026-08-10T00:30:00.000Z',
    acknowledgedAt: '2026-08-10T00:01:00.000Z',
    respondedAt: '2026-08-10T00:04:00.000Z',
    response: {
      status: 'answered',
      answer: 'The background worker owns it.',
      confidence: 0.9,
      evidence: [],
      verifiedAt: '2026-08-10T00:04:00.000Z',
    },
    ...overrides,
  };
}

/** Runs the real protocol schema, so a drifted fixture fails here, not in a browser. */
function stubClient(messages: unknown[]): { client: DaemonClient; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    client: {
      async get<T>(path: string, schema: z.ZodType<T>): Promise<ResourceResult<T>> {
        paths.push(path);
        return {
          state: 'ready',
          data: schema.parse({ messages }),
          httpStatus: 200,
          receivedAt: '2026-08-10T00:00:00.000Z',
        };
      },
    },
  };
}

describe('loadMessageScope', () => {
  it('maps a terminal exchange including its response', async () => {
    const { client } = stubClient([message()]);

    const result = await loadMessageScope(client, ['messages']);

    expect(result.messages).toMatchObject({
      state: 'ready',
      data: {
        truncated: false,
        items: [
          {
            correlationId: 'corr-1',
            sourceAgentId: 'agent-a',
            targetAgentId: 'agent-b',
            state: 'responded',
            subject: 'Who owns retention?',
            response: { status: 'answered', confidence: 0.9, evidenceCount: 0 },
          },
        ],
      },
    });
  });

  it('leaves an in-flight message without a response rather than inventing an empty one', async () => {
    const { client } = stubClient([
      message({
        state: 'delivered',
        subject: undefined,
        acknowledgedAt: undefined,
        respondedAt: undefined,
        response: undefined,
      }),
    ]);

    const result = await loadMessageScope(client, ['messages']);
    const item = result.messages?.state === 'ready' ? result.messages.data.items[0] : undefined;

    expect(item?.state).toBe('delivered');
    expect(item === undefined ? true : 'response' in item).toBe(false);
    expect(item === undefined ? true : 'subject' in item).toBe(false);
  });

  it('derives truncation from an over-read, because the response carries no flag', async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      message({ id: `msg-${String(index)}`, correlationId: `corr-${String(index)}` }),
    );
    const { client, paths } = stubClient(many);

    const result = await loadMessageScope(client, ['messages']);

    expect(paths).toEqual(['/api/v1/messages?limit=101']);
    expect(result.messages).toMatchObject({ data: { truncated: true } });
    expect(result.messages?.state === 'ready' ? result.messages.data.items.length : 0).toBe(100);
  });

  it('does not claim truncation when the read fitted inside the page', async () => {
    const { client } = stubClient(
      Array.from({ length: 100 }, (_, index) => message({ id: `msg-${String(index)}` })),
    );

    const result = await loadMessageScope(client, ['messages']);

    expect(result.messages).toMatchObject({ data: { truncated: false } });
  });

  it('reports a failed read as unavailable rather than as an empty conversation list', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'transport' }),
    } as unknown as DaemonClient;

    const result = await loadMessageScope(client, ['messages']);

    expect(result.messages).toEqual({ state: 'unavailable' });
  });

  it('issues no request when the key is not asked for', async () => {
    const { client, paths } = stubClient([]);

    const result = await loadMessageScope(client, []);

    expect(paths).toEqual([]);
    expect(result).toEqual({});
  });
});

describe('messageResourcesForEvent', () => {
  it('refreshes on every message transition, including the ones that end it', () => {
    for (const type of [
      'message.requested',
      'message.delivered',
      'message.acknowledged',
      'message.responded',
      'message.rejected',
      'message.timed_out',
      'message.failed',
    ]) {
      expect(messageResourcesForEvent(type)).toEqual(['messages']);
    }
  });

  it('refreshes on a runtime lifecycle event', () => {
    expect(messageResourcesForEvent('runtime.started')).toEqual(['messages']);
  });

  it('ignores families this route does not render', () => {
    for (const type of ['session.heartbeat', 'git.observed', 'graph.node.projected', 'unknown.x']) {
      expect(messageResourcesForEvent(type)).toEqual([]);
    }
  });
});
