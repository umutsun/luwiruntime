import { describe, expect, it } from 'vitest';

import {
  createFunctionRegistry,
  createRedisKeys,
  createWakeIntentRepository,
  type RedisCommandClient,
} from './index.js';

class FakeCommandClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  reply: unknown;

  async sendCommand(command: readonly string[]): Promise<unknown> {
    this.commands.push([...command]);
    return this.reply;
  }
}

describe('wake intent repository', () => {
  it('reads one redacted wake intent by its deterministic message identity', async () => {
    const client = new FakeCommandClient();
    client.reply = [
      'id',
      'message-1',
      'messageId',
      'message-1',
      'workflowId',
      'workflow-1',
      'sourceSessionId',
      'session-source',
      'correlationId',
      'correlation-1',
      'terminalState',
      'responded',
      'adapter',
      'codex-queue-v1',
      'state',
      'pending',
      'createdAt',
      '2026-09-09T12:00:00.000Z',
      'updatedAt',
      '2026-09-09T12:00:00.000Z',
      'projectId',
      'project-1',
      'streamId',
      '1-0',
      'deadlineMs',
      '1788955500000',
      'fallbackContinuationId',
      'private-continuation',
      'nativeSessionId',
      'private-native-id',
      'ownerToken',
      'private-owner-token',
      'response',
      'private-response',
    ];
    const keys = createRedisKeys('luwi:test');
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions: createFunctionRegistry('wake_test'),
    });

    await expect(repository.getByMessage('message-1')).resolves.toEqual({
      id: 'message-1',
      messageId: 'message-1',
      workflowId: 'workflow-1',
      sourceSessionId: 'session-source',
      correlationId: 'correlation-1',
      terminalState: 'responded',
      adapter: 'codex-queue-v1',
      state: 'pending',
      createdAt: '2026-09-09T12:00:00.000Z',
      updatedAt: '2026-09-09T12:00:00.000Z',
    });
    expect(client.commands).toEqual([['HGETALL', keys.wakeIntent('message-1')]]);
  });

  it('returns null for a message without a wake and rejects identity drift', async () => {
    const client = new FakeCommandClient();
    const repository = createWakeIntentRepository({
      client,
      keys: createRedisKeys('luwi:test'),
      functions: createFunctionRegistry('wake_test'),
    });
    client.reply = Object.create(null) as Record<string, string>;
    await expect(repository.getByMessage('message-1')).resolves.toBeNull();

    client.reply = [
      'id',
      'message-other',
      'messageId',
      'message-other',
      'workflowId',
      'workflow-1',
      'sourceSessionId',
      'session-source',
      'correlationId',
      'correlation-1',
      'terminalState',
      'failed',
      'adapter',
      'codex-queue-v1',
      'state',
      'pending',
      'createdAt',
      '2026-09-09T12:00:00.000Z',
      'updatedAt',
      '2026-09-09T12:00:00.000Z',
    ];
    await expect(repository.getByMessage('message-1')).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });
});
