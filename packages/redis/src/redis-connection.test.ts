import { ErrorReply, TimeoutError } from 'redis';
import { describe, expect, it } from 'vitest';

import { createManagedRedisConnection, type NodeRedisClientLike } from './redis-connection.js';
import { RedisRepositoryError } from './runtime-repository.js';

class FakeNodeRedisClient implements NodeRedisClientLike {
  isOpen = true;
  isReady = true;
  destroyCalls = 0;
  replies: Array<() => Promise<unknown>> = [];

  on(): this {
    return this;
  }
  async connect(): Promise<void> {
    this.isOpen = true;
    this.isReady = true;
  }
  async quit(): Promise<string> {
    return 'OK';
  }
  async disconnect(): Promise<void> {
    this.destroy();
  }
  destroy(): void {
    this.destroyCalls += 1;
    this.isOpen = false;
    this.isReady = false;
  }
  sendCommand(): Promise<unknown> {
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error('no scripted reply');
    return reply();
  }
}

const timeout = () => Promise.reject(new TimeoutError());
const pong = () => Promise.resolve('PONG');

function harness() {
  const client = new FakeNodeRedisClient();
  const errors: Error[] = [];
  let nowMs = 0;
  const connection = createManagedRedisConnection(
    {
      url: 'redis://127.0.0.1:6379',
      stalledAfterMs: 15_000,
      onError: (error) => errors.push(error),
    },
    { createClient: () => client, now: () => nowMs },
  );
  const at = async (ms: number, reply: () => Promise<unknown>) => {
    nowMs = ms;
    client.replies.push(reply);
    return connection.sendCommand(['PING']).catch((error: unknown) => error);
  };
  return { client, errors, at };
}

describe('managed Redis connection stall watchdog', () => {
  it('leaves an isolated command timeout as a timeout and keeps the connection', async () => {
    const { client, errors, at } = harness();

    expect(await at(0, timeout)).toBeInstanceOf(TimeoutError);
    expect(client.destroyCalls).toBe(0);
    expect(errors).toEqual([]);
  });

  it('destroys a connection that has done nothing but time out for the stall window, and reports it once', async () => {
    const { client, errors, at } = harness();

    await at(0, timeout);
    expect(await at(14_999, timeout)).toBeInstanceOf(TimeoutError);
    expect(client.destroyCalls).toBe(0);

    const stalled = await at(15_000, timeout);
    expect(stalled).toBeInstanceOf(RedisRepositoryError);
    expect(stalled).toMatchObject({ code: 'REDIS_UNAVAILABLE' });
    expect(client.destroyCalls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/stalled/i);
  });

  it('restarts the stall window whenever a command completes', async () => {
    const { client, at } = harness();

    await at(0, timeout);
    await expect(at(10_000, pong)).resolves.toBe('PONG');
    await at(16_000, timeout);
    await at(30_999, timeout);
    expect(client.destroyCalls).toBe(0);

    await at(31_000, timeout);
    expect(client.destroyCalls).toBe(1);
  });

  it('treats an error reply as a completed round trip', async () => {
    const { client, at } = harness();

    await at(0, timeout);
    expect(await at(10_000, () => Promise.reject(new ErrorReply('ERR wrong type')))).toBeInstanceOf(
      ErrorReply,
    );
    await at(16_000, timeout);
    expect(client.destroyCalls).toBe(0);
  });

  it('watches the reconnected client afresh after recovery', async () => {
    const { client, errors, at } = harness();

    await at(0, timeout);
    await at(15_000, timeout);
    await client.connect();

    expect(await at(20_000, timeout)).toBeInstanceOf(TimeoutError);
    expect(client.destroyCalls).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
