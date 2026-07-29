import { describe, expect, it } from 'vitest';

import {
  ensureRealtimeStreamGroup,
  readLatestRuntimeEvents,
  runStreamRetention,
  type RedisCommandClient,
} from './index.js';

class FakeClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  replies: unknown[] = [];

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    return this.replies.shift();
  }
}

describe('realtime Stream bootstrap', () => {
  it('creates the group at $ with MKSTREAM only when it is absent', async () => {
    const client = new FakeClient();
    client.replies = ['none', 'OK'];

    await expect(ensureRealtimeStreamGroup(client, 'events', 'luwi-realtime-v1')).resolves.toEqual({
      created: true,
    });
    expect(client.commands).toEqual([
      ['TYPE', 'events'],
      ['XGROUP', 'CREATE', 'events', 'luwi-realtime-v1', '$', 'MKSTREAM'],
    ]);
  });

  it('preserves an existing group and its delivered position', async () => {
    const client = new FakeClient();
    client.replies = [
      'stream',
      [
        [
          'name',
          'luwi-realtime-v1',
          'consumers',
          1,
          'pending',
          0,
          'last-delivered-id',
          '42-0',
          'entries-read',
          42,
          'lag',
          0,
        ],
      ],
    ];

    await expect(ensureRealtimeStreamGroup(client, 'events', 'luwi-realtime-v1')).resolves.toEqual({
      created: false,
    });
    expect(client.commands).toHaveLength(2);
  });
});

describe('event history', () => {
  it('validates newest entries and returns them in ascending Stream order', async () => {
    const client = new FakeClient();
    const base = {
      version: 1,
      type: 'project.registered',
      occurredAt: '2026-07-28T12:00:00.000Z',
      workspaceId: 'local',
      projectId: 'project-1',
      payload: {},
    };
    client.replies = [
      [
        ['2-0', ['event', JSON.stringify({ ...base, id: 'event-2' })]],
        ['1-0', ['event', JSON.stringify({ ...base, id: 'event-1' })]],
      ],
    ];

    await expect(
      readLatestRuntimeEvents({
        client,
        stream: 'global',
        deadLetterStream: 'dead',
        deadLetterMaxLength: 10,
        limit: 2,
      }),
    ).resolves.toMatchObject([
      { streamId: '1-0', event: { id: 'event-1' } },
      { streamId: '2-0', event: { id: 'event-2' } },
    ]);
  });

  it('dead-letters malformed history without copying raw values', async () => {
    const client = new FakeClient();
    client.replies = [[['1-0', ['event', 'secret-history']]], '2-0'];

    await expect(
      readLatestRuntimeEvents({
        client,
        stream: 'global',
        deadLetterStream: 'dead',
        deadLetterMaxLength: 10,
        limit: 2,
        now: () => new Date('2026-07-28T12:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'REDIS_DATA_INVALID' });
    expect(JSON.stringify(client.commands[1])).not.toContain('secret-history');
  });
});

describe('Stream retention', () => {
  it('trims global only with healthy relay, zero pending, and known zero lag', async () => {
    const client = new FakeClient();
    client.replies = [
      [
        [
          'name',
          'luwi-realtime-v1',
          'consumers',
          1,
          'pending',
          0,
          'last-delivered-id',
          '10-0',
          'entries-read',
          10,
          'lag',
          0,
        ],
      ],
      3,
      ['project-1'],
      2,
      1,
    ];

    await expect(
      runStreamRetention({
        client,
        globalStream: 'global',
        projectStream: (projectId) => `project:${projectId}`,
        deadLetterStream: 'dead',
        projectsIndex: 'projects',
        consumerGroup: 'luwi-realtime-v1',
        globalMaxLength: 100,
        projectMaxLength: 50,
        deadLetterMaxLength: 10,
        relayHealthy: true,
      }),
    ).resolves.toEqual({
      globalTrimmed: true,
      globalDeferredReason: undefined,
      projectStreamsTrimmed: 1,
      deadLetterTrimmed: true,
    });
    expect(client.commands).toContainEqual(['XTRIM', 'global', 'MAXLEN', '~', '100']);
  });

  it.each([
    {
      name: 'pending entries',
      group: ['name', 'luwi-realtime-v1', 'pending', 1, 'lag', 0],
      healthy: true,
      reason: 'pending',
    },
    {
      name: 'consumer lag',
      group: ['name', 'luwi-realtime-v1', 'pending', 0, 'lag', 2],
      healthy: true,
      reason: 'lag',
    },
    {
      name: 'missing lag metadata',
      group: ['name', 'luwi-realtime-v1', 'pending', 0],
      healthy: true,
      reason: 'metadata_unavailable',
    },
    {
      name: 'unhealthy relay',
      group: ['name', 'luwi-realtime-v1', 'pending', 0, 'lag', 0],
      healthy: false,
      reason: 'relay_unhealthy',
    },
  ])('defers global trimming for $name', async ({ group, healthy, reason }) => {
    const client = new FakeClient();
    client.replies = [[group], [], 0];

    const result = await runStreamRetention({
      client,
      globalStream: 'global',
      projectStream: (projectId) => `project:${projectId}`,
      deadLetterStream: 'dead',
      projectsIndex: 'projects',
      consumerGroup: 'luwi-realtime-v1',
      globalMaxLength: 100,
      projectMaxLength: 50,
      deadLetterMaxLength: 10,
      relayHealthy: healthy,
    });

    expect(result.globalTrimmed).toBe(false);
    expect(result.globalDeferredReason).toBe(reason);
    expect(client.commands).not.toContainEqual(['XTRIM', 'global', 'MAXLEN', '~', '100']);
  });
});
