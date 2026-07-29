import { randomUUID } from 'node:crypto';

import { createRuntimeEvent } from '@luwi/protocol';
import {
  createManagedRedisConnection,
  ensureRealtimeStreamGroup,
  type ManagedRedisConnection,
  type RedisCommandClient,
} from '@luwi/redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRealtimeRelay } from './realtime-relay.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;

describe.skipIf(testRedisUrl === undefined)('realtime relay integration', () => {
  const namespace = `luwi:test:${randomUUID()}`;
  const stream = `${namespace}:events`;
  const dead = `${namespace}:dead`;
  const poisonStream = `${namespace}:poison-events`;
  const poisonDead = `${namespace}:poison-dead`;
  const group = 'luwi-realtime-v1';
  let client: ManagedRedisConnection;
  let commandClient: RedisCommandClient;

  beforeAll(async () => {
    client = createManagedRedisConnection({ url: testRedisUrl });
    await client.connect();
    commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
    await ensureRealtimeStreamGroup(commandClient, stream, group);
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.sendCommand(['DEL', stream, dead, poisonStream, poisonDead]);
      await client.quit();
    }
  });

  function relay(consumer: string, accept: (message: { streamId: string }) => boolean) {
    return createRealtimeRelay({
      client: commandClient,
      stream,
      group,
      consumer,
      deadLetterStream: dead,
      claimIdleMs: 0,
      blockMs: 1,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept,
      onFailure: vi.fn(),
      now: () => new Date(),
    });
  }

  it('ACKs accepted entries, recovers rejected pending work, and dead-letters malformed data', async () => {
    const event = createRuntimeEvent({
      type: 'project.registered',
      workspaceId: 'local',
      projectId: 'project-1',
      payload: {},
    });
    await client.sendCommand(['XADD', stream, '*', 'event', JSON.stringify(event)]);
    const first = relay('daemon-first', () => true);
    await expect(first.pollOnce()).resolves.toBe(1);
    expect(((await commandClient.sendCommand(['XPENDING', stream, group])) as unknown[])[0]).toBe(
      0,
    );

    await client.sendCommand([
      'XADD',
      stream,
      '*',
      'event',
      JSON.stringify({ ...event, id: randomUUID() }),
    ]);
    const rejecting = relay('daemon-first', () => false);
    await rejecting.pollOnce();
    expect(((await commandClient.sendCommand(['XPENDING', stream, group])) as unknown[])[0]).toBe(
      1,
    );

    const recoveredIds: string[] = [];
    const recovering = relay('daemon-second', ({ streamId }) => {
      recoveredIds.push(streamId);
      return true;
    });
    await recovering.recoverPending();
    expect(recoveredIds).toHaveLength(1);
    expect(((await commandClient.sendCommand(['XPENDING', stream, group])) as unknown[])[0]).toBe(
      0,
    );

    await client.sendCommand(['XADD', stream, '*', 'event', 'malformed-secret']);
    await first.pollOnce();
    await expect(client.sendCommand(['XLEN', dead])).resolves.toBe(1);
    const deadLetters = await client.sendCommand(['XRANGE', dead, '-', '+']);
    expect(JSON.stringify(deadLetters)).not.toContain('malformed-secret');
  });

  it('retries a poison pending entry through XAUTOCLAIM and recovers after dead-letter repair', async () => {
    await ensureRealtimeStreamGroup(commandClient, poisonStream, group);
    await client.sendCommand(['SET', poisonDead, 'wrong-type']);
    await client.sendCommand(['XADD', poisonStream, '*', 'event', 'malformed-secret']);
    const onFailure = vi.fn();
    const poisonRelay = createRealtimeRelay({
      client: commandClient,
      stream: poisonStream,
      group,
      consumer: 'daemon-poison',
      deadLetterStream: poisonDead,
      claimIdleMs: 0,
      blockMs: 1,
      batchSize: 10,
      deadLetterMaxLength: 100,
      accept: vi.fn(),
      onFailure,
      now: () => new Date(),
    });

    await poisonRelay.pollOnce();
    await poisonRelay.recoverPending();
    await expect(poisonRelay.recoverPending()).rejects.toThrow('Poison Runtime event');

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(
      ((await commandClient.sendCommand(['XPENDING', poisonStream, group])) as unknown[])[0],
    ).toBe(1);

    await client.sendCommand(['DEL', poisonDead]);
    await poisonRelay.recoverPending();

    expect(
      ((await commandClient.sendCommand(['XPENDING', poisonStream, group])) as unknown[])[0],
    ).toBe(0);
    await expect(client.sendCommand(['XLEN', poisonDead])).resolves.toBe(1);
  });
});
