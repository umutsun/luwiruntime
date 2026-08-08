import { describe, expect, it } from 'vitest';

import { createRedisKeys, runMessageRetention, type RedisCommandClient } from './index.js';

class FakeClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  replies: unknown[] = [];

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    return this.replies.shift();
  }
}

describe('message retention', () => {
  it('prunes expired terminal projections only after their idempotency index expires', async () => {
    const client = new FakeClient();
    const keys = createRedisKeys();
    client.replies = [
      ['message-1'],
      {
        id: 'message-1',
        correlationId: 'correlation-1',
        projectId: 'project-1',
        sourceSessionId: 'source',
        targetSessionId: 'target',
        idempotencyKeyHash: 'a'.repeat(64),
      },
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      [],
    ];

    await expect(
      runMessageRetention({
        client,
        keys,
        nowMs: 100_000,
        terminalProjectionRetentionMs: 10_000,
        maxInboxLength: 100,
        batchSize: 10,
        sessionIds: [],
      }),
    ).resolves.toEqual({
      projectionCandidates: 1,
      projectionsPruned: 1,
      projectionsDeferredForIdempotency: 0,
      inboxesTrimmed: 0,
      inboxesDeferred: 0,
    });
    const prune = client.commands.find((command) => command[0] === 'EVAL');
    expect(prune?.slice(2, 5)).toEqual([
      '7',
      keys.message('message-1'),
      keys.messageCorrelation('correlation-1'),
    ]);
    expect(prune).toContain(keys.terminalMessages);
  });

  it('defers inbox trimming while pending recovery or consumer lag exists', async () => {
    const client = new FakeClient();
    const keys = createRedisKeys();
    client.replies = [
      [],
      [['name', 'luwi-session-inbox-v1', 'pending', 1, 'lag', 0]],
      [['name', 'luwi-session-inbox-v1', 'pending', 0, 'lag', 2]],
    ];

    await expect(
      runMessageRetention({
        client,
        keys,
        nowMs: 100_000,
        terminalProjectionRetentionMs: 10_000,
        maxInboxLength: 100,
        batchSize: 10,
        sessionIds: ['session-1', 'session-2'],
      }),
    ).resolves.toMatchObject({ inboxesTrimmed: 0, inboxesDeferred: 2 });
    expect(client.commands.some((command) => command[0] === 'XTRIM')).toBe(false);
  });
});
