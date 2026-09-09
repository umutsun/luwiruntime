import type {
  NativeSessionBinding,
  NativeSessionLink,
  SessionView,
  WakeIntentView,
} from '@luwi/protocol';
import {
  createRedisKeys,
  RedisRepositoryError,
  type RedisCommandClient,
  type RuntimeRepository,
  type WakeIntentRepository,
} from '@luwi/redis';
import { describe, expect, it, vi } from 'vitest';

import {
  createWakeIntentService,
  createRedisWakeDispatchEvidence,
  resolveWakeDispatchTarget,
  type WakeDispatchObservation,
} from './wake-intent-service.js';

const sourceSession: SessionView = {
  id: 'session-source',
  agentId: 'codex',
  projectId: 'project-1',
  status: 'idle',
  workingDirectory: 'C:/workspace',
  startedAt: '2026-09-09T12:00:00.000Z',
  lastHeartbeatAt: '2026-09-09T12:00:10.000Z',
  metadata: {},
  presence: 'online',
  wakeCapable: true,
};

const binding: NativeSessionBinding = {
  id: 'binding-1',
  adapterId: 'codex-native-v1',
  nativeSessionId: 'native-thread-1',
  kind: 'main',
  openLinkId: 'link-1',
  version: 2,
  linkCount: 1,
  trimmedLinkCount: 0,
  firstLinkedAt: '2026-09-09T12:00:00.000Z',
  lastLinkedAt: '2026-09-09T12:00:00.000Z',
};

const openLink: NativeSessionLink = {
  id: 'link-1',
  bindingId: 'binding-1',
  sessionId: 'session-source',
  linkedAt: '2026-09-09T12:00:00.000Z',
};

const trustedObservation: WakeDispatchObservation = {
  sourceSession,
  reverseBindingId: 'binding-1',
  binding,
  openLink,
  hostWakeAdapter: 'codex-queue-v1',
  hostWakeMcpSessionId: 'session-source',
  identityProvenanceSource: 'host_launcher',
  launcherInstanceId: 'launcher-1',
  conflicted: false,
};

const claimedIntent: WakeIntentView = {
  id: 'message-1',
  messageId: 'message-1',
  workflowId: 'workflow-1',
  sourceSessionId: 'session-source',
  correlationId: 'correlation-1',
  terminalState: 'responded',
  adapter: 'codex-queue-v1',
  state: 'claimed',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:01.000Z',
};

function serviceHarness(repository: Partial<WakeIntentRepository> = {}) {
  const commandRepository = repository as WakeIntentRepository;
  const claimRepository = {
    ...repository,
    claim: repository.claim ?? vi.fn(),
  } as WakeIntentRepository;
  let ids = 0;
  return {
    service: createWakeIntentService({
      repository: commandRepository,
      claimRepository,
      evidence: { observe: vi.fn().mockResolvedValue(trustedObservation) },
      createId: () => `event-${String((ids += 1))}`,
      now: () => 1_789_000_000_000,
    }),
    claimRepository,
  };
}

describe('resolveWakeDispatchTarget', () => {
  it('returns the private target only for an exact trusted main-session proof', () => {
    expect(resolveWakeDispatchTarget(trustedObservation)).toEqual({
      target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-thread-1' },
    });
  });

  it.each([
    ['missing session', { sourceSession: null }, 'source_session_not_live'],
    [
      'offline session',
      { sourceSession: { ...sourceSession, presence: 'offline' } },
      'source_session_offline',
    ],
    ['missing private host proof', { hostWakeAdapter: null }, 'adapter_mismatch'],
    ['wrong MCP session', { hostWakeMcpSessionId: 'session-other' }, 'mcp_session_mismatch'],
    ['missing reverse index', { reverseBindingId: null }, 'native_binding_stale'],
    ['wrong binding identity', { reverseBindingId: 'binding-other' }, 'native_binding_conflict'],
    ['trimmed binding', { binding: { ...binding, trimmedLinkCount: 1 } }, 'native_binding_trimmed'],
    ['subagent binding', { binding: { ...binding, kind: 'subagent' } }, 'native_subagent'],
    [
      'wrong native adapter',
      { binding: { ...binding, adapterId: 'claude-code' } },
      'native_adapter_mismatch',
    ],
    [
      'closed link',
      { openLink: { ...openLink, unlinkedAt: '2026-09-09T12:00:03.000Z' } },
      'native_binding_stale',
    ],
    [
      'untrusted provenance',
      { identityProvenanceSource: 'filesystem_heuristic' },
      'identity_untrusted',
    ],
    ['read drift', { conflicted: true }, 'native_binding_conflict'],
  ] as const)('refuses %s without returning a native target', (_name, patch, reasonCode) => {
    const result = resolveWakeDispatchTarget({ ...trustedObservation, ...patch });

    expect(result).toEqual({ refusalReasonCode: reasonCode });
    expect(result).not.toHaveProperty('target');
    expect(JSON.stringify(result)).not.toContain('native-thread-1');
  });
});

describe('Redis wake dispatch evidence', () => {
  it('reads retained private host and launcher proof without adding it to public session views', async () => {
    const commands: string[][] = [];
    const client: RedisCommandClient = {
      async sendCommand(command) {
        commands.push([...command]);
        return command[1]?.includes(':session:')
          ? ['codex-queue-v1', 'session-source']
          : ['host_launcher', 'launcher-1'];
      },
    };
    const repository = {
      getSession: vi.fn().mockResolvedValue(sourceSession),
      getSessionNativeBindingId: vi.fn().mockResolvedValue('binding-1'),
      getNativeBinding: vi.fn().mockResolvedValue(binding),
      getNativeLink: vi.fn().mockResolvedValue(openLink),
    } as unknown as RuntimeRepository;
    const evidence = createRedisWakeDispatchEvidence({
      repository,
      client,
      keys: createRedisKeys(),
    });

    await expect(evidence.observe('session-source')).resolves.toEqual(trustedObservation);
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['hostWakeAdapter', 'hostWakeMcpSessionId']),
        expect.arrayContaining(['identityProvenanceSource', 'launcherInstanceId']),
      ]),
    );
    expect(sourceSession).not.toHaveProperty('hostWake');
  });

  it('marks a binding rotation during the two-pass read as conflicted', async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue(sourceSession),
      getSessionNativeBindingId: vi
        .fn()
        .mockResolvedValueOnce('binding-1')
        .mockResolvedValueOnce('binding-2'),
      getNativeBinding: vi
        .fn()
        .mockResolvedValueOnce(binding)
        .mockResolvedValueOnce({ ...binding, id: 'binding-2', version: 3 }),
      getNativeLink: vi.fn().mockResolvedValue(openLink),
    } as unknown as RuntimeRepository;
    const client: RedisCommandClient = {
      async sendCommand(command) {
        return command[1]?.includes(':session:')
          ? ['codex-queue-v1', 'session-source']
          : ['host_launcher', 'launcher-1'];
      },
    };

    const observation = await createRedisWakeDispatchEvidence({
      repository,
      client,
      keys: createRedisKeys(),
    }).observe('session-source');

    expect(observation.conflicted).toBe(true);
    expect(resolveWakeDispatchTarget(observation)).toEqual({
      refusalReasonCode: 'native_binding_conflict',
    });
  });
});

describe('wake intent service', () => {
  it('uses the dedicated claim repository and resolves targets privately', async () => {
    const claim = vi.fn().mockResolvedValue({
      items: [{ intent: claimedIntent, claimId: 'claim-1' }],
      recoveredDispatching: [],
      terminalAcknowledged: 0,
    });
    const { service, claimRepository } = serviceHarness({ claim });

    await expect(
      service.claim({
        dispatcherInstanceId: 'dispatcher-1',
        limit: 1,
        blockMs: 5000,
        minIdleMs: 15000,
      }),
    ).resolves.toEqual({
      items: [
        {
          intent: claimedIntent,
          claimId: 'claim-1',
          target: { adapter: 'codex-queue-v1', nativeSessionId: 'native-thread-1' },
        },
      ],
      recoveredDispatching: [],
      terminalAcknowledged: 0,
    });
    expect(claimRepository.claim).toHaveBeenCalledWith({
      dispatcherInstanceId: 'dispatcher-1',
      limit: 1,
      blockMs: 5000,
    });
  });

  it('returns a bounded inbox-only refusal when target evidence is unavailable', async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue({
        items: [{ intent: claimedIntent, claimId: 'claim-1' }],
        recoveredDispatching: [],
        terminalAcknowledged: 0,
      }),
    } as unknown as WakeIntentRepository;
    const service = createWakeIntentService({
      repository,
      claimRepository: repository,
      evidence: {
        observe: vi.fn().mockResolvedValue({ ...trustedObservation, reverseBindingId: null }),
      },
    });

    const result = await service.claim({
      dispatcherInstanceId: 'dispatcher-1',
      limit: 1,
      blockMs: 0,
      minIdleMs: 15000,
    });

    expect(result.items[0]).toEqual({
      intent: claimedIntent,
      claimId: 'claim-1',
      refusalReasonCode: 'native_binding_stale',
    });
    expect(JSON.stringify(result)).not.toContain('native-thread-1');
  });

  it('uses command Redis for reclaim/recovery and preserves batch counters', async () => {
    const reclaim = vi.fn().mockResolvedValue({
      items: [{ intent: claimedIntent, claimId: 'claim-2' }],
      recoveredDispatching: [
        {
          ...claimedIntent,
          id: 'message-2',
          messageId: 'message-2',
          state: 'indeterminate',
          reasonCode: 'dispatcher_recovered',
        },
      ],
      terminalAcknowledged: 2,
    });
    const { service } = serviceHarness({ reclaim });
    const request = { dispatcherInstanceId: 'dispatcher-2', limit: 5, minIdleMs: 15000 };

    await expect(service.reclaim(request)).resolves.toMatchObject({ terminalAcknowledged: 2 });
    await expect(service.recover(request)).resolves.toMatchObject({ terminalAcknowledged: 2 });
    expect(reclaim).toHaveBeenNthCalledWith(1, request);
    expect(reclaim).toHaveBeenNthCalledWith(2, request);
  });

  it('takes the intent id from the route boundary and mints transition event ids', async () => {
    const get = vi.fn().mockResolvedValue(claimedIntent);
    const markDispatching = vi.fn().mockResolvedValue({
      status: 'updated',
      intent: { ...claimedIntent, state: 'dispatching' },
    });
    const complete = vi.fn().mockResolvedValue({
      status: 'updated',
      intent: { ...claimedIntent, state: 'dispatched', reasonCode: 'queue_accepted' },
    });
    const { service } = serviceHarness({ get, markDispatching, complete });

    await service.markDispatching('message-1', {
      dispatcherInstanceId: 'dispatcher-1',
      claimId: 'claim-1',
      attemptId: 'attempt-1',
    });
    await service.complete('message-1', {
      dispatcherInstanceId: 'dispatcher-1',
      claimId: 'claim-1',
      attemptId: 'attempt-1',
      state: 'dispatched',
      reasonCode: 'queue_accepted',
    });

    expect(markDispatching).toHaveBeenCalledWith({
      intentId: 'message-1',
      dispatcherInstanceId: 'dispatcher-1',
      claimId: 'claim-1',
      attemptId: 'attempt-1',
      eventId: 'event-1',
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'message-1',
        eventId: 'event-2',
      }),
    );
  });

  it('maps missing intents and stale fences to stable HTTP errors', async () => {
    const missing = serviceHarness({ get: vi.fn().mockResolvedValue(null) }).service;
    await expect(
      missing.markDispatching('missing', {
        dispatcherInstanceId: 'dispatcher-1',
        claimId: 'claim-1',
        attemptId: 'attempt-1',
      }),
    ).rejects.toMatchObject({ code: 'WAKE_INTENT_NOT_FOUND', statusCode: 404 });

    const conflict = serviceHarness({
      get: vi.fn().mockResolvedValue(claimedIntent),
      markDispatching: vi
        .fn()
        .mockRejectedValue(new RedisRepositoryError('WAKE_FENCE_MISMATCH', 'private')),
    }).service;
    await expect(
      conflict.markDispatching('message-1', {
        dispatcherInstanceId: 'dispatcher-1',
        claimId: 'stale',
        attemptId: 'attempt-1',
      }),
    ).rejects.toMatchObject({ code: 'WAKE_FENCE_MISMATCH', statusCode: 409 });
  });

  it('lists oldest-first through the repository and runs the bounded deadline sweep', async () => {
    const list = vi.fn().mockResolvedValue([claimedIntent]);
    const sweep = vi.fn().mockResolvedValue({ candidates: 1, fallbackOnly: 1, unchanged: 0 });
    const { service } = serviceHarness({ list, sweep });

    await expect(service.list({ projectId: 'project-1', limit: 10 })).resolves.toEqual([
      claimedIntent,
    ]);
    await expect(service.sweep(25)).resolves.toEqual({
      candidates: 1,
      fallbackOnly: 1,
      unchanged: 0,
    });
    expect(list).toHaveBeenCalledWith({ projectId: 'project-1', limit: 10 });
    expect(sweep).toHaveBeenCalledWith({ nowMs: 1_789_000_000_000, limit: 25 });
  });
});
