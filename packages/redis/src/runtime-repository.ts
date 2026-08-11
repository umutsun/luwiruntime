import {
  agentSessionSchema,
  nativeSessionBindingSchema,
  nativeSessionLinkSchema,
  projectSchema,
  redisStreamIdSchema,
  runtimeEventSchema,
  sessionStatusSchema,
  sessionViewSchema,
  type AgentSession,
  type NativeSessionBinding,
  type NativeSessionLink,
  type Project,
  type RuntimeEvent,
  type SessionStatus,
  type SessionStatusTarget,
  type SessionView,
} from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import { SESSION_INBOX_CONSUMER_GROUP, type RedisKeys } from './redis-keys.js';

export interface RedisCommandClient {
  sendCommand(arguments_: readonly string[]): Promise<unknown>;
}

export type RegisterProjectInput = {
  project: {
    id: string;
    name: string;
    localPath: string;
    canonicalPath: string;
    identityPath: string;
    pathIdentityHash: string;
    repositoryUrl?: string;
    defaultBranch?: string;
  };
  workspaceId: string;
  eventId: string;
};

export type RegisterProjectResult =
  | {
      status: 'created';
      project: Project;
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
    }
  | {
      status: 'conflict';
      reason: 'duplicate';
      existingProjectId: string;
      canonicalPath: string;
    }
  | {
      status: 'conflict';
      reason: 'hash_collision';
    };

export type RegisterSessionInput = {
  session: {
    id: string;
    agentId: string;
    projectId: string;
    status: 'starting';
    workingDirectory: string;
    metadataJson: string;
    taskSummary?: string;
    branch?: string;
    worktreePath?: string;
  };
  workspaceId: string;
  eventId: string;
  presenceTtlMs: number;
  native?: NativeRegistrationInput;
};

/**
 * A native declaration carried atomically with the registration.
 *
 * `payload` is serialised verbatim into the Function's native argument. The
 * separate identifier fields exist because the caller must also declare the
 * matching keys, and a Function may not derive a key name.
 */
export type NativeRegistrationInput = {
  bindingId: string;
  linkId: string;
  staleLinkId?: string;
  linkedEventId: string;
  unlinkedEventId?: string;
  payload: {
    bindingId: string;
    expectedVersion: number;
    expectedOpenLinkId?: string;
    staleLinkId?: string;
    link: { id: string; sessionId: string };
    binding?: {
      id: string;
      adapterId: string;
      nativeSessionId: string;
      nativeSubagentId?: string;
      kind: 'main' | 'subagent';
      parentRefJson?: string;
    };
  };
};

export type NativeUnlinkInput = {
  bindingId: string;
  linkId: string;
  expectedVersion: number;
  expectedOpenLinkId: string;
  unlinkedEventId: string;
};

export type NativeTransitionResult = {
  transition: 'created' | 'linked';
  binding: NativeSessionBinding;
  link: NativeSessionLink;
  staleLink?: NativeSessionLink;
};

export type AppendedEvent = {
  event: RuntimeEvent;
  globalStreamId: string;
  projectStreamId: string;
};

export type RegisterSessionResult =
  | {
      status: 'created';
      session: AgentSession;
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
      /** Present only when a native declaration was supplied. */
      native?: NativeTransitionResult;
      events?: AppendedEvent[];
    }
  | { status: 'not_found'; entity: 'project' };

export type UpdateSessionStatusInput = {
  sessionId: string;
  projectId: string;
  targetStatus: SessionStatusTarget;
  workspaceId: string;
  eventId: string;
  /** Present only when the target is terminal and the session holds an open link. */
  native?: NativeUnlinkInput;
};

export type UpdateSessionStatusResult =
  | {
      status: 'updated';
      previousStatus: SessionStatus;
      currentStatus: SessionStatusTarget;
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
    }
  | { status: 'unchanged'; currentStatus: SessionStatus }
  | { status: 'terminal'; currentStatus: 'completed' | 'disconnected' }
  | { status: 'not_found'; entity: 'session' }
  | { status: 'invalid_transition'; currentStatus: SessionStatus };

export type HeartbeatSessionInput = {
  sessionId: string;
  projectId: string;
  workspaceId: string;
  eventId: string;
  presenceTtlMs: number;
  eventIntervalMs: number;
  metadataJson?: string;
};

export type HeartbeatSessionResult =
  | {
      status: 'renewed';
      eventEmitted: false;
      lastHeartbeatAt: string;
    }
  | {
      status: 'renewed';
      eventEmitted: true;
      lastHeartbeatAt: string;
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
    }
  | { status: 'terminal'; currentStatus: 'completed' | 'disconnected' }
  | { status: 'not_found'; entity: 'session' };

export type CloseSessionInput = {
  sessionId: string;
  projectId: string;
  workspaceId: string;
  eventId: string;
  /** Present only when the session holds an open native link. */
  native?: NativeUnlinkInput;
};

export type CloseSessionResult =
  | {
      status: 'completed';
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
    }
  | { status: 'unchanged'; currentStatus: 'completed' }
  | { status: 'terminal'; currentStatus: 'disconnected' }
  | { status: 'not_found'; entity: 'session' };

export type HeartbeatDeadline = { sessionId: string; deadlineMs: number };

export type DisconnectExpiredSessionInput = HeartbeatDeadline & {
  projectId: string;
  expectedDeadlineMs: number;
  workspaceId: string;
  eventId: string;
  /** Present only when the lapsing session holds an open native link. */
  native?: NativeUnlinkInput;
};

export type DisconnectExpiredSessionResult =
  | {
      status: 'disconnected';
      event: RuntimeEvent;
      globalStreamId: string;
      projectStreamId: string;
    }
  | { status: 'reconciled'; deadlineMs: number }
  | { status: 'unchanged' }
  | { status: 'not_found'; entity: 'session' };

export interface RuntimeRepository {
  registerProject(input: RegisterProjectInput): Promise<RegisterProjectResult>;
  getProject(projectId: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  registerSession(input: RegisterSessionInput): Promise<RegisterSessionResult>;
  getNativeBinding(bindingId: string): Promise<NativeSessionBinding | null>;
  getNativeLink(linkId: string): Promise<NativeSessionLink | null>;
  getSessionNativeBindingId(sessionId: string): Promise<string | null>;
  getSession(sessionId: string): Promise<SessionView | null>;
  listSessions(projectId?: string): Promise<SessionView[]>;
  updateSessionStatus(input: UpdateSessionStatusInput): Promise<UpdateSessionStatusResult>;
  heartbeatSession(input: HeartbeatSessionInput): Promise<HeartbeatSessionResult>;
  closeSession(input: CloseSessionInput): Promise<CloseSessionResult>;
  findExpiredHeartbeatDeadlines(nowMs: number, limit: number): Promise<HeartbeatDeadline[]>;
  disconnectExpiredSession(
    input: DisconnectExpiredSessionInput,
  ): Promise<DisconnectExpiredSessionResult>;
}

export class RedisRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RedisRepositoryError';
    this.code = code;
  }
}

function decodeJsonReply(reply: unknown): unknown {
  const text =
    typeof reply === 'string' ? reply : Buffer.isBuffer(reply) ? reply.toString('utf8') : undefined;

  if (text === undefined) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an invalid Function response.',
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned malformed JSON from a Function.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseProjectFunctionResult(value: unknown): RegisterProjectResult {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an incompatible project transition result.',
    );
  }

  if (value.status === 'error' && typeof value.code === 'string' && value.code !== '') {
    throw new RedisRepositoryError(value.code, 'Redis rejected the project state transition.');
  }

  if (value.status === 'conflict' && value.reason === 'hash_collision') {
    return { status: 'conflict', reason: 'hash_collision' };
  }

  if (
    value.status === 'conflict' &&
    value.reason === 'duplicate' &&
    typeof value.existingProjectId === 'string' &&
    value.existingProjectId !== '' &&
    typeof value.canonicalPath === 'string' &&
    value.canonicalPath !== ''
  ) {
    return {
      status: 'conflict',
      reason: 'duplicate',
      existingProjectId: value.existingProjectId,
      canonicalPath: value.canonicalPath,
    };
  }

  if (value.status === 'created') {
    const project = projectSchema.safeParse(value.project);
    const event = runtimeEventSchema.safeParse(value.event);
    const globalStreamId = redisStreamIdSchema.safeParse(value.globalStreamId);
    const projectStreamId = redisStreamIdSchema.safeParse(value.projectStreamId);
    if (project.success && event.success && globalStreamId.success && projectStreamId.success) {
      return {
        status: 'created',
        project: project.data,
        event: event.data,
        globalStreamId: globalStreamId.data,
        projectStreamId: projectStreamId.data,
      };
    }
  }

  throw new RedisRepositoryError(
    'REDIS_DATA_INVALID',
    'Redis returned an incompatible project transition result.',
  );
}

function parseRegisterSessionResult(value: unknown): RegisterSessionResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an incompatible session registration result.',
    );
  }
  if (value.status === 'error' && typeof value.code === 'string' && value.code !== '') {
    throw new RedisRepositoryError(value.code, 'Redis rejected session registration.');
  }
  if (value.status === 'not_found' && value.entity === 'project') {
    return { status: 'not_found', entity: 'project' };
  }
  if (value.status === 'created') {
    const session = agentSessionSchema.safeParse(value.session);
    const event = runtimeEventSchema.safeParse(value.event);
    const globalStreamId = redisStreamIdSchema.safeParse(value.globalStreamId);
    const projectStreamId = redisStreamIdSchema.safeParse(value.projectStreamId);
    if (session.success && event.success && globalStreamId.success && projectStreamId.success) {
      return {
        status: 'created',
        session: session.data,
        event: event.data,
        globalStreamId: globalStreamId.data,
        projectStreamId: projectStreamId.data,
        // Present only for a native declaration; a 9-key registration keeps
        // exactly the shape every existing caller already parses.
        ...(value.native === undefined ? {} : { native: parseNativeTransition(value.native) }),
        ...(value.events === undefined ? {} : { events: parseAppendedEvents(value.events) }),
      };
    }
  }
  throw new RedisRepositoryError(
    'REDIS_DATA_INVALID',
    'Redis returned an incompatible session registration result.',
  );
}

function parseNativeTransition(value: unknown): NativeTransitionResult {
  const invalid = (): never => {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an incompatible native session transition.',
    );
  };
  if (!isRecord(value)) return invalid();
  if (value.transition !== 'created' && value.transition !== 'linked') return invalid();
  const binding = parseNativeBindingHash(value.binding);
  const link = parseNativeLinkHash(value.link);
  if (binding === null || link === null) return invalid();
  const staleLink = value.staleLink === undefined ? null : parseNativeLinkHash(value.staleLink);
  return {
    transition: value.transition,
    binding,
    link,
    ...(staleLink === null ? {} : { staleLink }),
  };
}

function parseAppendedEvents(value: unknown): AppendedEvent[] {
  if (!Array.isArray(value)) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an incompatible appended event list.',
    );
  }
  return value.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const event = runtimeEventSchema.safeParse(record.event);
    const globalStreamId = redisStreamIdSchema.safeParse(record.globalStreamId);
    const projectStreamId = redisStreamIdSchema.safeParse(record.projectStreamId);
    if (!event.success || !globalStreamId.success || !projectStreamId.success) {
      throw new RedisRepositoryError(
        'REDIS_DATA_INVALID',
        'Redis returned an incompatible appended event.',
      );
    }
    return {
      event: event.data,
      globalStreamId: globalStreamId.data,
      projectStreamId: projectStreamId.data,
    };
  });
}

function parseUpdateSessionStatusResult(value: unknown): UpdateSessionStatusResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an incompatible session status result.',
    );
  }
  if (value.status === 'error' && typeof value.code === 'string' && value.code !== '') {
    throw new RedisRepositoryError(value.code, 'Redis rejected the session status transition.');
  }
  if (value.status === 'not_found' && value.entity === 'session') {
    return { status: 'not_found', entity: 'session' };
  }

  const currentStatus = sessionStatusSchema.safeParse(value.currentStatus);
  if (!currentStatus.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an invalid session status.',
    );
  }
  if (value.status === 'unchanged') {
    return { status: 'unchanged', currentStatus: currentStatus.data };
  }
  if (
    value.status === 'terminal' &&
    (currentStatus.data === 'completed' || currentStatus.data === 'disconnected')
  ) {
    return { status: 'terminal', currentStatus: currentStatus.data };
  }
  if (value.status === 'invalid_transition') {
    return { status: 'invalid_transition', currentStatus: currentStatus.data };
  }
  if (value.status === 'updated') {
    const previousStatus = sessionStatusSchema.safeParse(value.previousStatus);
    const targetStatus = sessionStatusSchema.safeParse(value.currentStatus);
    const event = runtimeEventSchema.safeParse(value.event);
    const globalStreamId = redisStreamIdSchema.safeParse(value.globalStreamId);
    const projectStreamId = redisStreamIdSchema.safeParse(value.projectStreamId);
    if (
      previousStatus.success &&
      targetStatus.success &&
      targetStatus.data !== 'starting' &&
      targetStatus.data !== 'disconnected' &&
      event.success &&
      globalStreamId.success &&
      projectStreamId.success
    ) {
      return {
        status: 'updated',
        previousStatus: previousStatus.data,
        currentStatus: targetStatus.data,
        event: event.data,
        globalStreamId: globalStreamId.data,
        projectStreamId: projectStreamId.data,
      };
    }
  }
  throw new RedisRepositoryError(
    'REDIS_DATA_INVALID',
    'Redis returned an incompatible session status result.',
  );
}

function parsePersistedEventResult(
  value: Record<string, unknown>,
): Pick<
  Extract<HeartbeatSessionResult, { eventEmitted: true }>,
  'event' | 'globalStreamId' | 'projectStreamId'
> {
  const event = runtimeEventSchema.safeParse(value.event);
  const globalStreamId = redisStreamIdSchema.safeParse(value.globalStreamId);
  const projectStreamId = redisStreamIdSchema.safeParse(value.projectStreamId);
  if (!event.success || !globalStreamId.success || !projectStreamId.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned invalid persisted event details.',
    );
  }
  return {
    event: event.data,
    globalStreamId: globalStreamId.data,
    projectStreamId: projectStreamId.data,
  };
}

function parseHeartbeatResult(value: unknown): HeartbeatSessionResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid heartbeat.');
  }
  if (value.status === 'error' && typeof value.code === 'string') {
    throw new RedisRepositoryError(value.code, 'Redis rejected the session heartbeat.');
  }
  if (value.status === 'not_found' && value.entity === 'session') {
    return { status: 'not_found', entity: 'session' };
  }
  if (
    value.status === 'terminal' &&
    (value.currentStatus === 'completed' || value.currentStatus === 'disconnected')
  ) {
    return { status: 'terminal', currentStatus: value.currentStatus };
  }
  if (
    value.status === 'renewed' &&
    typeof value.eventEmitted === 'boolean' &&
    typeof value.lastHeartbeatAt === 'string' &&
    !Number.isNaN(Date.parse(value.lastHeartbeatAt))
  ) {
    if (!value.eventEmitted) {
      return {
        status: 'renewed',
        eventEmitted: false,
        lastHeartbeatAt: value.lastHeartbeatAt,
      };
    }
    return {
      status: 'renewed',
      eventEmitted: true,
      lastHeartbeatAt: value.lastHeartbeatAt,
      ...parsePersistedEventResult(value),
    };
  }
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid heartbeat.');
}

function parseCloseResult(value: unknown): CloseSessionResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid close result.');
  }
  if (value.status === 'error' && typeof value.code === 'string') {
    throw new RedisRepositoryError(value.code, 'Redis rejected the session close.');
  }
  if (value.status === 'not_found' && value.entity === 'session') {
    return { status: 'not_found', entity: 'session' };
  }
  if (value.status === 'unchanged' && value.currentStatus === 'completed') {
    return { status: 'unchanged', currentStatus: 'completed' };
  }
  if (value.status === 'terminal' && value.currentStatus === 'disconnected') {
    return { status: 'terminal', currentStatus: 'disconnected' };
  }
  if (value.status === 'completed') {
    return { status: 'completed', ...parsePersistedEventResult(value) };
  }
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid close result.');
}

function parseDisconnectResult(value: unknown): DisconnectExpiredSessionResult {
  if (!isRecord(value)) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an invalid disconnection result.',
    );
  }
  if (value.status === 'error' && typeof value.code === 'string') {
    throw new RedisRepositoryError(value.code, 'Redis rejected stale-session disconnection.');
  }
  if (value.status === 'not_found' && value.entity === 'session') {
    return { status: 'not_found', entity: 'session' };
  }
  if (value.status === 'unchanged') {
    return { status: 'unchanged' };
  }
  if (
    value.status === 'reconciled' &&
    typeof value.deadlineMs === 'number' &&
    Number.isFinite(value.deadlineMs)
  ) {
    return { status: 'reconciled', deadlineMs: value.deadlineMs };
  }
  if (value.status === 'disconnected') {
    return { status: 'disconnected', ...parsePersistedEventResult(value) };
  }
  throw new RedisRepositoryError(
    'REDIS_DATA_INVALID',
    'Redis returned an invalid disconnection result.',
  );
}

function hashRecord(reply: unknown, entity: string): Record<string, unknown> | null {
  if (Array.isArray(reply)) {
    if (reply.length === 0) {
      return null;
    }
    const record: Record<string, unknown> = {};
    for (let index = 0; index < reply.length; index += 2) {
      const key = reply[index];
      const value = reply[index + 1];
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          `Redis returned an invalid ${entity} hash.`,
        );
      }
      record[key] = value;
    }
    return record;
  }
  if (isRecord(reply)) {
    return Object.keys(reply).length === 0 ? null : reply;
  }
  throw new RedisRepositoryError('REDIS_DATA_INVALID', `Redis returned an invalid ${entity} hash.`);
}

function parseProjectHash(reply: unknown): Project | null {
  const record = hashRecord(reply, 'project');
  if (record === null) {
    return null;
  }
  const normalized = { ...record };
  delete normalized.identityPath;
  delete normalized.pathIdentityHash;
  if (normalized.repositoryUrl === '') {
    delete normalized.repositoryUrl;
  }
  if (normalized.defaultBranch === '') {
    delete normalized.defaultBranch;
  }
  return projectSchema.parse(normalized);
}

function optional(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  return typeof value === 'string' && value !== '' ? { [field]: value } : {};
}

function parseNativeBindingHash(reply: unknown): NativeSessionBinding | null {
  const record = hashRecord(reply, 'native session binding');
  if (record === null) {
    return null;
  }
  const parsed = nativeSessionBindingSchema.safeParse({
    id: record.id,
    adapterId: record.adapterId,
    nativeSessionId: record.nativeSessionId,
    ...optional(record, 'nativeSubagentId'),
    kind: record.kind,
    ...(typeof record.parentRef === 'string' && record.parentRef !== ''
      ? { parentRef: JSON.parse(record.parentRef) as unknown }
      : {}),
    ...optional(record, 'openLinkId'),
    version: Number(record.version),
    linkCount: Number(record.linkCount),
    trimmedLinkCount: Number(record.trimmedLinkCount),
    ...optional(record, 'oldestRetainedLinkedAt'),
    firstLinkedAt: record.firstLinkedAt,
    lastLinkedAt: record.lastLinkedAt,
  });
  if (!parsed.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains an invalid native session binding projection.',
    );
  }
  return parsed.data;
}

function parseNativeLinkHash(reply: unknown): NativeSessionLink | null {
  const record = hashRecord(reply, 'native session link');
  if (record === null) {
    return null;
  }
  const parsed = nativeSessionLinkSchema.safeParse({
    id: record.id,
    bindingId: record.bindingId,
    sessionId: record.sessionId,
    linkedAt: record.linkedAt,
    ...optional(record, 'unlinkedAt'),
  });
  if (!parsed.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains an invalid native session link projection.',
    );
  }
  return parsed.data;
}

function parseSessionHash(reply: unknown): AgentSession | null {
  const record = hashRecord(reply, 'session');
  if (record === null) {
    return null;
  }
  const normalized = { ...record };
  delete normalized.lastHeartbeatEventAt;
  for (const optional of ['taskSummary', 'branch', 'worktreePath']) {
    if (normalized[optional] === '') {
      delete normalized[optional];
    }
  }
  if (typeof normalized.metadata !== 'string') {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains invalid session metadata.',
    );
  }
  try {
    normalized.metadata = JSON.parse(normalized.metadata) as unknown;
  } catch {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains malformed session metadata.',
    );
  }
  return agentSessionSchema.parse(normalized);
}

function stringArray(reply: unknown, entity: string): string[] {
  if (!Array.isArray(reply) || !reply.every((value) => typeof value === 'string')) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      `Redis returned an invalid ${entity} index.`,
    );
  }
  return reply;
}

export function createRuntimeRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
}): RuntimeRepository {
  const { client, keys, functions } = options;

  return {
    async registerProject(input) {
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions.projectRegister,
        '5',
        keys.project(input.project.id),
        keys.projectPathIndex(input.project.pathIdentityHash),
        keys.projectsIndex,
        keys.globalEvents,
        keys.projectEvents(input.project.id),
        JSON.stringify(input.project),
        input.workspaceId,
        input.eventId,
      ]);

      return parseProjectFunctionResult(decodeJsonReply(reply));
    },

    async getProject(projectId) {
      try {
        return parseProjectHash(await client.sendCommand(['HGETALL', keys.project(projectId)]));
      } catch (error) {
        if (error instanceof RedisRepositoryError) {
          throw error;
        }
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          'Redis contains an invalid project projection.',
        );
      }
    },

    async listProjects() {
      const projectIds = stringArray(
        await client.sendCommand(['SMEMBERS', keys.projectsIndex]),
        'project',
      );

      const projects = (
        await Promise.all(projectIds.map(async (projectId) => this.getProject(projectId)))
      ).filter((project): project is Project => project !== null);
      return projects.sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
    },

    async registerSession(input) {
      const commandKeys = [
        keys.session(input.session.id),
        keys.project(input.session.projectId),
        keys.projectSessions(input.session.projectId),
        keys.agentSessions(input.session.agentId),
        keys.sessionPresence(input.session.id),
        keys.heartbeatDeadlines,
        keys.globalEvents,
        keys.projectEvents(input.session.projectId),
        keys.sessionInbox(input.session.id),
      ];
      const commandArgs = [
        JSON.stringify(input.session),
        input.workspaceId,
        input.eventId,
        String(input.presenceTtlMs),
        SESSION_INBOX_CONSUMER_GROUP,
      ];
      if (input.native !== undefined) {
        const native = input.native;
        commandKeys.push(
          keys.nativeSessionBinding(native.bindingId),
          keys.nativeSessionLink(native.linkId),
          keys.nativeSessionLinks(native.bindingId),
          keys.sessionNativeBinding(input.session.id),
          // Declared but never written when there is no stale link.
          native.staleLinkId === undefined
            ? keys.nativeSessionBinding(native.bindingId)
            : keys.nativeSessionLink(native.staleLinkId),
        );
        commandArgs.push(JSON.stringify(native.payload), native.linkedEventId);
        if (native.unlinkedEventId !== undefined) {
          commandArgs.push(native.unlinkedEventId);
        }
      }
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions.sessionRegister,
        String(commandKeys.length),
        ...commandKeys,
        ...commandArgs,
      ]);
      return parseRegisterSessionResult(decodeJsonReply(reply));
    },

    async getNativeBinding(bindingId) {
      return parseNativeBindingHash(
        await client.sendCommand(['HGETALL', keys.nativeSessionBinding(bindingId)]),
      );
    },

    async getNativeLink(linkId) {
      return parseNativeLinkHash(
        await client.sendCommand(['HGETALL', keys.nativeSessionLink(linkId)]),
      );
    },

    async getSessionNativeBindingId(sessionId) {
      const reply = await client.sendCommand(['GET', keys.sessionNativeBinding(sessionId)]);
      return typeof reply === 'string' && reply !== '' ? reply : null;
    },

    async getSession(sessionId) {
      try {
        const session = parseSessionHash(
          await client.sendCommand(['HGETALL', keys.session(sessionId)]),
        );
        if (session === null) {
          return null;
        }
        const terminal = session.status === 'completed' || session.status === 'disconnected';
        const presenceReply = terminal
          ? 0
          : await client.sendCommand(['EXISTS', keys.sessionPresence(sessionId)]);
        const presence = Number(presenceReply) === 1 && !terminal ? 'online' : 'offline';
        return sessionViewSchema.parse({ ...session, presence });
      } catch (error) {
        if (error instanceof RedisRepositoryError) {
          throw error;
        }
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          'Redis contains an invalid session projection.',
        );
      }
    },

    async listSessions(projectId) {
      let sessionIds: string[];
      if (projectId !== undefined) {
        sessionIds = stringArray(
          await client.sendCommand(['SMEMBERS', keys.projectSessions(projectId)]),
          'project session',
        );
      } else {
        const projectIds = stringArray(
          await client.sendCommand(['SMEMBERS', keys.projectsIndex]),
          'project',
        );
        const projectSessionIds = await Promise.all(
          projectIds.map(async (id) =>
            stringArray(
              await client.sendCommand(['SMEMBERS', keys.projectSessions(id)]),
              'project session',
            ),
          ),
        );
        sessionIds = [...new Set(projectSessionIds.flat())];
      }
      const sessions = (
        await Promise.all(sessionIds.map(async (sessionId) => this.getSession(sessionId)))
      ).filter((session): session is SessionView => session !== null);
      return sessions.sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
      );
    },

    async updateSessionStatus(input) {
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions.sessionStatus,
        String(5 + (input.native === undefined ? 0 : 2)),
        keys.session(input.sessionId),
        keys.sessionPresence(input.sessionId),
        keys.heartbeatDeadlines,
        keys.globalEvents,
        keys.projectEvents(input.projectId),
        ...(input.native === undefined
          ? []
          : [
              keys.nativeSessionBinding(input.native.bindingId),
              keys.nativeSessionLink(input.native.linkId),
            ]),
        input.targetStatus,
        input.projectId,
        input.workspaceId,
        input.eventId,
        ...(input.native === undefined
          ? []
          : [
              JSON.stringify({
                bindingId: input.native.bindingId,
                linkId: input.native.linkId,
                expectedVersion: input.native.expectedVersion,
                expectedOpenLinkId: input.native.expectedOpenLinkId,
              }),
              input.native.unlinkedEventId,
            ]),
      ]);
      return parseUpdateSessionStatusResult(decodeJsonReply(reply));
    },

    async heartbeatSession(input) {
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions.sessionHeartbeat,
        '5',
        keys.session(input.sessionId),
        keys.sessionPresence(input.sessionId),
        keys.heartbeatDeadlines,
        keys.globalEvents,
        keys.projectEvents(input.projectId),
        input.projectId,
        input.workspaceId,
        input.eventId,
        String(input.presenceTtlMs),
        String(input.eventIntervalMs),
        input.metadataJson === undefined ? '0' : '1',
        input.metadataJson ?? '',
      ]);
      return parseHeartbeatResult(decodeJsonReply(reply));
    },

    async closeSession(input) {
      const commandKeys = [
        keys.session(input.sessionId),
        keys.sessionPresence(input.sessionId),
        keys.heartbeatDeadlines,
        keys.globalEvents,
        keys.projectEvents(input.projectId),
      ];
      const commandArgs = [input.projectId, input.workspaceId, input.eventId];
      if (input.native !== undefined) {
        const native = input.native;
        commandKeys.push(
          keys.nativeSessionBinding(native.bindingId),
          keys.nativeSessionLink(native.linkId),
        );
        commandArgs.push(
          JSON.stringify({
            bindingId: native.bindingId,
            linkId: native.linkId,
            expectedVersion: native.expectedVersion,
            expectedOpenLinkId: native.expectedOpenLinkId,
          }),
          native.unlinkedEventId,
        );
      }
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions.sessionClose,
        String(commandKeys.length),
        ...commandKeys,
        ...commandArgs,
      ]);
      return parseCloseResult(decodeJsonReply(reply));
    },

    async findExpiredHeartbeatDeadlines(nowMs, limit) {
      const reply = await client.sendCommand([
        'ZRANGEBYSCORE',
        keys.heartbeatDeadlines,
        '-inf',
        String(nowMs),
        'WITHSCORES',
        'LIMIT',
        '0',
        String(limit),
      ]);
      if (!Array.isArray(reply)) {
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          'Redis returned an invalid heartbeat deadline index.',
        );
      }
      const deadlines: HeartbeatDeadline[] = [];
      const entries = reply.every((value) => Array.isArray(value) && value.length === 2)
        ? (reply as unknown[][])
        : Array.from({ length: Math.ceil(reply.length / 2) }, (_, index) =>
            reply.slice(index * 2, index * 2 + 2),
          );
      for (const entry of entries) {
        const sessionId = entry[0];
        const deadlineMs = Number(entry[1]);
        if (typeof sessionId !== 'string' || entry.length !== 2 || !Number.isFinite(deadlineMs)) {
          throw new RedisRepositoryError(
            'REDIS_DATA_INVALID',
            'Redis returned an invalid heartbeat deadline.',
          );
        }
        deadlines.push({ sessionId, deadlineMs });
      }
      return deadlines;
    },

    async disconnectExpiredSession(input) {
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions.sessionDisconnect,
        String(5 + (input.native === undefined ? 0 : 2)),
        keys.session(input.sessionId),
        keys.sessionPresence(input.sessionId),
        keys.heartbeatDeadlines,
        keys.globalEvents,
        keys.projectEvents(input.projectId),
        ...(input.native === undefined
          ? []
          : [
              keys.nativeSessionBinding(input.native.bindingId),
              keys.nativeSessionLink(input.native.linkId),
            ]),
        input.projectId,
        input.workspaceId,
        input.eventId,
        String(input.expectedDeadlineMs),
        ...(input.native === undefined
          ? []
          : [
              JSON.stringify({
                bindingId: input.native.bindingId,
                linkId: input.native.linkId,
                expectedVersion: input.native.expectedVersion,
                expectedOpenLinkId: input.native.expectedOpenLinkId,
              }),
              input.native.unlinkedEventId,
            ]),
      ]);
      return parseDisconnectResult(decodeJsonReply(reply));
    },
  };
}
