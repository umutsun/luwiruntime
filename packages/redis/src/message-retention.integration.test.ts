import { randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRedisKeys,
  runMessageRetention,
  SESSION_INBOX_CONSUMER_GROUP,
  type RedisCommandClient,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;

describe.skipIf(testRedisUrl === undefined)('message retention integration', () => {
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const namespace = `luwi:test:${runId}:v1`;
  const keys = createRedisKeys(namespace);
  let client: RedisClientType;
  let commandClient: RedisCommandClient;

  beforeAll(async () => {
    client = createClient({ url: testRedisUrl });
    client.on('error', () => undefined);
    await client.connect();
    commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
  });

  afterAll(async () => {
    if (client?.isOpen) {
      let cursor = '0';
      do {
        const reply = (await commandClient.sendCommand([
          'SCAN',
          cursor,
          'MATCH',
          `${namespace}:*`,
          'COUNT',
          '100',
        ])) as [string, string[]];
        cursor = reply[0];
        if (reply[1].length > 0) {
          await commandClient.sendCommand(['DEL', ...reply[1]]);
        }
      } while (cursor !== '0');
      await client.quit();
    }
  });

  it('keeps pending inbox work and trims only after all entries are recovered', async () => {
    const stream = keys.sessionInbox('session-1');
    await commandClient.sendCommand([
      'XGROUP',
      'CREATE',
      stream,
      SESSION_INBOX_CONSUMER_GROUP,
      '0-0',
      'MKSTREAM',
    ]);
    for (let index = 0; index < 5; index += 1) {
      await commandClient.sendCommand(['XADD', stream, '*', 'item', String(index)]);
    }
    const read = (await commandClient.sendCommand([
      'XREADGROUP',
      'GROUP',
      SESSION_INBOX_CONSUMER_GROUP,
      'bridge-test',
      'COUNT',
      '5',
      'STREAMS',
      stream,
      '>',
    ])) as Record<string, Array<[string, string[]]>>;
    const streamIds = read[stream]?.map(([streamId]) => streamId) ?? [];

    const pending = await runMessageRetention({
      client: commandClient,
      keys,
      nowMs: Date.now(),
      terminalProjectionRetentionMs: 60_000,
      maxInboxLength: 2,
      batchSize: 10,
      sessionIds: ['session-1'],
    });
    expect(pending).toMatchObject({ inboxesTrimmed: 0, inboxesDeferred: 1 });
    await expect(commandClient.sendCommand(['XLEN', stream])).resolves.toBe(5);

    await commandClient.sendCommand(['XACK', stream, SESSION_INBOX_CONSUMER_GROUP, ...streamIds]);
    const trimmed = await runMessageRetention({
      client: commandClient,
      keys,
      nowMs: Date.now(),
      terminalProjectionRetentionMs: 60_000,
      maxInboxLength: 2,
      batchSize: 10,
      sessionIds: ['session-1'],
    });
    expect(trimmed).toMatchObject({ inboxesTrimmed: 1, inboxesDeferred: 0 });
    await expect(commandClient.sendCommand(['XLEN', stream])).resolves.toBe(2);
  });

  it('defers a terminal message for nonterminal or lagging wake work, then prunes both after ACK', async () => {
    const messageId = 'message-with-wake';
    const projectId = 'project-with-wake';
    const correlationId = 'correlation-with-wake';
    await client.hSet(keys.message(messageId), {
      id: messageId,
      correlationId,
      projectId,
      sourceSessionId: 'source-with-wake',
      targetSessionId: 'target-with-wake',
    });
    await client.set(keys.messageCorrelation(correlationId), messageId);
    const oldScore = Date.now() - 60_000;
    for (const index of [
      keys.messagesIndex,
      keys.projectMessages(projectId),
      keys.sourceSessionMessages('source-with-wake'),
      keys.targetSessionMessages('target-with-wake'),
      keys.terminalMessages,
    ]) {
      await client.zAdd(index, { score: oldScore, value: messageId });
    }
    await commandClient.sendCommand([
      'XGROUP',
      'CREATE',
      keys.wakeStream,
      'luwi-wake-v1',
      '0-0',
      'MKSTREAM',
    ]);
    const streamId = await client.xAdd(keys.wakeStream, '*', { wakeIntentId: messageId });
    await client.hSet(keys.wakeIntent(messageId), {
      id: messageId,
      messageId,
      projectId,
      state: 'dispatching',
      streamId,
    });
    for (const index of [
      keys.wakeIntentsIndex,
      keys.projectWakeIntents(projectId),
      keys.wakeIntentDeadlines,
    ]) {
      await client.zAdd(index, { score: oldScore, value: messageId });
    }

    const options = {
      client: commandClient,
      keys,
      nowMs: Date.now(),
      terminalProjectionRetentionMs: 1,
      maxInboxLength: 10,
      batchSize: 10,
      sessionIds: [],
    };
    await expect(runMessageRetention(options)).resolves.toMatchObject({
      projectionsPruned: 0,
      projectionsDeferredForWake: 1,
      deferredWakeIntentIds: [messageId],
    });
    await expect(client.exists(keys.message(messageId))).resolves.toBe(1);

    await client.hSet(keys.wakeIntent(messageId), { state: 'fallback_only' });
    await expect(runMessageRetention(options)).resolves.toMatchObject({
      projectionsPruned: 0,
      projectionsDeferredForWake: 1,
      deferredWakeIntentIds: [messageId],
    });
    await expect(client.xLen(keys.wakeStream)).resolves.toBe(1);

    const delivered = (await commandClient.sendCommand([
      'XREADGROUP',
      'GROUP',
      'luwi-wake-v1',
      'retention-drain',
      'COUNT',
      '1',
      'STREAMS',
      keys.wakeStream,
      '>',
    ])) as Record<string, Array<[string, string[]]>>;
    const deliveredId = delivered[keys.wakeStream]?.[0]?.[0];
    if (deliveredId === undefined) throw new Error('Expected lagging wake Stream work.');
    await commandClient.sendCommand(['XACK', keys.wakeStream, 'luwi-wake-v1', deliveredId]);
    await client.hSet(keys.wakeIntent(messageId), {
      streamAcknowledgedAt: new Date().toISOString(),
    });

    await expect(runMessageRetention(options)).resolves.toMatchObject({
      projectionsPruned: 1,
      projectionsDeferredForWake: 0,
      deferredWakeIntentIds: [],
      wakeIntentsPruned: 1,
    });
    await expect(client.exists(keys.message(messageId))).resolves.toBe(0);
    await expect(client.exists(keys.wakeIntent(messageId))).resolves.toBe(0);
    await expect(client.xLen(keys.wakeStream)).resolves.toBe(0);
    await expect(client.zScore(keys.wakeIntentsIndex, messageId)).resolves.toBeNull();
  });
});
