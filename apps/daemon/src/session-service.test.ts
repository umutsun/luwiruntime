import type {
  AgentSession,
  NativeSessionBinding,
  NativeSessionLink,
  NativeSessionRef,
  SessionRegistrationRequest,
  SessionView,
} from '@luwi/protocol';
import {
  RedisRepositoryError,
  type CloseSessionInput,
  type DeclareNativeSessionInput,
  type DeclareNativeSessionResult,
  type RegisterSessionInput,
  type RegisterSessionResult,
  type RuntimeRepository,
  type UpdateSessionStatusInput,
  type UpdateSessionStatusResult,
} from '@luwi/redis';
import {
  deriveNativeBindingId,
  deriveNativeLinkId,
  NATIVE_DECLARATION_MAX_ATTEMPTS,
} from '@luwi/runtime';
import { describe, expect, it } from 'vitest';

import { createSessionService } from './session-service.js';

const baseSession: AgentSession = {
  id: 'session-1',
  agentId: 'codex-sim',
  projectId: 'project-1',
  status: 'starting',
  workingDirectory: 'C:/workspace/luwi',
  startedAt: '2026-07-28T12:00:00.000Z',
  lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
  metadata: { source: 'test' },
};

const view: SessionView = { ...baseSession, presence: 'online' };

function repository(options?: {
  register?: RegisterSessionResult;
  update?: UpdateSessionStatusResult;
}): RuntimeRepository {
  return {
    registerProject: async () => ({ status: 'conflict', reason: 'hash_collision' }),
    getProject: async (projectId) =>
      projectId === 'project-1'
        ? {
            id: 'project-1',
            name: 'LUWI',
            localPath: 'C:/workspace/luwi',
            canonicalPath: 'C:/workspace/luwi',
            createdAt: '2026-07-28T12:00:00.000Z',
            updatedAt: '2026-07-28T12:00:00.000Z',
          }
        : null,
    listProjects: async () => [],
    updateProject: async () => ({ status: 'not_found' }),
    registerSession: async () =>
      options?.register ?? {
        status: 'created',
        session: baseSession,
        event: {
          id: 'event-1',
          version: 1,
          type: 'session.registered',
          occurredAt: '2026-07-28T12:00:00.000Z',
          workspaceId: 'local',
          projectId: 'project-1',
          agentId: 'codex-sim',
          sessionId: 'session-1',
          payload: {},
        },
        globalStreamId: '1-0',
        projectStreamId: '1-1',
      },
    getSession: async (sessionId) => (sessionId === 'session-1' ? view : null),
    listSessions: async () => [view],
    updateSessionStatus: async () =>
      options?.update ?? {
        status: 'unchanged',
        currentStatus: 'starting',
      },
    heartbeatSession: async () => ({
      status: 'renewed',
      eventEmitted: false,
      lastHeartbeatAt: '2026-07-28T12:00:01.000Z',
    }),
    closeSession: async () => ({ status: 'unchanged', currentStatus: 'completed' }),
    findExpiredHeartbeatDeadlines: async () => [],
    disconnectExpiredSession: async () => ({ status: 'unchanged' }),
    // No reverse index: this session has no native binding, so the terminal
    // paths take the unchanged 5-key form.
    getSessionNativeBindingId: async () => null,
    getNativeBinding: async () => null,
    getNativeLink: async () => null,
  };
}

describe('session service', () => {
  it('registers an unseen opaque agent without requiring an AgentDefinition', async () => {
    let registration: unknown;
    const backing = repository();
    const service = createSessionService({
      repository: {
        ...backing,
        registerSession: async (input) => {
          registration = input;
          return backing.registerSession(input);
        },
      },
      workspaceId: 'local',
      presenceTtlMs: 15_000,
      createId: (() => {
        const values = ['session-1', 'event-1'];
        return () => values.shift() ?? 'unexpected';
      })(),
      canonicalizeWorkingDirectory: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/real/luwi',
        identityPath: 'c:/workspace/real/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
    });
    const request: SessionRegistrationRequest = {
      projectId: 'project-1',
      agentId: 'codex-sim',
      workingDirectory: '.',
      metadata: { z: 1, a: 2 },
    };

    await expect(service.register(request)).resolves.toEqual(view);
    expect(registration).toMatchObject({
      session: {
        id: 'session-1',
        agentId: 'codex-sim',
        workingDirectory: 'C:/workspace/real/luwi',
        metadataJson: '{"a":2,"z":1}',
      },
      presenceTtlMs: 15_000,
    });
  });

  it('canonicalizes heartbeat metadata and maps graceful close/terminal outcomes', async () => {
    let metadataJson: string | undefined;
    const backing = repository();
    const service = createSessionService({
      repository: {
        ...backing,
        heartbeatSession: async (input) => {
          metadataJson = input.metadataJson;
          return {
            status: 'renewed',
            eventEmitted: false,
            lastHeartbeatAt: '2026-07-28T12:00:01.000Z',
          };
        },
      },
      workspaceId: 'local',
      presenceTtlMs: 15_000,
      heartbeatEventIntervalMs: 30_000,
      createId: () => 'event-id',
      canonicalizeWorkingDirectory: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/luwi',
        identityPath: 'c:/workspace/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
    });

    await expect(service.heartbeat('session-1', { metadata: { z: 1, a: 2 } })).resolves.toEqual({
      status: 'renewed',
      eventEmitted: false,
    });
    expect(metadataJson).toBe('{"a":2,"z":1}');
    await expect(service.close('session-1')).resolves.toMatchObject({
      status: 'starting',
    });
  });

  it('maps missing projects and terminal transitions to safe application errors', async () => {
    const service = createSessionService({
      repository: repository({
        update: { status: 'terminal', currentStatus: 'completed' },
      }),
      workspaceId: 'local',
      presenceTtlMs: 15_000,
      createId: () => 'id',
      canonicalizeWorkingDirectory: async () => ({
        localPath: 'C:/workspace/luwi',
        canonicalPath: 'C:/workspace/luwi',
        identityPath: 'c:/workspace/luwi',
        pathIdentityHash: 'a'.repeat(64),
      }),
    });

    await expect(
      service.register({
        projectId: 'missing',
        agentId: 'codex-sim',
        workingDirectory: '.',
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    await expect(service.updateStatus('session-1', 'idle')).rejects.toMatchObject({
      code: 'SESSION_TERMINAL',
      statusCode: 409,
    });
  });
});

const nativeRef: NativeSessionRef = {
  adapterId: 'claude-code',
  nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
};
const bindingId = deriveNativeBindingId(nativeRef);
const linkId = deriveNativeLinkId(bindingId, 'session-1');
const foreignLinkId = deriveNativeLinkId(bindingId, 'session-2');

const holder: SessionView = {
  ...baseSession,
  id: 'session-2',
  status: 'thinking',
  presence: 'online',
};
const terminalHolder: SessionView = {
  ...baseSession,
  id: 'session-2',
  status: 'completed',
  presence: 'offline',
};

function nativeBinding(overrides: Partial<NativeSessionBinding> = {}): NativeSessionBinding {
  return {
    id: bindingId,
    adapterId: nativeRef.adapterId,
    nativeSessionId: nativeRef.nativeSessionId,
    kind: 'main',
    version: 4,
    linkCount: 1,
    trimmedLinkCount: 0,
    firstLinkedAt: '2026-07-28T11:00:00.000Z',
    lastLinkedAt: '2026-07-28T11:00:00.000Z',
    ...overrides,
  };
}

function nativeLink(overrides: Partial<NativeSessionLink> = {}): NativeSessionLink {
  return {
    id: linkId,
    bindingId,
    sessionId: 'session-1',
    linkedAt: '2026-07-28T11:00:00.000Z',
    ...overrides,
  };
}

function idSequence(values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index] ?? `unexpected-${index}`;
    index += 1;
    return value;
  };
}

function versionConflict(): RedisRepositoryError {
  return new RedisRepositoryError('VERSION_CONFLICT', 'The native binding changed.');
}

/**
 * A stub runtime whose native reads are fixed and whose three writing
 * transitions can be made to lose a compare-and-set a chosen number of times.
 * Every call is recorded, because what these tests assert is the payload the
 * service builds and how many attempts it makes — not what Lua then does.
 */
function nativeHarness(config: {
  binding?: NativeSessionBinding;
  link?: NativeSessionLink;
  linkedSession?: SessionView;
  /** What getSession returns for `session-1`; the online starting view otherwise. */
  caller?: SessionView | null;
  reverseBindingId?: string;
  registerConflicts?: number;
  statusConflicts?: number;
  closeConflicts?: number;
  declareConflicts?: number;
  declareResult?: DeclareNativeSessionResult;
  ids?: string[];
}): {
  service: ReturnType<typeof createSessionService>;
  registrations: RegisterSessionInput[];
  statusUpdates: UpdateSessionStatusInput[];
  closes: CloseSessionInput[];
  declares: DeclareNativeSessionInput[];
  bindingReads: string[];
} {
  const registrations: RegisterSessionInput[] = [];
  const statusUpdates: UpdateSessionStatusInput[] = [];
  const closes: CloseSessionInput[] = [];
  const declares: DeclareNativeSessionInput[] = [];
  const bindingReads: string[] = [];
  let registerConflicts = config.registerConflicts ?? 0;
  let statusConflicts = config.statusConflicts ?? 0;
  let closeConflicts = config.closeConflicts ?? 0;
  let declareConflicts = config.declareConflicts ?? 0;
  const backing = repository();

  const service = createSessionService({
    repository: {
      ...backing,
      getSession: async (sessionId) => {
        if (sessionId === 'session-1') return config.caller === undefined ? view : config.caller;
        return config.linkedSession?.id === sessionId ? config.linkedSession : null;
      },
      getNativeBinding: async (id) => {
        bindingReads.push(id);
        return config.binding ?? null;
      },
      getNativeLink: async () => config.link ?? null,
      getSessionNativeBindingId: async () => config.reverseBindingId ?? null,
      registerSession: async (input) => {
        registrations.push(input);
        if (registerConflicts > 0) {
          registerConflicts -= 1;
          throw versionConflict();
        }
        return backing.registerSession(input);
      },
      declareNativeSession: async (input) => {
        declares.push(input);
        if (declareConflicts > 0) {
          declareConflicts -= 1;
          throw versionConflict();
        }
        return (
          config.declareResult ?? {
            status: 'declared',
            native: {
              transition: 'created',
              binding: nativeBinding({ openLinkId: linkId, version: 1 }),
              link: nativeLink(),
            },
            events: [],
          }
        );
      },
      updateSessionStatus: async (input) => {
        statusUpdates.push(input);
        if (statusConflicts > 0) {
          statusConflicts -= 1;
          throw versionConflict();
        }
        return { status: 'unchanged', currentStatus: 'completed' };
      },
      closeSession: async (input) => {
        closes.push(input);
        if (closeConflicts > 0) {
          closeConflicts -= 1;
          throw versionConflict();
        }
        return { status: 'unchanged', currentStatus: 'completed' };
      },
    },
    workspaceId: 'local',
    presenceTtlMs: 15_000,
    createId: idSequence(
      config.ids ?? ['session-1', 'registration-event', 'linked-event', 'unlinked-event'],
    ),
    canonicalizeWorkingDirectory: async () => ({
      localPath: 'C:/workspace/luwi',
      canonicalPath: 'C:/workspace/luwi',
      identityPath: 'c:/workspace/luwi',
      pathIdentityHash: 'a'.repeat(64),
    }),
  });

  return { service, registrations, statusUpdates, closes, declares, bindingReads };
}

const declaration: SessionRegistrationRequest = {
  projectId: 'project-1',
  agentId: 'codex-sim',
  workingDirectory: '.',
  metadata: {},
  native: nativeRef,
};

describe('native session declaration', () => {
  it('declares a new binding when the reference is free', async () => {
    const harness = nativeHarness({});

    await expect(harness.service.register(declaration)).resolves.toEqual(view);
    expect(harness.registrations).toHaveLength(1);
    expect(harness.registrations[0]?.native).toEqual({
      bindingId,
      linkId,
      linkedEventId: 'linked-event',
      payload: {
        bindingId,
        expectedVersion: 0,
        link: { id: linkId, sessionId: 'session-1' },
        binding: {
          id: bindingId,
          adapterId: 'claude-code',
          nativeSessionId: nativeRef.nativeSessionId,
          kind: 'main',
        },
      },
    });
  });

  it('links over a stale link when the previous holder is terminal', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: foreignLinkId }),
      link: nativeLink({ id: foreignLinkId, sessionId: 'session-2' }),
      linkedSession: terminalHolder,
    });

    await expect(harness.service.register(declaration)).resolves.toEqual(view);
    expect(harness.registrations[0]?.native).toEqual({
      bindingId,
      linkId,
      staleLinkId: foreignLinkId,
      linkedEventId: 'linked-event',
      unlinkedEventId: 'unlinked-event',
      payload: {
        bindingId,
        expectedVersion: 4,
        expectedOpenLinkId: foreignLinkId,
        staleLinkId: foreignLinkId,
        link: { id: linkId, sessionId: 'session-1' },
      },
    });
  });

  it('refuses a live holder with NATIVE_SESSION_CONFLICT and never calls registerSession', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: foreignLinkId }),
      link: nativeLink({ id: foreignLinkId, sessionId: 'session-2' }),
      linkedSession: holder,
    });

    await expect(harness.service.register(declaration)).rejects.toMatchObject({
      code: 'NATIVE_SESSION_CONFLICT',
      statusCode: 409,
    });
    expect(harness.registrations).toHaveLength(0);
  });

  it('refuses with NATIVE_BINDING_INCONSISTENT when the open link cannot be read', async () => {
    const harness = nativeHarness({ binding: nativeBinding({ openLinkId: foreignLinkId }) });

    await expect(harness.service.register(declaration)).rejects.toMatchObject({
      code: 'NATIVE_BINDING_INCONSISTENT',
      statusCode: 409,
    });
    expect(harness.registrations).toHaveLength(0);
  });

  it('refuses with NATIVE_BINDING_INCONSISTENT when the open link record disagrees with the binding', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: foreignLinkId }),
      // The record read at `openLinkId` names a different link, so the only
      // statement of who holds this identity contradicts itself.
      link: nativeLink({ id: 'some-other-link', sessionId: 'session-2' }),
      linkedSession: terminalHolder,
    });

    await expect(harness.service.register(declaration)).rejects.toMatchObject({
      code: 'NATIVE_BINDING_INCONSISTENT',
      statusCode: 409,
    });
    expect(harness.registrations).toHaveLength(0);
  });

  it('refuses with NATIVE_BINDING_INCONSISTENT when the open link belongs to another binding', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: foreignLinkId }),
      link: nativeLink({ id: foreignLinkId, bindingId: 'other-binding', sessionId: 'session-2' }),
      linkedSession: terminalHolder,
    });

    await expect(harness.service.register(declaration)).rejects.toMatchObject({
      code: 'NATIVE_BINDING_INCONSISTENT',
      statusCode: 409,
    });
    expect(harness.registrations).toHaveLength(0);
  });

  it('retries a version conflict and gives up as NATIVE_BINDING_CONTENDED', async () => {
    const harness = nativeHarness({ registerConflicts: NATIVE_DECLARATION_MAX_ATTEMPTS });

    await expect(harness.service.register(declaration)).rejects.toMatchObject({
      code: 'NATIVE_BINDING_CONTENDED',
      statusCode: 409,
    });
    expect(harness.registrations).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
    // The binding is re-read on every attempt, because a conflict means the
    // observation the decision rested on is no longer the one that won.
    expect(harness.bindingReads).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
  });

  it('keeps the session id and the event ids stable across retries', async () => {
    const harness = nativeHarness({ registerConflicts: NATIVE_DECLARATION_MAX_ATTEMPTS - 1 });

    await expect(harness.service.register(declaration)).resolves.toEqual(view);
    expect(harness.registrations).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
    const identities = harness.registrations.map((input) => ({
      sessionId: input.session.id,
      eventId: input.eventId,
      linkedEventId: input.native?.linkedEventId,
      linkId: input.native?.linkId,
    }));
    expect(identities).toEqual([identities[0], identities[0], identities[0]]);
    expect(identities[0]).toEqual({
      sessionId: 'session-1',
      eventId: 'registration-event',
      linkedEventId: 'linked-event',
      linkId,
    });
  });

  it('registers with no native payload when no reference is supplied', async () => {
    const harness = nativeHarness({});

    await expect(
      harness.service.register({
        projectId: 'project-1',
        agentId: 'codex-sim',
        workingDirectory: '.',
        metadata: {},
      }),
    ).resolves.toEqual(view);
    expect(harness.registrations[0]?.native).toBeUndefined();
    expect(harness.bindingReads).toHaveLength(0);
  });
});

describe('native declaration for a registered session', () => {
  const declareIds = ['linked-event', 'unlinked-event'];

  it('creates the binding for a live session and returns the created outcome', async () => {
    const harness = nativeHarness({ ids: declareIds });

    await expect(harness.service.declareNative('session-1', nativeRef)).resolves.toEqual({
      outcome: 'created',
      binding: nativeBinding({ openLinkId: linkId, version: 1 }),
      link: nativeLink(),
    });
    expect(harness.declares).toHaveLength(1);
    expect(harness.declares[0]).toEqual({
      sessionId: 'session-1',
      projectId: 'project-1',
      workspaceId: 'local',
      native: {
        bindingId,
        linkId,
        linkedEventId: 'linked-event',
        payload: {
          bindingId,
          expectedVersion: 0,
          link: { id: linkId, sessionId: 'session-1' },
          binding: {
            id: bindingId,
            adapterId: 'claude-code',
            nativeSessionId: nativeRef.nativeSessionId,
            kind: 'main',
          },
        },
      },
    });
  });

  /** D3: re-declaration is the steady state, not an error — and not a write. */
  it('returns unchanged without writing when the open link already names this session', async () => {
    const binding = nativeBinding({ openLinkId: linkId });
    const link = nativeLink();
    const harness = nativeHarness({ binding, link, ids: declareIds });

    await expect(harness.service.declareNative('session-1', nativeRef)).resolves.toEqual({
      outcome: 'unchanged',
      binding,
      link,
    });
    expect(harness.declares).toHaveLength(0);
  });

  it('refuses a live holder with NATIVE_SESSION_CONFLICT and writes nothing', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: foreignLinkId }),
      link: nativeLink({ id: foreignLinkId, sessionId: 'session-2' }),
      linkedSession: holder,
      ids: declareIds,
    });

    await expect(harness.service.declareNative('session-1', nativeRef)).rejects.toMatchObject({
      code: 'NATIVE_SESSION_CONFLICT',
      statusCode: 409,
    });
    expect(harness.declares).toHaveLength(0);
  });

  it('refuses with NATIVE_BINDING_INCONSISTENT when the open link cannot be read', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: foreignLinkId }),
      ids: declareIds,
    });

    await expect(harness.service.declareNative('session-1', nativeRef)).rejects.toMatchObject({
      code: 'NATIVE_BINDING_INCONSISTENT',
      statusCode: 409,
    });
    expect(harness.declares).toHaveLength(0);
  });

  it('refuses a terminal session before reading the binding at all', async () => {
    const harness = nativeHarness({
      caller: { ...view, status: 'completed', presence: 'offline' },
      ids: declareIds,
    });

    await expect(harness.service.declareNative('session-1', nativeRef)).rejects.toMatchObject({
      code: 'SESSION_TERMINAL',
      statusCode: 409,
    });
    expect(harness.declares).toHaveLength(0);
    expect(harness.bindingReads).toHaveLength(0);
  });

  it('rejects an unknown session with SESSION_NOT_FOUND', async () => {
    const harness = nativeHarness({ caller: null, ids: declareIds });

    await expect(harness.service.declareNative('session-1', nativeRef)).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
    expect(harness.declares).toHaveLength(0);
  });

  it('links over a stale holder and reports the closed link', async () => {
    const staleLink = nativeLink({
      id: foreignLinkId,
      sessionId: 'session-2',
      unlinkedAt: '2026-08-17T00:00:00.000Z',
    });
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: foreignLinkId }),
      link: nativeLink({ id: foreignLinkId, sessionId: 'session-2' }),
      linkedSession: terminalHolder,
      declareResult: {
        status: 'declared',
        native: {
          transition: 'linked',
          binding: nativeBinding({ openLinkId: linkId, version: 6, linkCount: 2 }),
          link: nativeLink(),
          staleLink,
        },
        events: [],
      },
      ids: declareIds,
    });

    await expect(harness.service.declareNative('session-1', nativeRef)).resolves.toEqual({
      outcome: 'linked',
      binding: nativeBinding({ openLinkId: linkId, version: 6, linkCount: 2 }),
      link: nativeLink(),
      staleLink,
    });
    expect(harness.declares[0]?.native.payload).toMatchObject({
      expectedVersion: 4,
      expectedOpenLinkId: foreignLinkId,
      staleLinkId: foreignLinkId,
    });
    expect(harness.declares[0]?.native.unlinkedEventId).toBe('unlinked-event');
  });

  it('retries contention with stable ids and gives up as NATIVE_BINDING_CONTENDED', async () => {
    const harness = nativeHarness({
      declareConflicts: NATIVE_DECLARATION_MAX_ATTEMPTS,
      ids: declareIds,
    });

    await expect(harness.service.declareNative('session-1', nativeRef)).rejects.toMatchObject({
      code: 'NATIVE_BINDING_CONTENDED',
      statusCode: 409,
    });
    expect(harness.declares).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
    // The binding is re-read on every attempt, and the minted identities never
    // change: a retry that minted fresh ids could link twice.
    expect(harness.bindingReads).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
    const identities = harness.declares.map((input) => ({
      linkId: input.native.linkId,
      linkedEventId: input.native.linkedEventId,
    }));
    expect(identities).toEqual([identities[0], identities[0], identities[0]]);
    expect(identities[0]).toEqual({ linkId, linkedEventId: 'linked-event' });
  });

  it('maps a repository terminal race to SESSION_TERMINAL', async () => {
    const harness = nativeHarness({
      declareResult: { status: 'terminal', currentStatus: 'completed' },
      ids: declareIds,
    });

    await expect(harness.service.declareNative('session-1', nativeRef)).rejects.toMatchObject({
      code: 'SESSION_TERMINAL',
      statusCode: 409,
    });
  });
});

describe('native session release', () => {
  const openLink = {
    binding: nativeBinding({ openLinkId: linkId }),
    link: nativeLink(),
    reverseBindingId: bindingId,
  };
  const unlink = {
    bindingId,
    linkId,
    expectedVersion: 4,
    expectedOpenLinkId: linkId,
  };

  it('closes the open link when the status target is completed', async () => {
    const harness = nativeHarness({ ...openLink, ids: ['status-event', 'unlinked-event'] });

    await harness.service.updateStatus('session-1', 'completed');
    expect(harness.statusUpdates).toHaveLength(1);
    expect(harness.statusUpdates[0]?.native).toEqual({
      ...unlink,
      unlinkedEventId: 'unlinked-event',
    });
  });

  it('carries no native payload for a non-terminal status target', async () => {
    const harness = nativeHarness({ ...openLink, ids: ['status-event', 'unlinked-event'] });

    await harness.service.updateStatus('session-1', 'idle');
    expect(harness.statusUpdates[0]?.native).toBeUndefined();
    expect(harness.bindingReads).toHaveLength(0);
  });

  it('closes the open link on a graceful close', async () => {
    const harness = nativeHarness({ ...openLink, ids: ['close-event', 'unlinked-event'] });

    await harness.service.close('session-1');
    expect(harness.closes).toHaveLength(1);
    expect(harness.closes[0]?.native).toEqual({ ...unlink, unlinkedEventId: 'unlinked-event' });
  });

  it('refuses to complete a session whose binding cannot be read', async () => {
    const harness = nativeHarness({ reverseBindingId: bindingId });

    await expect(harness.service.updateStatus('session-1', 'completed')).rejects.toMatchObject({
      code: 'NATIVE_BINDING_INCONSISTENT',
      statusCode: 409,
    });
    expect(harness.statusUpdates).toHaveLength(0);
  });

  it('refuses to close a session whose open link names another session', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: linkId }),
      link: nativeLink({ sessionId: 'session-2' }),
      reverseBindingId: bindingId,
    });

    await expect(harness.service.close('session-1')).rejects.toMatchObject({
      code: 'NATIVE_BINDING_INCONSISTENT',
      statusCode: 409,
    });
    expect(harness.closes).toHaveLength(0);
  });

  it('refuses to close a session whose link is already closed', async () => {
    const harness = nativeHarness({
      binding: nativeBinding({ openLinkId: linkId }),
      link: nativeLink({ unlinkedAt: '2026-07-28T11:30:00.000Z' }),
      reverseBindingId: bindingId,
    });

    await expect(harness.service.close('session-1')).rejects.toMatchObject({
      code: 'NATIVE_BINDING_INCONSISTENT',
      statusCode: 409,
    });
    expect(harness.closes).toHaveLength(0);
  });

  it('maps a contended completion to NATIVE_BINDING_CONTENDED after three attempts', async () => {
    const harness = nativeHarness({
      ...openLink,
      statusConflicts: NATIVE_DECLARATION_MAX_ATTEMPTS,
      ids: ['status-event', 'unlinked-event'],
    });

    await expect(harness.service.updateStatus('session-1', 'completed')).rejects.toMatchObject({
      code: 'NATIVE_BINDING_CONTENDED',
      statusCode: 409,
    });
    expect(harness.statusUpdates).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
  });

  it('maps a contended close to NATIVE_BINDING_CONTENDED after three attempts', async () => {
    const harness = nativeHarness({
      ...openLink,
      closeConflicts: NATIVE_DECLARATION_MAX_ATTEMPTS,
      ids: ['close-event', 'unlinked-event'],
    });

    await expect(harness.service.close('session-1')).rejects.toMatchObject({
      code: 'NATIVE_BINDING_CONTENDED',
      statusCode: 409,
    });
    expect(harness.closes).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
  });

  it('keeps the unlink event id stable across a retried close', async () => {
    const harness = nativeHarness({
      ...openLink,
      closeConflicts: NATIVE_DECLARATION_MAX_ATTEMPTS - 1,
      ids: ['close-event', 'unlinked-event'],
    });

    await harness.service.close('session-1');
    expect(harness.closes).toHaveLength(NATIVE_DECLARATION_MAX_ATTEMPTS);
    for (const call of harness.closes) {
      expect(call.eventId).toBe('close-event');
      expect(call.native?.unlinkedEventId).toBe('unlinked-event');
    }
  });
});

describe('session service getNativeRef', () => {
  const options = {
    workspaceId: 'local',
    presenceTtlMs: 15_000,
    createId: () => 'id',
    canonicalizeWorkingDirectory: async () => ({
      localPath: 'C:/workspace/luwi',
      canonicalPath: 'C:/workspace/luwi',
      identityPath: 'c:/workspace/luwi',
      pathIdentityHash: 'a'.repeat(64),
    }),
  };

  it('returns the binding native reference for a bound session', async () => {
    const backing = repository();
    const service = createSessionService({
      ...options,
      repository: {
        ...backing,
        getSessionNativeBindingId: async () => 'binding-1',
        getNativeBinding: async () => ({
          id: 'binding-1',
          adapterId: 'codex',
          nativeSessionId: '01a084e9-182a-7e81-bc8e-e0f33f3eda12',
          kind: 'main',
          version: 1,
          linkCount: 1,
          trimmedLinkCount: 0,
          firstLinkedAt: '2026-09-14T00:00:00.000Z',
          lastLinkedAt: '2026-09-14T00:00:00.000Z',
        }),
      },
    });
    expect(await service.getNativeRef('session-1')).toEqual({
      adapterId: 'codex',
      nativeSessionId: '01a084e9-182a-7e81-bc8e-e0f33f3eda12',
    });
  });

  it('returns null when the session has no native binding', async () => {
    const service = createSessionService({ ...options, repository: repository() });
    expect(await service.getNativeRef('session-1')).toBeNull();
  });
});
