import type { AgentMessage } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import {
  claimSessionInbox,
  createRedisKeys,
  SESSION_INBOX_CONSUMER_GROUP,
  type RedisCommandClient,
} from './index.js';

class FakeCommandClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  replies: unknown[] = [];

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    this.commands.push([...arguments_]);
    const reply = this.replies.shift();
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }
}

const timestamp = '2026-07-29T12:00:00.000Z';
const message: AgentMessage = {
  id: 'message-1',
  correlationId: 'correlation-1',
  projectId: 'project-1',
  sourceSessionId: 'source',
  sourceAgentId: 'claude-sim',
  targetSessionId: 'target',
  targetAgentId: 'gemini-sim',
  selectionReason: 'direct target session target',
  kind: 'question',
  content: 'Status?',
  evidenceRequirements: [],
  state: 'queued',
  createdAt: timestamp,
  updatedAt: timestamp,
  deadlineAt: '2026-07-29T12:02:00.000Z',
};

const requestItem = JSON.stringify({
  messageId: 'message-1',
  correlationId: 'correlation-1',
  itemKind: 'request',
  sourceSessionId: 'source',
  targetSessionId: 'target',
  createdAt: timestamp,
  payload: {
    kind: 'question',
    content: 'Status?',
    evidenceRequirements: [],
    deadlineAt: '2026-07-29T12:02:00.000Z',
  },
});

describe('session inbox boundary', () => {
  it('returns recovered pending entries before new entries and leaves requests pending', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      new Error('BUSYGROUP Consumer Group name already exists'),
      ['0-0', [['1-0', ['item', requestItem]]], []],
      {
        [createRedisKeys().sessionInbox('target')]: [['2-0', ['item', requestItem]]],
      },
    ];
    const delivered: string[] = [];

    await expect(
      claimSessionInbox({
        client,
        keys: createRedisKeys(),
        sessionId: 'target',
        bridgeInstanceId: 'bridge_1',
        limit: 2,
        minIdleMs: 0,
        getMessage: async () => message,
        markDelivered: async (correlationId) => {
          delivered.push(correlationId);
        },
      }),
    ).resolves.toMatchObject({
      items: [{ streamId: '1-0' }, { streamId: '2-0' }],
    });
    expect(delivered).toEqual(['correlation-1', 'correlation-1']);
    expect(client.commands.some((command) => command[0] === 'XACK')).toBe(false);
    expect(client.commands[1]?.slice(0, 6)).toEqual([
      'XAUTOCLAIM',
      createRedisKeys().sessionInbox('target'),
      SESSION_INBOX_CONSUMER_GROUP,
      'bridge-bridge_1',
      '0',
      '0-0',
    ]);
    const readGroup = client.commands.find((command) => command[0] === 'XREADGROUP');
    expect(readGroup).toBeDefined();
    expect(readGroup).not.toContain('BLOCK');
  });

  it('acknowledges and skips a terminal request projection', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      new Error('BUSYGROUP Consumer Group name already exists'),
      ['0-0', [['1-0', ['item', requestItem]]], []],
      1,
    ];

    await expect(
      claimSessionInbox({
        client,
        keys: createRedisKeys(),
        sessionId: 'target',
        bridgeInstanceId: 'bridge_1',
        limit: 1,
        minIdleMs: 0,
        getMessage: async () => ({ ...message, state: 'timed_out' }),
        markDelivered: async () => undefined,
      }),
    ).resolves.toEqual({ items: [] });
    expect(client.commands.at(-1)?.slice(0, 3)).toEqual([
      'XACK',
      createRedisKeys().sessionInbox('target'),
      SESSION_INBOX_CONSUMER_GROUP,
    ]);
  });

  it('redelivers recovered processing work without repeating the delivered transition', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      new Error('BUSYGROUP Consumer Group name already exists'),
      ['0-0', [['1-0', ['item', requestItem]]], []],
    ];
    const delivered: string[] = [];

    await expect(
      claimSessionInbox({
        client,
        keys: createRedisKeys(),
        sessionId: 'target',
        bridgeInstanceId: 'bridge_recovered',
        limit: 1,
        minIdleMs: 0,
        getMessage: async () => ({ ...message, state: 'processing' }),
        markDelivered: async (correlationId) => {
          delivered.push(correlationId);
        },
      }),
    ).resolves.toMatchObject({ items: [{ streamId: '1-0' }] });
    expect(delivered).toEqual([]);
    expect(client.commands.some((command) => command[0] === 'XACK')).toBe(false);
  });

  it('acks malformed entries and returns a safe inbox error', async () => {
    const client = new FakeCommandClient();
    client.replies = [
      new Error('BUSYGROUP Consumer Group name already exists'),
      ['0-0', [['1-0', ['item', '{"content":"unbounded-or-malformed"}']]], []],
      1,
    ];

    await expect(
      claimSessionInbox({
        client,
        keys: createRedisKeys(),
        sessionId: 'target',
        bridgeInstanceId: 'bridge_1',
        limit: 1,
        minIdleMs: 0,
        getMessage: async () => null,
        markDelivered: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'INBOX_ENTRY_INVALID' });
  });

  it('acks an envelope whose bounded payload does not match the projection', async () => {
    const client = new FakeCommandClient();
    const forged = requestItem.replace('"content":"Status?"', '"content":"Forged content"');
    client.replies = [
      new Error('BUSYGROUP Consumer Group name already exists'),
      ['0-0', [['1-0', ['item', forged]]], []],
      1,
    ];
    const diagnostics: Array<{ streamId: string; reason: string }> = [];

    await expect(
      claimSessionInbox({
        client,
        keys: createRedisKeys(),
        sessionId: 'target',
        bridgeInstanceId: 'bridge_1',
        limit: 1,
        minIdleMs: 0,
        getMessage: async () => message,
        markDelivered: async () => undefined,
        onInvalidEntry: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      }),
    ).rejects.toMatchObject({ code: 'INBOX_ENTRY_INVALID' });
    expect(diagnostics).toEqual([{ streamId: '1-0', reason: 'projection_mismatch' }]);
  });
});
