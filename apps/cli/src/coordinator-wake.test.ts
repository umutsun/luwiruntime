import type {
  AgentDefinition,
  WakeIntentClaimItem,
  WakeIntentClaimResponse,
  WakeIntentCompleteRequest,
  WakeIntentView,
} from '@luwi/protocol';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  createCoordinatorWakeDispatcher,
  resolveTrustedCodexQueueExecutable,
  wakePointerPrompt,
  type CoordinatorWakeClient,
  type WakeQueueChild,
} from './coordinator-wake.js';
import { WAKE_CONTROL_TOKEN_ENV, WAKE_INSTANCE_ID_ENV } from './wake-lifecycle.js';

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'codex-main',
  kind: 'codex' as const,
  displayName: 'Codex',
  executable: 'C:/measured/codex.exe',
  detectedVersion: 'codex-cli 1.2.3',
  enabled: true,
  adapterId: 'codex',
  nativeConfigRoots: [],
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
  metadata: {},
  ...overrides,
});

const claimedIntent: WakeIntentView & { state: 'claimed' } = {
  id: 'message-1',
  messageId: 'message-1',
  workflowId: 'workflow-1',
  sourceSessionId: 'session-1',
  correlationId: 'correlation-1',
  terminalState: 'responded',
  adapter: 'codex-queue-v1',
  state: 'claimed',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:01.000Z',
};

function claimed(item: WakeIntentClaimItem): WakeIntentClaimResponse {
  return { items: [item], recoveredDispatching: [], terminalAcknowledged: 0 };
}

function wakeClient(response: WakeIntentClaimResponse) {
  const complete = vi.fn(async (_intentId: string, input: WakeIntentCompleteRequest) => ({
    status: 'updated' as const,
    intent: { ...claimedIntent, state: input.state, reasonCode: input.reasonCode },
  }));
  const client: CoordinatorWakeClient = {
    claim: vi.fn(async () => response),
    recover: vi.fn(async () => response),
    markDispatching: vi.fn(async () => ({
      status: 'updated' as const,
      intent: { ...claimedIntent, state: 'dispatching' as const },
    })),
    complete,
  };
  return { client, complete };
}

type TestWakeQueueChild = WakeQueueChild & {
  kill: ReturnType<typeof vi.fn<(_signal?: NodeJS.Signals) => boolean>>;
  unref: ReturnType<typeof vi.fn<() => void>>;
};

function childThat(events: (child: EventEmitter) => void): TestWakeQueueChild {
  const child = new EventEmitter() as EventEmitter & TestWakeQueueChild;
  child.kill = vi.fn(() => true);
  child.unref = vi.fn(() => undefined);
  queueMicrotask(() => events(child));
  return child;
}

describe('coordinator wake dispatcher', () => {
  it('returns only a stable canonical Codex definition whose measured queue probe passes', async () => {
    const listAgentDefinitions = vi.fn(async () => [
      definition(),
      definition({
        id: 'codex-secondary',
        executable: 'C:/measured/secondary-codex.exe',
        detectedVersion: 'codex-cli 9.9.9',
      }),
    ]);
    const probe = vi.fn(async () => true);

    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions,
        expectedAgentId: 'codex-main',
        canonicalize: async () => '/canonical/codex',
        probe,
      }),
    ).resolves.toBe('/canonical/codex');

    expect(listAgentDefinitions).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledExactlyOnceWith('/canonical/codex', 'codex-cli 1.2.3', undefined);
  });

  it('refuses an ambiguous or incomplete enabled Codex definition set before probing', async () => {
    const probe = vi.fn(async () => true);
    for (const definitions of [
      [definition(), definition({ id: 'codex-second' })],
      [definition({ executable: undefined })],
      [definition({ detectedVersion: undefined })],
      [definition({ enabled: false })],
    ]) {
      await expect(
        resolveTrustedCodexQueueExecutable({
          listAgentDefinitions: async () => definitions,
          canonicalize: async () => '/canonical/codex',
          probe,
        }),
      ).resolves.toBeUndefined();
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses a definition or resolved path that changes while its capability is probed', async () => {
    const snapshots = [
      [definition()],
      [definition({ executable: 'C:/replaced/codex.exe', updatedAt: '2026-09-09T12:01:00.000Z' })],
    ];

    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions: async () => snapshots.shift() ?? [],
        canonicalize: async (path) =>
          path.includes('replaced') ? '/canonical/replaced-codex' : '/canonical/codex',
        probe: async () => true,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses an exact definition whose live version and queue support probe fails', async () => {
    const listAgentDefinitions = async () => [definition()];
    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions,
        canonicalize: async () => '/canonical/codex',
        probe: async () => false,
      }),
    ).resolves.toBeUndefined();
  });

  it('treats canonicalization and capability-probe failures as an unavailable local executable', async () => {
    const localFailure = new Error('measured executable disappeared');
    const probe = vi.fn(async () => true);

    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions: async () => [definition()],
        canonicalize: async () => await Promise.reject(localFailure),
        probe,
      }),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();

    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions: async () => [definition()],
        canonicalize: async () => '/canonical/codex',
        probe: async () => await Promise.reject(localFailure),
      }),
    ).resolves.toBeUndefined();
  });

  it('treats second canonicalization failure as a changed local capability', async () => {
    const canonicalize = vi
      .fn<(path: string) => Promise<string>>()
      .mockResolvedValueOnce('/canonical/codex')
      .mockRejectedValueOnce(new Error('measured executable was replaced'));

    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions: async () => [definition()],
        canonicalize,
        probe: async () => true,
      }),
    ).resolves.toBeUndefined();
    expect(canonicalize).toHaveBeenCalledTimes(2);
  });

  it('propagates control-plane definition read failures for durable retry', async () => {
    const daemonFailure = new Error('temporary daemon timeout');

    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions: async () => await Promise.reject(daemonFailure),
        canonicalize: async () => '/canonical/codex',
        probe: async () => true,
      }),
    ).rejects.toBe(daemonFailure);
  });

  it('refuses a Windows command shim that cannot be spawned through the no-shell dispatch path', async () => {
    const probe = vi.fn(async () => true);
    await expect(
      resolveTrustedCodexQueueExecutable({
        listAgentDefinitions: async () => [definition({ executable: 'C:/tools/codex.cmd' })],
        canonicalize: async () => 'C:/tools/codex.cmd',
        probe,
      }),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('sets the durable dispatching fence before the exact no-shell Codex queue command', async () => {
    const order: string[] = [];
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    vi.mocked(client.markDispatching).mockImplementation(async () => {
      order.push('dispatching');
      return {
        status: 'updated',
        intent: { ...claimedIntent, state: 'dispatching' },
      };
    });
    const spawn = vi.fn(() => {
      order.push('spawn');
      return childThat((child) => {
        child.emit('spawn');
        child.emit('exit', 0, null);
      });
    });
    const expectedPrompt = wakePointerPrompt(claimedIntent);
    const resolveQueueExecutable = vi.fn(async () => '/trusted/codex');
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable,
      spawn,
      environment: {
        PATH: 'C:/tools',
        REDIS_URL: 'redis://private',
        LUWI_TEST_REDIS_URL: 'redis://test-private',
        LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS: 'true',
        [WAKE_CONTROL_TOKEN_ENV]: 'private-control-token',
        [WAKE_INSTANCE_ID_ENV]: 'private-instance-id',
      },
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      state: 'dispatched',
      intentId: 'message-1',
    });

    expect(order).toEqual(['dispatching', 'spawn']);
    expect(resolveQueueExecutable).toHaveBeenCalledTimes(2);
    expect(resolveQueueExecutable).toHaveBeenNthCalledWith(1, 'session-1', {
      signal: undefined,
    });
    expect(resolveQueueExecutable).toHaveBeenNthCalledWith(2, 'session-1', {
      signal: undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      '/trusted/codex',
      ['queue', '--thread', 'native-session', '--message', expectedPrompt],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: { PATH: 'C:/tools' },
      }),
    );
    expect(complete).toHaveBeenCalledWith('message-1', {
      dispatcherInstanceId: 'dispatcher-1',
      claimId: 'claim-1',
      attemptId: 'attempt-1',
      state: 'dispatched',
      reasonCode: 'queue_accepted',
    });
    expect(Buffer.byteLength(expectedPrompt, 'utf8')).toBeLessThanOrEqual(1024);
    expect(expectedPrompt).toContain('luwi_get_message');
    expect(expectedPrompt).toContain('correlation-1');
    expect(expectedPrompt).toContain('luwi_continue_workflow');
    expect(expectedPrompt).toContain('message-1');
    expect(expectedPrompt).not.toContain('private-control-token');
  });

  it('falls back before spawn when the trusted executable changes after the dispatch fence', async () => {
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    const resolveQueueExecutable = vi
      .fn<(sourceSessionId: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce('/trusted/codex-a')
      .mockResolvedValueOnce('/trusted/codex-b');
    const spawn = vi.fn();
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable,
      spawn,
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      state: 'fallback_only',
      reasonCode: 'queue_capability_changed',
    });
    expect(client.markDispatching).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({
        state: 'fallback_only',
        reasonCode: 'queue_capability_changed',
      }),
    );
  });

  it('uses inbox-only fallback when no trusted Codex queue executable is available', async () => {
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    const spawn = vi.fn();
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => undefined,
      spawn,
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      state: 'fallback_only',
      reasonCode: 'queue_capability_unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(client.markDispatching).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({
        state: 'fallback_only',
        reasonCode: 'queue_capability_unavailable',
      }),
    );
  });

  it('leaves a safely claimed wake recoverable after a transient pre-fence resolver failure', async () => {
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    const failure = new Error('temporary daemon timeout');
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => await Promise.reject(failure),
      spawn: vi.fn(),
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).rejects.toBe(failure);
    expect(client.markDispatching).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back safely when process creation is proven to fail before spawn', async () => {
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    const spawn = vi.fn(() => childThat((child) => child.emit('error', new Error('ENOENT'))));
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      state: 'fallback_only',
      reasonCode: 'queue_spawn_failed',
    });
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({ state: 'fallback_only', reasonCode: 'queue_spawn_failed' }),
    );
  });

  it('uses the same safe fallback when spawn throws synchronously', async () => {
    const { client } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn: vi.fn(() => {
        throw new Error('ENOENT');
      }),
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      state: 'fallback_only',
      reasonCode: 'queue_spawn_failed',
    });
  });

  it.each([
    [
      'error after spawn',
      (child: EventEmitter) => {
        child.emit('spawn');
        child.emit('error', new Error('lost'));
      },
      'queue_outcome_unknown',
    ],
    [
      'nonzero exit',
      (child: EventEmitter) => {
        child.emit('spawn');
        child.emit('exit', 7, null);
      },
      'queue_exit_nonzero',
    ],
    [
      'signal exit',
      (child: EventEmitter) => {
        child.emit('spawn');
        child.emit('exit', null, 'SIGTERM');
      },
      'queue_signaled',
    ],
  ] as const)('makes %s terminal and indeterminate', async (_name, events, reasonCode) => {
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn: vi.fn(() => childThat(events)),
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      state: 'indeterminate',
      reasonCode,
    });
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({ state: 'indeterminate', reasonCode }),
    );
  });

  it('uses inbox-only fallback without spawning when the daemon refuses a target', async () => {
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        refusalReasonCode: 'identity_untrusted',
      }),
    );
    const spawn = vi.fn();
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await expect(dispatcher.runOnce()).resolves.toMatchObject({
      state: 'fallback_only',
      reasonCode: 'identity_untrusted',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(client.markDispatching).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({ state: 'fallback_only', reasonCode: 'identity_untrusted' }),
    );
  });

  it('recovers stale claims through the same fenced dispatch path', async () => {
    const response = claimed({
      intent: claimedIntent,
      claimId: 'claim-recovered',
      target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
    });
    const { client } = wakeClient(response);
    const spawn = vi.fn(() =>
      childThat((child) => {
        child.emit('spawn');
        child.emit('exit', 0, null);
      }),
    );
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
      randomUUID: () => 'attempt-recovered',
    });

    await expect(dispatcher.recover()).resolves.toMatchObject({ state: 'dispatched' });
    expect(client.recover).toHaveBeenCalledWith({
      dispatcherInstanceId: 'dispatcher-1',
      limit: 1,
      minIdleMs: 15_000,
    });
    expect(client.claim).not.toHaveBeenCalled();
  });

  it('rechecks recovery after a bounded claim wait when work was not idle at startup', async () => {
    const empty = { items: [], recoveredDispatching: [], terminalAcknowledged: 0 };
    const recovered = {
      ...claimedIntent,
      state: 'indeterminate' as const,
      reasonCode: 'dispatcher_recovered',
    };
    let finishClaim!: (response: WakeIntentClaimResponse) => void;
    const pendingClaim = new Promise<WakeIntentClaimResponse>((resolve) => {
      finishClaim = resolve;
    });
    const { client } = wakeClient(empty);
    const order: string[] = [];
    vi.mocked(client.recover)
      .mockImplementationOnce(async () => {
        order.push('recover-empty');
        return empty;
      })
      .mockImplementationOnce(async () => {
        order.push('recover-late');
        return { items: [], recoveredDispatching: [recovered], terminalAcknowledged: 0 };
      })
      .mockImplementationOnce(async () => {
        order.push('recover-drained');
        return empty;
      });
    vi.mocked(client.claim)
      .mockImplementationOnce(async () => {
        order.push('claim-wait');
        return empty;
      })
      .mockImplementationOnce(async () => {
        order.push('claim-stop');
        return pendingClaim;
      });
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      environment: {},
    });

    await dispatcher.start();
    await vi.waitFor(() => expect(order).toContain('claim-stop'));
    const stopping = dispatcher.stop();
    finishClaim(empty);
    await stopping;

    expect(order.slice(0, 4)).toEqual([
      'recover-empty',
      'claim-wait',
      'recover-late',
      'recover-drained',
    ]);
  });

  it('drains every stale recovery page before returning to the blocking claim', async () => {
    const empty = { items: [], recoveredDispatching: [], terminalAcknowledged: 0 };
    const secondIntent = {
      ...claimedIntent,
      id: 'message-2',
      messageId: 'message-2',
      correlationId: 'correlation-2',
    };
    const stale = [
      claimed({
        intent: claimedIntent,
        claimId: 'claim-recovered-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session-1' },
      }),
      claimed({
        intent: secondIntent,
        claimId: 'claim-recovered-2',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session-2' },
      }),
    ];
    let finishClaim!: (response: WakeIntentClaimResponse) => void;
    const pendingClaim = new Promise<WakeIntentClaimResponse>((resolve) => {
      finishClaim = resolve;
    });
    const { client } = wakeClient(empty);
    const order: string[] = [];
    vi.mocked(client.recover)
      .mockImplementationOnce(async () => {
        order.push('recover-1');
        return stale[0]!;
      })
      .mockImplementationOnce(async () => {
        order.push('recover-2');
        return stale[1]!;
      })
      .mockImplementationOnce(async () => {
        order.push('recover-empty');
        return empty;
      });
    vi.mocked(client.claim).mockImplementationOnce(async () => {
      order.push('claim');
      return pendingClaim;
    });
    let attempts = 0;
    const spawn = vi.fn(() =>
      childThat((child) => {
        child.emit('spawn');
        child.emit('exit', 0, null);
      }),
    );
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
      randomUUID: () => `attempt-${String(++attempts)}`,
    });

    await dispatcher.start();
    await vi.waitFor(() => expect(order).toContain('claim'));
    const stopping = dispatcher.stop();
    finishClaim(empty);
    await stopping;

    expect(order).toEqual(['recover-1', 'recover-2', 'recover-empty', 'claim']);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(client.markDispatching).toHaveBeenCalledTimes(2);
  });

  it('revisits an unconfirmed dispatch completion without replaying its process', async () => {
    const empty = { items: [], recoveredDispatching: [], terminalAcknowledged: 0 };
    const item = claimed({
      intent: claimedIntent,
      claimId: 'claim-1',
      target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
    });
    const recovered = {
      ...claimedIntent,
      state: 'indeterminate' as const,
      reasonCode: 'dispatcher_recovered',
    };
    let finishClaim!: (response: WakeIntentClaimResponse) => void;
    const pendingClaim = new Promise<WakeIntentClaimResponse>((resolve) => {
      finishClaim = resolve;
    });
    const { client, complete } = wakeClient(empty);
    complete.mockRejectedValueOnce(new Error('daemon unavailable'));
    vi.mocked(client.recover)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({
        items: [],
        recoveredDispatching: [recovered],
        terminalAcknowledged: 0,
      })
      .mockResolvedValueOnce(empty);
    vi.mocked(client.claim)
      .mockResolvedValueOnce(item)
      .mockResolvedValueOnce(empty)
      .mockImplementationOnce(async () => pendingClaim);
    const spawn = vi.fn(() =>
      childThat((child) => {
        child.emit('spawn');
        child.emit('exit', 0, null);
      }),
    );
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await dispatcher.start();
    await vi.waitFor(() => expect(client.claim).toHaveBeenCalledTimes(3));
    const stopping = dispatcher.stop();
    finishClaim(empty);
    await stopping;

    expect(client.recover).toHaveBeenCalledTimes(4);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('marks a spawned command indeterminate when its bounded outcome timer expires', async () => {
    let expire!: () => void;
    let child!: TestWakeQueueChild;
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn: vi.fn(() => {
        child = childThat((spawned) => {
          spawned.emit('spawn');
        });
        return child;
      }),
      environment: {},
      randomUUID: () => 'attempt-1',
      setTimeout: ((callback: () => void) => {
        expire = callback;
        return 1 as unknown as NodeJS.Timeout;
      }) as never,
      clearTimeout: vi.fn(),
    });

    const run = dispatcher.runOnce();
    await vi.waitFor(() => expect(expire).toBeTypeOf('function'));
    expire();

    await expect(run).resolves.toMatchObject({
      state: 'indeterminate',
      reasonCode: 'queue_timeout',
    });
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({ state: 'indeterminate', reasonCode: 'queue_timeout' }),
    );
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(child.unref).toHaveBeenCalledTimes(1);
    child.emit('exit', 0, null);
    expire();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('marks an active spawned command indeterminate before supervisor shutdown completes', async () => {
    const { client, complete } = wakeClient(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-1',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    vi.mocked(client.claim).mockResolvedValue({
      items: [],
      recoveredDispatching: [],
      terminalAcknowledged: 0,
    });
    let child!: TestWakeQueueChild;
    const spawn = vi.fn(() => {
      child = childThat((spawned) => {
        spawned.emit('spawn');
      });
      return child;
    });
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
      randomUUID: () => 'attempt-1',
    });

    await dispatcher.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await dispatcher.stop();

    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({ state: 'indeterminate', reasonCode: 'dispatcher_stopped' }),
    );
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(child.unref).toHaveBeenCalledTimes(1);
    child.emit('error', new Error('late process error'));
    child.emit('exit', null, 'SIGTERM');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('returns idle for an empty claim without touching the process boundary', async () => {
    const { client } = wakeClient({ items: [], recoveredDispatching: [], terminalAcknowledged: 0 });
    const spawn = vi.fn();
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
    });

    await expect(dispatcher.runOnce()).resolves.toEqual({
      state: 'idle',
      recoveredDispatching: 0,
      terminalAcknowledged: 0,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not spawn work returned by a blocking claim after shutdown begins', async () => {
    let finishClaim!: (response: WakeIntentClaimResponse) => void;
    const pendingClaim = new Promise<WakeIntentClaimResponse>((resolve) => {
      finishClaim = resolve;
    });
    const empty = { items: [], recoveredDispatching: [], terminalAcknowledged: 0 };
    const { client, complete } = wakeClient(empty);
    vi.mocked(client.claim).mockImplementation(async () => pendingClaim);
    const spawn = vi.fn(() =>
      childThat((child) => {
        child.emit('spawn');
        child.emit('exit', 0, null);
      }),
    );
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      spawn,
      environment: {},
      randomUUID: () => 'attempt-stopped',
    });

    await dispatcher.start();
    await vi.waitFor(() => expect(client.claim).toHaveBeenCalledTimes(1));
    const stopping = dispatcher.stop();
    finishClaim(
      claimed({
        intent: claimedIntent,
        claimId: 'claim-stopped',
        target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-session' },
      }),
    );
    await stopping;

    expect(spawn).not.toHaveBeenCalled();
    expect(client.markDispatching).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({
        state: 'fallback_only',
        reasonCode: 'dispatcher_stopped_before_spawn',
      }),
    );
  });

  it('aborts an active blocking claim before shutdown joins the loop', async () => {
    let finishClaim!: (response: WakeIntentClaimResponse) => void;
    let claimSignal: AbortSignal | undefined;
    const pendingClaim = new Promise<WakeIntentClaimResponse>((resolve) => {
      finishClaim = resolve;
    });
    const empty = { items: [], recoveredDispatching: [], terminalAcknowledged: 0 };
    const { client } = wakeClient(empty);
    vi.mocked(client.claim).mockImplementation(async (_input, options) => {
      claimSignal = options?.signal;
      return pendingClaim;
    });
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async () => '/trusted/codex',
      environment: {},
    });

    await dispatcher.start();
    await vi.waitFor(() => expect(client.claim).toHaveBeenCalledTimes(1));
    const stopping = dispatcher.stop();
    finishClaim(empty);
    await stopping;

    expect(claimSignal?.aborted).toBe(true);
  });

  it('aborts source-session executable resolution during dispatcher shutdown', async () => {
    const item = {
      intent: claimedIntent,
      claimId: 'claim-1',
      target: { adapter: 'codex-queue-v1' as const, nativeSessionId: 'native-session' },
    };
    const empty = { items: [], recoveredDispatching: [], terminalAcknowledged: 0 };
    const { client, complete } = wakeClient(empty);
    vi.mocked(client.recover).mockResolvedValue(empty);
    vi.mocked(client.claim).mockResolvedValue(claimed(item));
    let resolverSignal: AbortSignal | undefined;
    let resolutionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolutionStarted = resolve;
    });
    const dispatcher = createCoordinatorWakeDispatcher({
      client,
      dispatcherInstanceId: 'dispatcher-1',
      resolveQueueExecutable: async (_sourceSessionId, options) => {
        resolverSignal = options?.signal;
        resolutionStarted();
        return await new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        });
      },
      environment: {},
      wait: async () => undefined,
    });

    await dispatcher.start();
    await started;
    await dispatcher.stop();

    expect(resolverSignal?.aborted).toBe(true);
    expect(complete).toHaveBeenCalledWith(
      'message-1',
      expect.objectContaining({
        state: 'fallback_only',
        reasonCode: 'dispatcher_stopped_before_spawn',
      }),
    );
  });
});
