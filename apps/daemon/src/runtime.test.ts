import type { NativeSessionBinding, NativeSessionLink, SessionView } from '@luwi/protocol';
import {
  RedisRepositoryError,
  type DisconnectExpiredSessionInput,
  type ManagedRedisConnection,
  type RuntimeRepository,
} from '@luwi/redis';
import { NATIVE_DECLARATION_MAX_ATTEMPTS } from '@luwi/runtime';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { DaemonConfig } from './config.js';
import {
  createNativeLinkRetentionRepository,
  createPresenceSweeperRepository,
  startDaemon,
} from './runtime.js';
import type { ShutdownSignal, ShutdownSignalListener, SignalSource } from './shutdown.js';

class FailingConnection implements ManagedRedisConnection {
  isOpen = false;
  isReady = false;
  connectCalls = 0;

  on(): this {
    return this;
  }
  async connect(): Promise<void> {
    this.connectCalls += 1;
    throw new Error('Redis unavailable');
  }
  async sendCommand(): Promise<unknown> {
    throw new Error('Redis unavailable');
  }
  async quit(): Promise<string> {
    this.isOpen = false;
    this.isReady = false;
    return 'OK';
  }
  disconnect(): void {
    this.isOpen = false;
    this.isReady = false;
  }
}

class CapturingSignals implements SignalSource {
  readonly listeners = new Map<ShutdownSignal, ShutdownSignalListener>();

  once(signal: ShutdownSignal, listener: ShutdownSignalListener): this {
    this.listeners.set(signal, listener);
    return this;
  }

  off(signal: ShutdownSignal, listener: ShutdownSignalListener): this {
    if (this.listeners.get(signal) === listener) {
      this.listeners.delete(signal);
    }
    return this;
  }
}

const ephemeralConfig: DaemonConfig = {
  host: '127.0.0.1',
  port: 0,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'workspace-1',
};

describe('daemon runtime', () => {
  it('does not open the listener or signal handlers when Redis bootstrap fails', async () => {
    const command = new FailingConnection();
    const admin = new FailingConnection();
    const relay = new FailingConnection();
    const signals = new CapturingSignals();

    await expect(
      startDaemon({
        config: ephemeralConfig,
        logger: false,
        signals,
        connections: { command, admin, relay },
      }),
    ).rejects.toThrow('Redis unavailable');

    expect(command.connectCalls).toBe(1);
    expect(admin.connectCalls).toBe(0);
    expect(relay.connectCalls).toBe(0);
    expect(signals.listeners.size).toBe(0);
  });
});

const lapsingSession: SessionView = {
  id: 'session-1',
  agentId: 'codex-sim',
  projectId: 'project-1',
  status: 'thinking',
  workingDirectory: 'C:/workspace/luwi',
  startedAt: '2026-08-11T09:00:00.000Z',
  lastHeartbeatAt: '2026-08-11T09:00:10.000Z',
  metadata: {},
  presence: 'online',
};

const sweptBinding: NativeSessionBinding = {
  id: 'binding-1',
  adapterId: 'claude-code',
  nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
  kind: 'main',
  openLinkId: 'link-1',
  version: 7,
  linkCount: 1,
  trimmedLinkCount: 0,
  firstLinkedAt: '2026-08-11T09:00:00.000Z',
  lastLinkedAt: '2026-08-11T09:00:00.000Z',
};

const sweptLink: NativeSessionLink = {
  id: 'link-1',
  bindingId: 'binding-1',
  sessionId: 'session-1',
  linkedAt: '2026-08-11T09:00:00.000Z',
};

/**
 * The sweeper adapter is the only presence path that can make a session
 * terminal without a caller, so it is the one most easily left resolving
 * nothing. These tests exercise the adapter directly against a stub runtime,
 * so they prove what the adapter hands to Redis and nothing about what Redis
 * then does with it; whether `session_disconnect` clears `openLinkId` is
 * proven by `native-session.integration.test.ts`, not here.
 */
function sweeperHarness(config: {
  session?: SessionView;
  binding?: NativeSessionBinding;
  link?: NativeSessionLink;
  reverseBindingId?: string;
  conflicts?: number;
}): {
  disconnect: (deadline: { sessionId: string; deadlineMs: number }) => Promise<string>;
  calls: DisconnectExpiredSessionInput[];
  bindingReads: string[];
} {
  const calls: DisconnectExpiredSessionInput[] = [];
  const bindingReads: string[] = [];
  const ids = ['disconnect-event', 'unlinked-event'];
  let conflicts = config.conflicts ?? 0;
  const repository = {
    getSession: async (sessionId: string) =>
      config.session !== undefined && config.session.id === sessionId ? config.session : null,
    getNativeBinding: async (id: string) => {
      bindingReads.push(id);
      return config.binding ?? null;
    },
    getNativeLink: async () => config.link ?? null,
    getSessionNativeBindingId: async () => config.reverseBindingId ?? null,
    findExpiredHeartbeatDeadlines: async () => [],
    disconnectExpiredSession: async (input: DisconnectExpiredSessionInput) => {
      calls.push(input);
      if (conflicts > 0) {
        conflicts -= 1;
        throw new RedisRepositoryError('VERSION_CONFLICT', 'The native binding changed.');
      }
      return {
        status: 'disconnected' as const,
        event: null as never,
        globalStreamId: '1-0',
        projectStreamId: '1-1',
      };
    },
  } as unknown as RuntimeRepository;

  const adapter = createPresenceSweeperRepository({
    repository,
    workspaceId: 'workspace-1',
    createId: () => ids.shift() ?? 'unexpected',
  });

  return {
    disconnect: (deadline) => adapter.disconnectExpiredSession(deadline),
    calls,
    bindingReads,
  };
}

describe('presence sweeper native release', () => {
  it('closes the open native link of a lapsing session', async () => {
    const harness = sweeperHarness({
      session: lapsingSession,
      binding: sweptBinding,
      link: sweptLink,
      reverseBindingId: 'binding-1',
    });

    await expect(harness.disconnect({ sessionId: 'session-1', deadlineMs: 1_000 })).resolves.toBe(
      'disconnected',
    );
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({
      sessionId: 'session-1',
      projectId: 'project-1',
      expectedDeadlineMs: 1_000,
      workspaceId: 'workspace-1',
      native: {
        bindingId: 'binding-1',
        linkId: 'link-1',
        expectedVersion: 7,
        expectedOpenLinkId: 'link-1',
        unlinkedEventId: 'unlinked-event',
      },
    });
  });

  it('takes the unchanged path when the lapsing session holds no binding', async () => {
    const harness = sweeperHarness({ session: lapsingSession });

    await expect(harness.disconnect({ sessionId: 'session-1', deadlineMs: 1_000 })).resolves.toBe(
      'disconnected',
    );
    expect(harness.calls[0]?.native).toBeUndefined();
  });

  it('refuses to disconnect a session whose open link cannot be resolved', async () => {
    const harness = sweeperHarness({
      session: lapsingSession,
      binding: sweptBinding,
      link: { ...sweptLink, sessionId: 'session-2' },
      reverseBindingId: 'binding-1',
    });

    await expect(harness.disconnect({ sessionId: 'session-1', deadlineMs: 1_000 })).rejects.toThrow(
      /native session link/i,
    );
    expect(harness.calls).toHaveLength(0);
  });

  it('re-reads the binding and succeeds on a retried disconnect', async () => {
    const harness = sweeperHarness({
      session: lapsingSession,
      binding: sweptBinding,
      link: sweptLink,
      reverseBindingId: 'binding-1',
      conflicts: NATIVE_DECLARATION_MAX_ATTEMPTS - 1,
    });

    await expect(harness.disconnect({ sessionId: 'session-1', deadlineMs: 1_000 })).resolves.toBe(
      'disconnected',
    );
    expect(harness.calls).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
    // A conflict wrote nothing, so the observation the next attempt decides on
    // has to be read again rather than reused.
    expect(harness.bindingReads).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
  });

  it('gives up quietly on a contended disconnect, with the event ids unchanged', async () => {
    const harness = sweeperHarness({
      session: lapsingSession,
      binding: sweptBinding,
      link: sweptLink,
      reverseBindingId: 'binding-1',
      conflicts: NATIVE_DECLARATION_MAX_ATTEMPTS,
    });

    // The deadline entry survives a conflict, so the next sweep sees this
    // session again. Reporting `unchanged` is what keeps one contended
    // session from aborting the rest of the batch.
    await expect(harness.disconnect({ sessionId: 'session-1', deadlineMs: 1_000 })).resolves.toBe(
      'unchanged',
    );
    expect(harness.calls).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
    for (const call of harness.calls) {
      expect(call.eventId).toBe('disconnect-event');
      expect(call.native?.unlinkedEventId).toBe('unlinked-event');
    }
  });

  it('reports unchanged without reading a binding when the session is gone', async () => {
    const harness = sweeperHarness({ reverseBindingId: 'binding-1' });

    await expect(harness.disconnect({ sessionId: 'session-1', deadlineMs: 1_000 })).resolves.toBe(
      'unchanged',
    );
    expect(harness.calls).toHaveLength(0);
  });
});

/**
 * Retention reaches Redis only through this adapter, so it is the seam where a
 * repository refusal has to become a sweep outcome rather than an exception the
 * retention pass would abort on.
 */
describe('native link retention repository', () => {
  const stubRepository = (overrides: Partial<RuntimeRepository>): RuntimeRepository =>
    ({
      listSessionNativeBindingIds: async () => [],
      getNativeRetentionState: async () => null,
      listOldestNativeLinks: async () => [],
      trimNativeLinks: async () => ({ trimmedCount: 0, version: 1, trimmedLinkCount: 0 }),
      ...overrides,
    }) as unknown as RuntimeRepository;

  it('resolves binding ids from the session reverse index', async () => {
    const seen: string[][] = [];
    const adapter = createNativeLinkRetentionRepository({
      repository: stubRepository({
        listSessionNativeBindingIds: async (sessionIds) => {
          seen.push([...sessionIds]);
          return ['binding-1'];
        },
      }),
    });

    await expect(adapter.listBindingIds(['session-1', 'session-2'])).resolves.toEqual([
      'binding-1',
    ]);
    expect(seen).toEqual([['session-1', 'session-2']]);
  });

  it('reports the binding version, open link and link count', async () => {
    const adapter = createNativeLinkRetentionRepository({
      repository: stubRepository({
        getNativeRetentionState: async () => ({
          binding: { ...sweptBinding, version: 4, openLinkId: 'link-1' },
          linkCount: 9,
        }),
      }),
    });

    await expect(adapter.getRetentionState('binding-1')).resolves.toEqual({
      version: 4,
      openLinkId: 'link-1',
      linkCount: 9,
    });
  });

  it('omits the open link when the binding holds none', async () => {
    const unbound: NativeSessionBinding = { ...sweptBinding };
    delete unbound.openLinkId;
    const adapter = createNativeLinkRetentionRepository({
      repository: stubRepository({
        getNativeRetentionState: async () => ({ binding: unbound, linkCount: 3 }),
      }),
    });

    await expect(adapter.getRetentionState('binding-1')).resolves.toEqual({
      version: 7,
      linkCount: 3,
    });
  });

  it('passes the declared links straight through and reports a trim', async () => {
    const calls: unknown[] = [];
    const adapter = createNativeLinkRetentionRepository({
      repository: stubRepository({
        trimNativeLinks: async (input) => {
          calls.push(input);
          return { trimmedCount: 1, version: 2, trimmedLinkCount: 1 };
        },
      }),
    });

    await expect(
      adapter.trimLinks({
        bindingId: 'binding-1',
        expectedVersion: 1,
        links: [{ id: 'link-1', sessionId: 'session-1' }],
      }),
    ).resolves.toBe('trimmed');
    expect(calls).toEqual([
      {
        bindingId: 'binding-1',
        expectedVersion: 1,
        links: [{ id: 'link-1', sessionId: 'session-1' }],
      },
    ]);
  });

  it('turns a repository version conflict into a conflict outcome', async () => {
    const adapter = createNativeLinkRetentionRepository({
      repository: stubRepository({
        trimNativeLinks: async () => {
          throw new RedisRepositoryError('VERSION_CONFLICT', 'The native binding changed.');
        },
      }),
    });

    await expect(
      adapter.trimLinks({
        bindingId: 'binding-1',
        expectedVersion: 1,
        links: [{ id: 'link-1', sessionId: 'session-1' }],
      }),
    ).resolves.toBe('conflict');
  });

  it('lets any other repository failure escape', async () => {
    const adapter = createNativeLinkRetentionRepository({
      repository: stubRepository({
        trimNativeLinks: async () => {
          throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Corrupt.');
        },
      }),
    });

    await expect(
      adapter.trimLinks({
        bindingId: 'binding-1',
        expectedVersion: 1,
        links: [{ id: 'link-1', sessionId: 'session-1' }],
      }),
    ).rejects.toMatchObject({ code: 'REDIS_DATA_INVALID' });
  });

  /**
   * Retention rides the existing retention interval. A timer of its own would
   * be a second thing to remember to clear on shutdown.
   */
  it('adds no timer of its own to the daemon', () => {
    const source = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
    const timerNames = [...source.matchAll(/(\w+Timer) = setInterval\(/g)].map((match) => match[1]);

    // Native link retention is absent from this list on purpose: it rides the
    // retention tick. The transcript scan is a timer because it reads the
    // filesystem on its own cadence, the way the git scan does.
    expect(timerNames).toEqual([
      'sweepTimer',
      'messageTimeoutTimer',
      'leaseExpiryTimer',
      'retentionTimer',
      'gitScanTimer',
      'transcriptScanTimer',
    ]);
    expect(timerNames).not.toContain('nativeLinkRetentionTimer');
    expect(source).toContain('nativeLinkRetentionSweeper.stop()');
  });

  /**
   * A timer cleared on only one of the two teardown paths leaks past shutdown
   * whenever the other path runs, which is exactly the failure the retention
   * sweeper avoided by not having a timer at all.
   */
  it('clears every timer on both teardown paths', () => {
    const source = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
    const timerNames = [...source.matchAll(/(\w+Timer) = setInterval\(/g)].map((match) => match[1]);

    for (const name of timerNames) {
      const cleared = [...source.matchAll(new RegExp(`clearInterval\\(${name}\\)`, 'g'))];
      expect(cleared, `${name} must be cleared on both teardown paths`).toHaveLength(2);
    }
  });
});
