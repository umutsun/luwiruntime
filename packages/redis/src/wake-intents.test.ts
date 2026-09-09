import { describe, expect, it } from 'vitest';

import {
  createFunctionRegistry,
  createRedisKeys,
  createWakeIntentRepository,
  type RedisCommandClient,
} from './index.js';

class FakeCommandClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  replies: Array<unknown | Error> = [];

  async sendCommand(command: readonly string[]): Promise<unknown> {
    this.commands.push([...command]);
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  }
}

const storedWake = (overrides: Record<string, string> = {}): string[] =>
  Object.entries({
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
    workspaceId: 'local',
    projectId: 'project-1',
    sourceAgentId: 'codex',
    workflowRevision: '1',
    streamId: '1-0',
    deadlineMs: '1788955500000',
    fallbackContinuationId: 'private-continuation',
    requestedEventId: 'event-requested',
    lastEventId: 'event-requested',
    ...overrides,
  }).flat();

describe('wake intent repository', () => {
  it('reads one redacted wake intent by its deterministic message identity', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      [
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
      ],
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
    client.replies = [Object.create(null) as Record<string, string>];
    await expect(repository.getByMessage('message-1')).resolves.toBeNull();

    client.replies = [
      [
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
      ],
    ];
    await expect(repository.getByMessage('message-1')).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });

  it('creates the durable group at 0-0 and treats BUSYGROUP as idempotent', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions: createFunctionRegistry('wake_test'),
    });
    client.replies = ['OK'];
    await expect(repository.createGroupAtZero()).resolves.toEqual({ created: true });
    expect(client.commands[0]).toEqual([
      'XGROUP',
      'CREATE',
      keys.wakeStream,
      'luwi-wake-v1',
      '0-0',
      'MKSTREAM',
    ]);

    client.replies = [new Error('BUSYGROUP Consumer Group name already exists')];
    await expect(repository.createGroupAtZero()).resolves.toEqual({ created: false });
  });

  it('claims fresh work without turning blockMs zero into an infinite Redis block', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const functions = createFunctionRegistry('wake_test');
    const ids = ['claim-1', 'event-claimed'];
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions,
      createId: () => ids.shift() ?? 'unexpected',
    });
    client.replies = [
      [[keys.wakeStream, [['1-0', ['wakeIntentId', 'message-1']]]]],
      storedWake(),
      JSON.stringify({
        status: 'updated',
        intent: Object.fromEntries(
          storedWake({
            state: 'claimed',
            updatedAt: '2026-09-09T12:01:00.000Z',
          }).reduce<Array<[string, string]>>((pairs, value, index, all) => {
            if (index % 2 === 0) pairs.push([value, all[index + 1] ?? '']);
            return pairs;
          }, []),
        ),
        claimId: 'claim-1',
      }),
    ];

    await expect(
      repository.claim({ dispatcherInstanceId: 'dispatcher-1', limit: 1, blockMs: 0 }),
    ).resolves.toEqual({
      items: [
        {
          intent: expect.objectContaining({ id: 'message-1', state: 'claimed' }),
          claimId: 'claim-1',
        },
      ],
      recoveredDispatching: [],
      terminalAcknowledged: 0,
    });
    expect(client.commands[0]).toEqual([
      'XREADGROUP',
      'GROUP',
      'luwi-wake-v1',
      'dispatcher-1',
      'COUNT',
      '1',
      'STREAMS',
      keys.wakeStream,
      '>',
    ]);
    expect(client.commands[0]).not.toContain('BLOCK');
    expect(client.commands[2]?.slice(0, 3)).toEqual(['FCALL', functions.functions.wakeClaim, '4']);
  });

  it('recovers a transferred dispatching entry as indeterminate and acknowledges terminal entries', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const functions = createFunctionRegistry('wake_test');
    const ids = ['claim-1', 'event-claim-1', 'claim-2', 'event-claim-2', 'event-recover'];
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions,
      createId: () => ids.shift() ?? 'unexpected',
    });
    client.replies = [
      [
        '0-0',
        [
          ['1-0', ['wakeIntentId', 'message-1']],
          ['2-0', ['wakeIntentId', 'message-2']],
        ],
        [],
      ],
      storedWake({
        state: 'dispatching',
        dispatcherInstanceId: 'dispatcher-old',
        claimId: 'claim-old',
        attemptId: 'attempt-old',
      }),
      JSON.stringify({ status: 'recover_dispatching' }),
      storedWake({
        id: 'message-2',
        messageId: 'message-2',
        workflowId: 'workflow-2',
        correlationId: 'correlation-2',
        state: 'dispatched',
        streamId: '2-0',
      }),
      JSON.stringify({ status: 'terminal_acknowledged' }),
      storedWake({
        state: 'dispatching',
        dispatcherInstanceId: 'dispatcher-old',
        claimId: 'claim-old',
        attemptId: 'attempt-old',
      }),
      JSON.stringify({
        status: 'updated',
        intent: Object.fromEntries(
          storedWake({
            state: 'indeterminate',
            reasonCode: 'dispatcher_recovered',
            updatedAt: '2026-09-09T12:02:00.000Z',
          }).reduce<Array<[string, string]>>((pairs, value, index, all) => {
            if (index % 2 === 0) pairs.push([value, all[index + 1] ?? '']);
            return pairs;
          }, []),
        ),
      }),
    ];

    await expect(
      repository.reclaim({ dispatcherInstanceId: 'dispatcher-new', limit: 2, minIdleMs: 15_000 }),
    ).resolves.toEqual({
      items: [],
      recoveredDispatching: [expect.objectContaining({ id: 'message-1', state: 'indeterminate' })],
      terminalAcknowledged: 1,
    });
    expect(client.commands[0]).toEqual([
      'XAUTOCLAIM',
      keys.wakeStream,
      'luwi-wake-v1',
      'dispatcher-new',
      '15000',
      '0-0',
      'COUNT',
      '2',
    ]);
    expect(client.commands.at(-1)?.slice(0, 3)).toEqual([
      'FCALL',
      functions.functions.wakeRecoverDispatching,
      '6',
    ]);
  });

  it('continues from the XAUTOCLAIM cursor when the first bounded scan finds no idle work', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const functions = createFunctionRegistry('wake_test');
    const ids = ['claim-1', 'event-claimed'];
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions,
      createId: () => ids.shift() ?? 'unexpected',
    });
    client.replies = [
      ['100-0', [], []],
      ['0-0', [['101-0', ['wakeIntentId', 'message-1']]], []],
      storedWake({ streamId: '101-0' }),
      JSON.stringify({
        status: 'updated',
        intent: Object.fromEntries(
          storedWake({
            state: 'claimed',
            streamId: '101-0',
            updatedAt: '2026-09-09T12:01:00.000Z',
          }).reduce<Array<[string, string]>>((pairs, value, index, all) => {
            if (index % 2 === 0) pairs.push([value, all[index + 1] ?? '']);
            return pairs;
          }, []),
        ),
        claimId: 'claim-1',
      }),
    ];

    await expect(
      repository.reclaim({ dispatcherInstanceId: 'dispatcher-new', limit: 1, minIdleMs: 15_000 }),
    ).resolves.toMatchObject({
      items: [{ intent: { id: 'message-1', state: 'claimed' }, claimId: 'claim-1' }],
    });
    expect(client.commands.filter(([name]) => name === 'XAUTOCLAIM')).toEqual([
      [
        'XAUTOCLAIM',
        keys.wakeStream,
        'luwi-wake-v1',
        'dispatcher-new',
        '15000',
        '0-0',
        'COUNT',
        '1',
      ],
      [
        'XAUTOCLAIM',
        keys.wakeStream,
        'luwi-wake-v1',
        'dispatcher-new',
        '15000',
        '100-0',
        'COUNT',
        '1',
      ],
    ]);
  });

  it('rereads an uncertain dispatching fence and recognizes its exact committed attempt', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions: createFunctionRegistry('wake_test'),
    });
    client.replies = [
      storedWake({ state: 'claimed', dispatcherInstanceId: 'dispatcher-1', claimId: 'claim-1' }),
      new Error('socket closed after write'),
      storedWake({
        state: 'dispatching',
        dispatcherInstanceId: 'dispatcher-1',
        claimId: 'claim-1',
        attemptId: 'attempt-1',
      }),
    ];

    await expect(
      repository.markDispatching({
        intentId: 'message-1',
        dispatcherInstanceId: 'dispatcher-1',
        claimId: 'claim-1',
        attemptId: 'attempt-1',
        eventId: 'event-dispatching',
      }),
    ).resolves.toEqual({
      status: 'unchanged',
      intent: expect.objectContaining({ id: 'message-1', state: 'dispatching' }),
    });
    expect(client.commands.map(([name]) => name)).toEqual(['HGETALL', 'FCALL', 'HGETALL']);
  });

  it('lists only redacted projections in oldest-first index order', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions: createFunctionRegistry('wake_test'),
    });
    client.replies = [
      ['message-1', 'message-2'],
      storedWake({ nativeSessionId: 'secret-native' }),
      storedWake({
        id: 'message-2',
        messageId: 'message-2',
        workflowId: 'workflow-2',
        correlationId: 'correlation-2',
        state: 'dispatched',
        streamId: '2-0',
        nativeSessionId: 'secret-native-2',
      }),
    ];

    const listed = await repository.list({ limit: 2 });
    expect(listed).toEqual([
      expect.objectContaining({ id: 'message-1' }),
      expect.objectContaining({ id: 'message-2' }),
    ]);
    expect(JSON.stringify(listed)).not.toContain('secret-native');
    expect(client.commands[0]).toEqual(['ZRANGE', keys.wakeIntentsIndex, '0', '1']);
  });

  it('continues bounded oldest-first scans until a requested state is found', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions: createFunctionRegistry('wake_test'),
    });
    const terminalIds = Array.from({ length: 1000 }, (_, index) => `terminal-${index}`);
    client.replies = [
      terminalIds,
      ...terminalIds.map((id, index) =>
        storedWake({
          id,
          messageId: id,
          workflowId: `workflow-${index}`,
          correlationId: `correlation-${index}`,
          state: 'dispatched',
          streamId: `${index + 1}-0`,
        }),
      ),
      ['message-1'],
      storedWake({ state: 'pending', streamId: '1001-0' }),
    ];

    await expect(repository.list({ state: 'pending', limit: 1 })).resolves.toEqual([
      expect.objectContaining({ id: 'message-1', state: 'pending' }),
    ]);
    expect(client.commands.filter(([name]) => name === 'ZRANGE')).toEqual([
      ['ZRANGE', keys.wakeIntentsIndex, '0', '999'],
      ['ZRANGE', keys.wakeIntentsIndex, '1000', '1999'],
    ]);
  });

  it('fails closed when a project index points at another project wake', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions: createFunctionRegistry('wake_test'),
    });
    client.replies = [['message-1'], storedWake({ projectId: 'project-other' })];

    await expect(repository.list({ projectId: 'project-1', limit: 1 })).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });

  it('uses Redis TIME rather than the caller clock to select expired wake deadlines', async () => {
    const client = new FakeCommandClient();
    const keys = createRedisKeys('luwi:test');
    const repository = createWakeIntentRepository({
      client,
      keys,
      functions: createFunctionRegistry('wake_test'),
    });
    client.replies = [['1788955600', '500000'], []];

    await expect(repository.sweep({ nowMs: 1, limit: 10 })).resolves.toEqual({
      candidates: 0,
      fallbackOnly: 0,
      unchanged: 0,
    });
    expect(client.commands.slice(0, 2)).toEqual([
      ['TIME'],
      ['ZRANGE', keys.wakeIntentDeadlines, '-inf', '1788955600500', 'BYSCORE', 'LIMIT', '0', '10'],
    ]);
  });
});
