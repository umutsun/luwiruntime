import { describe, expect, it, vi } from 'vitest';

import { createSessionBootstrap } from './session-bootstrap.js';

/**
 * The lifecycle that decides whether a running agent is visible at all.
 *
 * Presence TTL is 15 s and `disconnected` has no transition out, so a missed
 * heartbeat kills a session id permanently. That makes the failure modes here
 * more important than the happy path, and every one of them is asserted.
 */
function harness(overrides: Record<string, unknown> = {}) {
  const timers: Array<{ callback: () => void; intervalMs: number }> = [];
  const client = {
    register: vi.fn(async () => ({ id: 'session-1' })),
    heartbeat: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const errors: unknown[] = [];
  const bootstrap = createSessionBootstrap({
    client,
    projectId: 'project-1',
    agentId: 'claude-code',
    workingDirectory: 'C:/work',
    heartbeatIntervalMs: 5_000,
    onError: (error: unknown) => errors.push(error),
    setInterval: ((callback: () => void, intervalMs: number) => {
      timers.push({ callback, intervalMs });
      return timers.length as unknown as NodeJS.Timeout;
    }) as never,
    clearInterval: (() => undefined) as never,
    ...overrides,
  });
  return { bootstrap, client, timers, errors };
}

describe('session bootstrap', () => {
  it('registers once and then heartbeats on its own interval', async () => {
    const { bootstrap, client, timers } = harness();

    await bootstrap.start();
    expect(client.register).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);

    // The interval must sit well inside the 15 s presence TTL, or the session
    // lapses between beats.
    expect(timers[0]?.intervalMs).toBeLessThan(15_000);

    timers[0]?.callback();
    timers[0]?.callback();
    await Promise.resolve();
    expect(client.heartbeat).toHaveBeenCalled();
  });

  it('starting twice registers only once', async () => {
    const { bootstrap, client } = harness();

    await bootstrap.start();
    await bootstrap.start();

    expect(client.register).toHaveBeenCalledTimes(1);
  });

  it('declares the native reference it was given', async () => {
    const native = { adapterId: 'claude-code', nativeSessionId: 'abc-123' };
    const { bootstrap, client } = harness({ native });

    await bootstrap.start();

    expect(client.register).toHaveBeenCalledWith(expect.objectContaining({ native }));
  });

  it('registers without a native block when identity could not be resolved', async () => {
    // A vendor whose identity is not resolvable is honestly unattributed. A
    // fabricated binding would attribute its tokens to the wrong session.
    const { bootstrap, client } = harness();

    await bootstrap.start();

    const request = client.register.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['native']).toBeUndefined();
  });

  it('does not throw to the caller when the daemon is down', async () => {
    // LUWI is a coordinator. It must never stop the developer's own tool from
    // starting.
    const client = {
      register: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
      heartbeat: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const { bootstrap, errors, timers } = harness({ client });

    await expect(bootstrap.start()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    // Nothing to heartbeat for, so no timer is armed.
    expect(timers).toHaveLength(0);
  });

  it('keeps beating after a failed heartbeat', async () => {
    // One refused beat is not a lapse; abandoning the session on it would turn
    // a blip into a permanent `disconnected`.
    let beats = 0;
    const client = {
      register: vi.fn(async () => ({ id: 'session-1' })),
      heartbeat: vi.fn(async () => {
        beats += 1;
        if (beats === 1) throw new Error('temporary');
        return undefined;
      }),
      close: vi.fn(async () => undefined),
    };
    const { bootstrap, timers, errors } = harness({ client });

    await bootstrap.start();
    timers[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();
    timers[0]?.callback();
    await Promise.resolve();

    expect(beats).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('closes the session on stop', async () => {
    const { bootstrap, client } = harness();

    await bootstrap.start();
    await bootstrap.stop();

    expect(client.close).toHaveBeenCalledWith('session-1');
  });

  it('stopping before starting does nothing', async () => {
    const { bootstrap, client } = harness();

    await expect(bootstrap.stop()).resolves.toBeUndefined();

    expect(client.close).not.toHaveBeenCalled();
  });

  it('reports a failed close without throwing', async () => {
    // A crash cannot close cleanly either; presence expiry is the backstop and
    // the session goes `disconnected`, which is honest.
    const client = {
      register: vi.fn(async () => ({ id: 'session-1' })),
      heartbeat: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        throw new Error('gone');
      }),
    };
    const { bootstrap, errors } = harness({ client });

    await bootstrap.start();
    await expect(bootstrap.stop()).resolves.toBeUndefined();

    expect(errors.length).toBeGreaterThan(0);
  });

  it('stops beating after stop', async () => {
    const { bootstrap, client, timers } = harness();

    await bootstrap.start();
    await bootstrap.stop();
    timers[0]?.callback();
    await Promise.resolve();

    expect(client.heartbeat).not.toHaveBeenCalled();
  });
});
