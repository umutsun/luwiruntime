import { createClient, TimeoutError } from 'redis';
import { describe, expect, it } from 'vitest';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;

function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Synchronous work, as the daemon's periodic projection does for seconds at a time.
  }
}

describe.skipIf(testRedisUrl === undefined)('node-redis write queue under a blocked loop', () => {
  /**
   * The 2026-09-25 outage: an event-loop block longer than the command timeout let the
   * timers phase time out two still-unwritten commands before the queued write ran. In
   * node-redis 6.1.0 removing the head left the next node pointing back at it, so the
   * second removal left the queue with no head and a stale tail, and every later command
   * timed out unwritten on a healthy socket (redis/node-redis#3320).
   */
  it('keeps writing after queued commands time out behind a blocked loop', async () => {
    const client = createClient({ url: testRedisUrl, commandOptions: { timeout: 50 } });
    client.on('error', () => undefined);
    await client.connect();
    try {
      // Enqueue from a check-phase callback: the write it schedules runs one loop
      // iteration later, after the timers phase has fired both expired timeouts.
      const [first, second] = await new Promise<Promise<unknown>[]>((resolve) =>
        setImmediate(() => {
          const queued = [client.sendCommand(['PING']), client.sendCommand(['PING'])];
          queued.forEach((command) => void command.catch(() => undefined));
          blockEventLoop(150);
          resolve(queued);
        }),
      );
      await expect(first).rejects.toBeInstanceOf(TimeoutError);
      await expect(second).rejects.toBeInstanceOf(TimeoutError);

      await expect(client.sendCommand(['PING'])).resolves.toBe('PONG');
    } finally {
      client.destroy();
    }
  });
});
