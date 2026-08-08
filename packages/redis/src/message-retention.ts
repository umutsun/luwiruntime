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

const deleteTerminalProjectionScript =
  "local id=ARGV[1]; redis.call('DEL',KEYS[1],KEYS[2]); " +
  "for index=3,7 do redis.call('ZREM',KEYS[index],id) end; return 1";

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
): Promise<void> {
  const deleted = await options.client.sendCommand([
    'EVAL',
    deleteTerminalProjectionScript,
    '7',
    options.keys.message(identity.id),
    options.keys.messageCorrelation(identity.correlationId),
    options.keys.messagesIndex,
    options.keys.projectMessages(identity.projectId),
    options.keys.sourceSessionMessages(identity.sourceSessionId),
    options.keys.targetSessionMessages(identity.targetSessionId),
    options.keys.terminalMessages,
    identity.id,
  ]);
  if (Number(deleted) !== 1) {
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
    await deleteTerminalProjection(options, identity);
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
    inboxesTrimmed,
    inboxesDeferred,
  };
}
