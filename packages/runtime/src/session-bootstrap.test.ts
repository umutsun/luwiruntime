import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from './application-error.js';
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
  let currentTimeMs = 0;
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
    maxRetryBackoffMs: 20_000,
    now: () => currentTimeMs,
    onError: (error: unknown) => errors.push(error),
    setInterval: ((callback: () => void, intervalMs: number) => {
      timers.push({ callback, intervalMs });
      return timers.length as unknown as NodeJS.Timeout;
    }) as never,
    clearInterval: (() => undefined) as never,
    ...overrides,
  });
  return {
    bootstrap,
    client,
    timers,
    errors,
    advanceTime(milliseconds: number) {
      currentTimeMs += milliseconds;
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
    let attempts = 0;
    const client = {
      register: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('connect ECONNREFUSED');
        return { id: 'session-recovered' };
      }),
      heartbeat: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const { bootstrap, errors, timers, advanceTime } = harness({ client });

    await expect(bootstrap.start()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(bootstrap.sessionId).toBeUndefined();

    // A missing daemon degrades observation but does not make the bootstrap
    // permanently inert. The same referenced timer retries registration.
    expect(timers).toHaveLength(1);
    advanceTime(5_000);
    timers[0]?.callback();
    await flushAsyncWork();

    expect(client.register).toHaveBeenCalledTimes(2);
    expect(bootstrap.sessionId).toBe('session-recovered');
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
    const { bootstrap, timers, errors, advanceTime } = harness({ client });

    await bootstrap.start();
    advanceTime(5_000);
    timers[0]?.callback();
    await flushAsyncWork();
    advanceTime(5_000);
    timers[0]?.callback();
    await flushAsyncWork();

    expect(beats).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('uses capped exponential backoff for transient heartbeat failures and resets after success', async () => {
    let beats = 0;
    const client = {
      register: vi.fn(async () => ({ id: 'session-1' })),
      heartbeat: vi.fn(async () => {
        beats += 1;
        if (beats === 1 || beats === 2 || beats === 4) throw new Error('temporary');
      }),
      close: vi.fn(async () => undefined),
    };
    const { bootstrap, timers, advanceTime } = harness({
      client,
      maxRetryBackoffMs: 7_000,
    });

    await bootstrap.start();

    advanceTime(5_000);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(1);

    advanceTime(4_999);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(1);

    advanceTime(1);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(2);

    // The second exponential delay would be 10 s, but is capped at 7 s.
    advanceTime(6_999);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(2);
    advanceTime(1);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(3);

    // A success resets the backoff to the base 5 s delay.
    advanceTime(5_000);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(4);
    advanceTime(4_999);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(4);
    advanceTime(1);
    timers[0]?.callback();
    await flushAsyncWork();
    expect(beats).toBe(5);
  });

  it.each(['SESSION_NOT_FOUND', 'SESSION_TERMINAL'])(
    're-registers with the original input after heartbeat reports %s',
    async (code) => {
      let registrations = 0;
      const client = {
        register: vi.fn(async () => {
          registrations += 1;
          return { id: `session-${registrations}` };
        }),
        heartbeat: vi.fn(async () => {
          throw new ApplicationError(code, 'session lost', 409);
        }),
        close: vi.fn(async () => undefined),
      };
      const { bootstrap, timers, advanceTime } = harness({ client });

      await bootstrap.start();
      const originalRequest = client.register.mock.calls[0]?.[0];
      advanceTime(5_000);
      timers[0]?.callback();
      await flushAsyncWork();
      expect(bootstrap.sessionId).toBeUndefined();

      advanceTime(5_000);
      timers[0]?.callback();
      await flushAsyncWork();

      expect(bootstrap.sessionId).toBe('session-2');
      expect(client.register).toHaveBeenCalledTimes(2);
      expect(client.register.mock.calls[1]?.[0]).toEqual(originalRequest);
    },
  );

  it('reports initial registration, recovered identity, and graceful stop', async () => {
    let registrations = 0;
    const changes: unknown[] = [];
    const client = {
      register: vi.fn(async () => {
        registrations += 1;
        return { id: `session-${registrations}` };
      }),
      heartbeat: vi.fn(async () => {
        throw new ApplicationError('SESSION_TERMINAL', 'session lost', 409);
      }),
      close: vi.fn(async () => undefined),
    };
    const { bootstrap, timers, advanceTime } = harness({
      client,
      onSessionChanged: (change: unknown) => changes.push(change),
    });

    await bootstrap.start();
    advanceTime(5_000);
    timers[0]?.callback();
    await flushAsyncWork();
    advanceTime(5_000);
    timers[0]?.callback();
    await flushAsyncWork();
    await bootstrap.stop();

    expect(changes).toEqual([
      { reason: 'registered', sessionId: 'session-1' },
      { reason: 'recovered', previousSessionId: 'session-1', sessionId: 'session-2' },
      { reason: 'stopped', previousSessionId: 'session-2' },
    ]);
  });

  it('reports a session-change observer failure without breaking registration', async () => {
    const observerFailure = new Error('observer failed');
    const { bootstrap, errors, timers } = harness({
      onSessionChanged: () => {
        throw observerFailure;
      },
    });

    await expect(bootstrap.start()).resolves.toBeUndefined();

    expect(bootstrap.sessionId).toBe('session-1');
    expect(timers).toHaveLength(1);
    expect(errors).toContain(observerFailure);
  });

  it('serializes timer work so overlapping ticks cannot duplicate a heartbeat', async () => {
    let resolveHeartbeat: (() => void) | undefined;
    const client = {
      register: vi.fn(async () => ({ id: 'session-1' })),
      heartbeat: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveHeartbeat = resolve;
          }),
      ),
      close: vi.fn(async () => undefined),
    };
    const { bootstrap, timers, advanceTime } = harness({ client });

    await bootstrap.start();
    advanceTime(5_000);
    timers[0]?.callback();
    timers[0]?.callback();
    await Promise.resolve();

    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    resolveHeartbeat?.();
    await flushAsyncWork();
  });

  it('does not resurrect and closes a registration that completes after stop', async () => {
    let resolveRegistration: ((value: { id: string }) => void) | undefined;
    const client = {
      register: vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveRegistration = resolve;
          }),
      ),
      heartbeat: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const { bootstrap, timers } = harness({ client });

    const starting = bootstrap.start();
    await Promise.resolve();
    await bootstrap.stop();
    resolveRegistration?.({ id: 'session-late' });
    await starting;

    expect(bootstrap.sessionId).toBeUndefined();
    expect(timers).toHaveLength(0);
    expect(client.close).toHaveBeenCalledWith('session-late');
  });

  it('rejects retry settings that cannot produce a safe bounded schedule', () => {
    expect(() => harness({ heartbeatIntervalMs: 0 })).toThrow(/heartbeatIntervalMs/);
    expect(() => harness({ maxRetryBackoffMs: 4_999 })).toThrow(/maxRetryBackoffMs/);
  });

  it('does not unref the heartbeat timer, which is what keeps an attached process alive', () => {
    // `unref` is right for a daemon, where other work holds the event loop
    // open, and fatal for `session attach`, where the heartbeat *is* the only
    // thing keeping the process alive. Unreffed, the CLI exited immediately
    // after registering and the session lapsed to `disconnected` 15 s later —
    // observed on the first live run.
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const bootstrap = createSessionBootstrap({
      client: {
        register: vi.fn(async () => ({ id: 'session-1' })),
        heartbeat: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      projectId: 'project-1',
      agentId: 'claude-code',
      workingDirectory: 'C:/work',
      setInterval: (() => timer) as never,
      clearInterval: (() => undefined) as never,
    });

    return bootstrap.start().then(() => {
      expect(unref).not.toHaveBeenCalled();
    });
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
