import { createRuntimeEvent, type RealtimeEventMessage } from '@luwi/protocol';
import type { RedisCommandClient } from '@luwi/redis';
import { describe, expect, it, vi } from 'vitest';

import { createRealtimeRelay } from './realtime-relay.js';

const event = createRuntimeEvent(
  {
    type: 'project.registered',
    workspaceId: 'local',
    projectId: 'project-1',
    payload: {},
  },
  {
    createId: () => 'event-1',
    now: () => new Date('2026-07-28T12:00:00.000Z'),
  },
);

class ScriptedClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  readonly replies: unknown[] = [];
  failDeadLetter = false;
  handler?: (arguments_: readonly string[]) => unknown | Promise<unknown>;

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    if (this.failDeadLetter && arguments_[0] === 'XADD' && arguments_[1] === 'dead') {
      throw new Error('dead-letter unavailable');
    }
    if (this.handler !== undefined) {
      return this.handler(arguments_);
    }
    return this.replies.shift();
  }
}

describe('realtime relay', () => {
  it('recovers stale pending entries before reading and ACKing new entries', async () => {
    const client = new ScriptedClient();
    client.replies.push(
      [1, '1-0', '1-0', [['old-consumer', '1']]],
      ['0-0', [['1-0', ['event', JSON.stringify(event)]]], []],
      1,
      { events: [['2-0', ['event', JSON.stringify({ ...event, id: 'event-2' })]]] },
      1,
    );
    const accepted: RealtimeEventMessage[] = [];
    const relay = createRealtimeRelay({
      client,
      stream: 'events',
      group: 'group',
      consumer: 'consumer',
      deadLetterStream: 'dead',
      claimIdleMs: 30_000,
      blockMs: 1_000,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept: (message) => {
        accepted.push(message);
        return true;
      },
      onFailure: vi.fn(),
      now: () => new Date('2026-07-28T12:00:01.000Z'),
    });

    await relay.recoverPending();
    await relay.pollOnce();

    expect(accepted.map(({ streamId }) => streamId)).toEqual(['1-0', '2-0']);
    expect(client.commands.map((command) => command[0])).toEqual([
      'XPENDING',
      'XAUTOCLAIM',
      'XACK',
      'XREADGROUP',
      'XACK',
    ]);
  });

  it('leaves a valid event pending when the broadcast queue rejects it', async () => {
    const client = new ScriptedClient();
    client.replies.push({ events: [['3-0', ['event', JSON.stringify(event)]]] });
    const relay = createRealtimeRelay({
      client,
      stream: 'events',
      group: 'group',
      consumer: 'consumer',
      deadLetterStream: 'dead',
      claimIdleMs: 30_000,
      blockMs: 1_000,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept: () => false,
      onFailure: vi.fn(),
      now: () => new Date(),
    });

    await relay.pollOnce();

    expect(client.commands.some((command) => command[0] === 'XACK')).toBe(false);
  });

  it('dead-letters malformed events before ACK and never stores their raw payload', async () => {
    const client = new ScriptedClient();
    client.replies.push({ events: [['4-0', ['event', 'secret=do-not-copy']]] }, '4-1', 1);
    const relay = createRealtimeRelay({
      client,
      stream: 'events',
      group: 'group',
      consumer: 'consumer',
      deadLetterStream: 'dead',
      claimIdleMs: 30_000,
      blockMs: 1_000,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept: vi.fn(),
      onFailure: vi.fn(),
      now: () => new Date('2026-07-28T12:00:01.000Z'),
    });

    await relay.pollOnce();

    const deadLetter = client.commands.find(
      (command) => command[0] === 'XADD' && command[1] === 'dead',
    );
    expect(deadLetter).toBeDefined();
    expect(JSON.stringify(deadLetter)).not.toContain('secret=do-not-copy');
    expect(deadLetter).toContain('issueCodes');
    expect(deadLetter).toContain('runtimeVersion');
    expect(deadLetter).toContain('consumer');
    expect(client.commands.at(-1)?.[0]).toBe('XACK');
  });

  it('periodically revisits pending entries that are initially too young to claim', async () => {
    const client = new ScriptedClient();
    let claimAttempts = 0;
    let acked = false;
    client.handler = async (arguments_) => {
      if (arguments_[0] === 'XPENDING') {
        return acked ? [0, null, null, []] : [1, '5-0', '5-0', [['old-consumer', '1']]];
      }
      if (arguments_[0] === 'XAUTOCLAIM') {
        claimAttempts += 1;
        return claimAttempts === 1
          ? ['0-0', [], []]
          : ['0-0', [['5-0', ['event', JSON.stringify(event)]]], []];
      }
      if (arguments_[0] === 'XREADGROUP') {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return null;
      }
      if (arguments_[0] === 'XACK') {
        acked = true;
      }
      return 1;
    };
    const accepted: string[] = [];
    const relay = createRealtimeRelay({
      client,
      stream: 'events',
      group: 'group',
      consumer: 'consumer',
      deadLetterStream: 'dead',
      claimIdleMs: 30_000,
      blockMs: 1,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept: ({ streamId }) => {
        accepted.push(streamId);
        return true;
      },
      onFailure: vi.fn(),
      now: () => new Date(),
    });

    relay.start();
    await vi.waitFor(() => expect(accepted).toEqual(['5-0']));
    await relay.stop();

    expect(claimAttempts).toBeGreaterThanOrEqual(2);
    expect(client.commands.some((command) => command[0] === 'XACK')).toBe(true);
  });

  it('reclaims poison entries and degrades after three real dead-letter failures', async () => {
    const client = new ScriptedClient();
    client.failDeadLetter = true;
    client.replies.push(
      [1, '5-0', '5-0', [['old-consumer', '1']]],
      ['0-0', [['5-0', ['event', 'bad']]], []],
      [1, '5-0', '5-0', [['consumer', '1']]],
      ['0-0', [['5-0', ['event', 'bad']]], []],
      [1, '5-0', '5-0', [['consumer', '1']]],
      ['0-0', [['5-0', ['event', 'bad']]], []],
    );
    const onFailure = vi.fn();
    const relay = createRealtimeRelay({
      client,
      stream: 'events',
      group: 'group',
      consumer: 'consumer',
      deadLetterStream: 'dead',
      claimIdleMs: 30_000,
      blockMs: 1_000,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept: vi.fn(),
      onFailure,
      now: () => new Date(),
    });

    await relay.recoverPending();
    await relay.recoverPending();
    await expect(relay.recoverPending()).rejects.toThrow('Poison Runtime event');

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(client.commands.filter((command) => command[0] === 'XAUTOCLAIM')).toHaveLength(3);
    expect(client.commands.some((command) => command[0] === 'XACK')).toBe(false);
  });
});

describe('native session events', () => {
  /**
   * The relay validates every entry against the closed event enum and
   * dead-letters what fails. A native event missing from that enum would be
   * written to the Stream and then silently discarded on the way out.
   */
  it('relays a native link event instead of dead-lettering it', async () => {
    const nativeEvent = createRuntimeEvent(
      {
        type: 'session.native.linked',
        workspaceId: 'local',
        projectId: 'project-1',
        agentId: 'codex-main',
        sessionId: 'session-1',
        payload: { bindingId: 'b1', linkId: 'l1' },
      },
      { createId: () => 'event-native-1', now: () => new Date('2026-08-11T00:00:00.000Z') },
    );
    const client = new ScriptedClient();
    client.replies.push({ events: [['4-0', ['event', JSON.stringify(nativeEvent)]]] });
    const delivered: RealtimeEventMessage[] = [];
    const relay = createRealtimeRelay({
      client,
      stream: 'events',
      group: 'group',
      consumer: 'consumer',
      deadLetterStream: 'dead',
      claimIdleMs: 30_000,
      blockMs: 1_000,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept: (message) => {
        delivered.push(message);
        return true;
      },
      onFailure: vi.fn(),
      now: () => new Date(),
    });

    await relay.pollOnce();

    expect(delivered.map((message) => message.event.type)).toEqual(['session.native.linked']);
    expect(client.commands.some((command) => command[1] === 'dead')).toBe(false);
    expect(client.commands.some((command) => command[0] === 'XACK')).toBe(true);
  });
});
