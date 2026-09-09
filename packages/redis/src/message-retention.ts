import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

export type MessageRetentionOptions = {
  client: RedisCommandClient;
  keys: RedisKeys;
  nowMs: number;
  terminalProjectionRetentionMs: number;
  maxInboxLength: number;
  batchSize: number;
  sessionIds: string[];
};

export type MessageRetentionResult = {
  projectionCandidates: number;
  projectionsPruned: number;
  projectionsDeferredForIdempotency: number;
  projectionsDeferredForWake: number;
  deferredWakeIntentIds: string[];
  wakeIntentsPruned: number;
  inboxesTrimmed: number;
  inboxesDeferred: number;
};

type TerminalProjectionIdentity = {
  id: string;
  correlationId: string;
  projectId: string;
  sourceSessionId: string;
  targetSessionId: string;
  idempotencyKeyHash?: string;
};

type WakeRetentionState = {
  id: string;
  messageId: string;
  projectId: string;
  state: 'pending' | 'claimed' | 'dispatching' | 'dispatched' | 'fallback_only' | 'indeterminate';
  streamId: string;
  streamAcknowledgedAt?: string;
};

const deleteTerminalProjectionScript =
  "local function type_ok(key,wanted) local actual=redis.call('TYPE',key); if type(actual)=='table' then actual=actual['ok'] end; return actual=='none' or actual==wanted end; " +
  "if not type_ok(KEYS[1],'hash') or not type_ok(KEYS[2],'string') or not type_ok(KEYS[8],'hash') or not type_ok(KEYS[12],'stream') then return -1 end; " +
  "for index=3,7 do if not type_ok(KEYS[index],'zset') then return -1 end end; for index=9,11 do if not type_ok(KEYS[index],'zset') then return -1 end end; " +
  "local id=ARGV[1]; local wake=redis.call('EXISTS',KEYS[8])==1; " +
  "if wake then local values=redis.call('HMGET',KEYS[8],'id','messageId','projectId','state','streamId','streamAcknowledgedAt'); " +
  'if values[1]~=id or values[2]~=id or values[3]~=ARGV[2] or not values[5] then return -1 end; ' +
  "if (values[4]~='dispatched' and values[4]~='fallback_only' and values[4]~='indeterminate') or not values[6] then return 0 end end; " +
  "redis.call('DEL',KEYS[1],KEYS[2]); for index=3,7 do redis.call('ZREM',KEYS[index],id) end; " +
  "if wake then redis.call('ZREM',KEYS[9],id); redis.call('ZREM',KEYS[10],id); redis.call('ZREM',KEYS[11],id); " +
  "redis.call('XDEL',KEYS[12],redis.call('HGET',KEYS[8],'streamId')); redis.call('DEL',KEYS[8]); return 2 end; return 1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pairsToRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned invalid retention metadata.',
    );
  }
  const record: Record<string, unknown> = {};
  for (let index = 0; index < value.length; index += 2) {
    const field = value[index];
    const fieldValue = value[index + 1];
    if (typeof field !== 'string' || fieldValue === undefined) {
      throw new RedisRepositoryError(
        'REDIS_DATA_INVALID',
        'Redis returned invalid retention metadata.',
      );
    }
    record[field] = fieldValue;
  }
  return record;
}

function parseTerminalIdentity(value: unknown): TerminalProjectionIdentity | null {
  const record = pairsToRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  for (const field of [
    'id',
    'correlationId',
    'projectId',
    'sourceSessionId',
    'targetSessionId',
  ] as const) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new RedisRepositoryError(
        'REDIS_DATA_INVALID',
        'Redis contains invalid terminal message metadata.',
      );
    }
  }
  return {
    id: record.id as string,
    correlationId: record.correlationId as string,
    projectId: record.projectId as string,
    sourceSessionId: record.sourceSessionId as string,
    targetSessionId: record.targetSessionId as string,
    ...(typeof record.idempotencyKeyHash === 'string' && record.idempotencyKeyHash.length > 0
      ? { idempotencyKeyHash: record.idempotencyKeyHash }
      : {}),
  };
}

function parseWakeRetentionState(
  value: unknown,
  expectedMessageId: string,
): WakeRetentionState | null {
  const record = pairsToRecord(value);
  if (Object.keys(record).length === 0) return null;
  const required = ['id', 'messageId', 'projectId', 'state', 'streamId'] as const;
  if (
    !required.every(
      (field) => typeof record[field] === 'string' && (record[field] as string).length > 0,
    ) ||
    record.id !== expectedMessageId ||
    record.messageId !== expectedMessageId ||
    !/^\d+-\d+$/.test(record.streamId as string)
  ) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains invalid wake retention metadata.',
    );
  }
  const states = new Set<WakeRetentionState['state']>([
    'pending',
    'claimed',
    'dispatching',
    'dispatched',
    'fallback_only',
    'indeterminate',
  ]);
  if (!states.has(record.state as WakeRetentionState['state'])) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains invalid wake retention metadata.',
    );
  }
  return {
    id: record.id as string,
    messageId: record.messageId as string,
    projectId: record.projectId as string,
    state: record.state as WakeRetentionState['state'],
    streamId: record.streamId as string,
    ...(typeof record.streamAcknowledgedAt === 'string' && record.streamAcknowledgedAt.length > 0
      ? { streamAcknowledgedAt: record.streamAcknowledgedAt }
      : {}),
  };
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned invalid retention candidates.',
    );
  }
  return value;
}

function groupMetadata(value: unknown): Array<{ name?: string; pending?: number; lag?: number }> {
  if (!Array.isArray(value)) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned invalid inbox group metadata.',
    );
  }
  return value.map((item) => {
    const record = pairsToRecord(item);
    return {
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.pending === 'number' ? { pending: record.pending } : {}),
      ...(typeof record.lag === 'number' ? { lag: record.lag } : {}),
    };
  });
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
}

async function deleteTerminalProjection(
  options: MessageRetentionOptions,
  identity: TerminalProjectionIdentity,
): Promise<'deferred' | 'message' | 'wake'> {
  const deleted = await options.client.sendCommand([
    'EVAL',
    deleteTerminalProjectionScript,
    '12',
    options.keys.message(identity.id),
    options.keys.messageCorrelation(identity.correlationId),
    options.keys.messagesIndex,
    options.keys.projectMessages(identity.projectId),
    options.keys.sourceSessionMessages(identity.sourceSessionId),
    options.keys.targetSessionMessages(identity.targetSessionId),
    options.keys.terminalMessages,
    options.keys.wakeIntent(identity.id),
    options.keys.wakeIntentsIndex,
    options.keys.projectWakeIntents(identity.projectId),
    options.keys.wakeIntentDeadlines,
    options.keys.wakeStream,
    identity.id,
    identity.projectId,
  ]);
  if (Number(deleted) === 0) return 'deferred';
  if (Number(deleted) === 1) return 'message';
  if (Number(deleted) === 2) return 'wake';
  {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an invalid retention result.',
    );
  }
}

export async function runMessageRetention(
  options: MessageRetentionOptions,
): Promise<MessageRetentionResult> {
  assertPositiveInteger(options.terminalProjectionRetentionMs, 'terminalProjectionRetentionMs');
  assertPositiveInteger(options.maxInboxLength, 'maxInboxLength');
  assertPositiveInteger(options.batchSize, 'batchSize');
  if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) {
    throw new Error('nowMs must be a non-negative safe integer.');
  }

  const cutoff = Math.max(0, options.nowMs - options.terminalProjectionRetentionMs);
  const candidates = parseStringArray(
    await options.client.sendCommand([
      'ZRANGEBYSCORE',
      options.keys.terminalMessages,
      '-inf',
      String(cutoff),
      'LIMIT',
      '0',
      String(options.batchSize),
    ]),
  );
  let projectionsPruned = 0;
  let projectionsDeferredForIdempotency = 0;
  let projectionsDeferredForWake = 0;
  const deferredWakeIntentIds: string[] = [];
  let wakeIntentsPruned = 0;
  for (const messageId of candidates) {
    const identity = parseTerminalIdentity(
      await options.client.sendCommand(['HGETALL', options.keys.message(messageId)]),
    );
    if (identity === null) {
      await options.client.sendCommand(['ZREM', options.keys.terminalMessages, messageId]);
      continue;
    }
    if (identity.idempotencyKeyHash !== undefined) {
      const idempotencyExists = Number(
        await options.client.sendCommand([
          'EXISTS',
          options.keys.messageIdempotency(identity.sourceSessionId, identity.idempotencyKeyHash),
        ]),
      );
      if (idempotencyExists !== 0) {
        projectionsDeferredForIdempotency += 1;
        continue;
      }
    }
    const wake = parseWakeRetentionState(
      await options.client.sendCommand(['HGETALL', options.keys.wakeIntent(messageId)]),
      messageId,
    );
    if (
      wake !== null &&
      (wake.state === 'pending' ||
        wake.state === 'claimed' ||
        wake.state === 'dispatching' ||
        wake.streamAcknowledgedAt === undefined)
    ) {
      projectionsDeferredForWake += 1;
      deferredWakeIntentIds.push(wake.id);
      continue;
    }
    const deleted = await deleteTerminalProjection(options, identity);
    if (deleted === 'deferred') {
      projectionsDeferredForWake += 1;
      deferredWakeIntentIds.push(messageId);
      continue;
    }
    if (deleted === 'wake') wakeIntentsPruned += 1;
    projectionsPruned += 1;
  }

  let inboxesTrimmed = 0;
  let inboxesDeferred = 0;
  for (const sessionId of [...new Set(options.sessionIds)]) {
    const stream = options.keys.sessionInbox(sessionId);
    let groups: Array<{ name?: string; pending?: number; lag?: number }>;
    try {
      groups = groupMetadata(await options.client.sendCommand(['XINFO', 'GROUPS', stream]));
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such key')) {
        continue;
      }
      throw error;
    }
    const inboxGroup = groups.find(({ name }) => name === 'luwi-session-inbox-v1');
    if (inboxGroup?.pending !== 0 || inboxGroup.lag !== 0) {
      inboxesDeferred += 1;
      continue;
    }
    await options.client.sendCommand([
      'XTRIM',
      stream,
      'MAXLEN',
      '=',
      String(options.maxInboxLength),
    ]);
    inboxesTrimmed += 1;
  }

  return {
    projectionCandidates: candidates.length,
    projectionsPruned,
    projectionsDeferredForIdempotency,
    projectionsDeferredForWake,
    deferredWakeIntentIds,
    wakeIntentsPruned,
    inboxesTrimmed,
    inboxesDeferred,
  };
}
