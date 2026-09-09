import { randomUUID } from 'node:crypto';

import {
  wakeIntentClaimRequestSchema,
  wakeIntentCompleteRequestSchema,
  wakeIntentDispatchingRequestSchema,
  wakeIntentListQuerySchema,
  wakeIntentViewSchema,
  type WakeIntentCompleteRequest,
  type WakeIntentListQuery,
  type WakeIntentView,
} from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import { WAKE_CONSUMER_GROUP, type RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

export type WakeClaimInput = { dispatcherInstanceId: string; limit: number; blockMs: number };
export type WakeReclaimInput = { dispatcherInstanceId: string; limit: number; minIdleMs: number };
export type ClaimedWakeIntent = { intent: WakeIntentView; claimId: string };
export type WakeClaimBatch = {
  items: ClaimedWakeIntent[];
  recoveredDispatching: WakeIntentView[];
  terminalAcknowledged: number;
};
export type WakeIntentMutationResult = {
  status: 'updated' | 'unchanged';
  intent: WakeIntentView;
};
export type MarkWakeDispatchingInput = {
  intentId: string;
  dispatcherInstanceId: string;
  claimId: string;
  attemptId: string;
  eventId: string;
};
export type CompleteWakeIntentInput = MarkWakeDispatchingInput & {
  state: WakeIntentCompleteRequest['state'];
  reasonCode: string;
};
export type RecoverDispatchingWakeInput = {
  intentId: string;
  dispatcherInstanceId: string;
  eventId: string;
};
export type SweepWakeIntentsInput = { nowMs: number; limit: number };
export type SweepWakeIntentsResult = {
  candidates: number;
  fallbackOnly: number;
  unchanged: number;
};

export interface WakeIntentRepository {
  createGroupAtZero(): Promise<{ created: boolean }>;
  get(intentId: string): Promise<WakeIntentView | null>;
  getByMessage(messageId: string): Promise<WakeIntentView | null>;
  list(query?: Partial<WakeIntentListQuery>): Promise<WakeIntentView[]>;
  claim(input: WakeClaimInput): Promise<WakeClaimBatch>;
  reclaim(input: WakeReclaimInput): Promise<WakeClaimBatch>;
  markDispatching(input: MarkWakeDispatchingInput): Promise<WakeIntentMutationResult>;
  complete(input: CompleteWakeIntentInput): Promise<WakeIntentMutationResult>;
  recoverDispatching(input: RecoverDispatchingWakeInput): Promise<WakeIntentMutationResult>;
  sweep(input: SweepWakeIntentsInput): Promise<SweepWakeIntentsResult>;
}

type StoredWakeIntent = {
  intent: WakeIntentView;
  workspaceId: string;
  projectId: string;
  sourceAgentId: string;
  workflowRevision: number;
  streamId: string;
  deadlineMs: number;
  fallbackContinuationId: string;
  requestedEventId: string;
  lastEventId: string;
  dispatcherInstanceId?: string;
  claimId?: string;
  attemptId?: string;
  streamAcknowledgedAt?: string;
};
type RawStreamEntry = [streamId: string, fields: unknown];
type ParsedAutoClaim = { cursor: string; entries: RawStreamEntry[] };
type ClaimTransition =
  | { status: 'claimed'; item: ClaimedWakeIntent }
  | { status: 'recover_dispatching' }
  | { status: 'terminal_acknowledged' };

const terminalWakeStates = new Set<WakeIntentView['state']>([
  'dispatched',
  'fallback_only',
  'indeterminate',
]);
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const redisStreamIdPattern = /^\d+-\d+$/;
const LIST_SCAN_PAGE_SIZE = 1000;
const MAX_LIST_SCAN_PAGES = 10;
const MAX_RECLAIM_SCAN_PAGES = 10;

function invalid(): never {
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis wake intent data is invalid.');
}

function argumentInvalid(message: string): never {
  throw new RedisRepositoryError('REDIS_ARGUMENT_INVALID', message);
}

function assertIdentifier(value: string, field: string): string {
  if (!safeIdentifierPattern.test(value)) return argumentInvalid(`${field} is invalid.`);
  return value;
}

function pairsToRecord(reply: unknown): Record<string, string> | null {
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    if (reply.length % 2 !== 0) return invalid();
    const record: Record<string, string> = {};
    for (let index = 0; index < reply.length; index += 2) {
      const field = reply[index];
      const value = reply[index + 1];
      if (typeof field !== 'string' || typeof value !== 'string') return invalid();
      record[field] = value;
    }
    return record;
  }

  if (reply === null || typeof reply !== 'object') return invalid();
  const entries = Object.entries(reply);
  if (entries.length === 0) return null;
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    return invalid();
  }
  return Object.fromEntries(entries);
}

function publicProjection(record: Record<string, string>): WakeIntentView {
  const parsed = wakeIntentViewSchema.safeParse({
    id: record.id,
    messageId: record.messageId,
    workflowId: record.workflowId,
    sourceSessionId: record.sourceSessionId,
    correlationId: record.correlationId,
    terminalState: record.terminalState,
    adapter: record.adapter,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
  });
  if (!parsed.success) return invalid();
  return parsed.data;
}

/** Reads only the explicitly public wake projection; every private hash field is discarded. */
function parseStoredWakeIntent(reply: unknown, expectedMessageId: string): WakeIntentView | null {
  const record = pairsToRecord(reply);
  if (record === null) return null;
  const parsed = publicProjection(record);
  if (parsed.id !== expectedMessageId || parsed.messageId !== expectedMessageId) return invalid();
  return parsed;
}

function requiredPrivate(record: Record<string, string>, field: string): string {
  const value = record[field];
  if (value === undefined || value.length === 0) return invalid();
  return value;
}

function optionalPrivate(record: Record<string, string>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value.length === 0) return invalid();
  return value;
}

function parseStoredPrivate(reply: unknown, expectedIntentId: string): StoredWakeIntent {
  const record = pairsToRecord(reply);
  if (record === null) return invalid();
  const intent = publicProjection(record);
  if (intent.id !== expectedIntentId || intent.messageId !== expectedIntentId) return invalid();
  const workflowRevision = Number(requiredPrivate(record, 'workflowRevision'));
  const deadlineMs = Number(requiredPrivate(record, 'deadlineMs'));
  const streamId = requiredPrivate(record, 'streamId');
  if (
    !Number.isSafeInteger(workflowRevision) ||
    workflowRevision < 1 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    !redisStreamIdPattern.test(streamId)
  ) {
    return invalid();
  }
  const dispatcherInstanceId = optionalPrivate(record, 'dispatcherInstanceId');
  const claimId = optionalPrivate(record, 'claimId');
  const attemptId = optionalPrivate(record, 'attemptId');
  if (
    (intent.state === 'claimed' && (dispatcherInstanceId === undefined || claimId === undefined)) ||
    (intent.state === 'dispatching' &&
      (dispatcherInstanceId === undefined || claimId === undefined || attemptId === undefined))
  ) {
    return invalid();
  }
  return {
    intent,
    workspaceId: requiredPrivate(record, 'workspaceId'),
    projectId: requiredPrivate(record, 'projectId'),
    sourceAgentId: requiredPrivate(record, 'sourceAgentId'),
    workflowRevision,
    streamId,
    deadlineMs,
    fallbackContinuationId: requiredPrivate(record, 'fallbackContinuationId'),
    requestedEventId: requiredPrivate(record, 'requestedEventId'),
    lastEventId: requiredPrivate(record, 'lastEventId'),
    ...(dispatcherInstanceId === undefined ? {} : { dispatcherInstanceId }),
    ...(claimId === undefined ? {} : { claimId }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(record.streamAcknowledgedAt === undefined
      ? {}
      : { streamAcknowledgedAt: requiredPrivate(record, 'streamAcknowledgedAt') }),
  };
}

function decode(reply: unknown): Record<string, unknown> {
  if (typeof reply !== 'string') return invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(reply) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return invalid();
  return decoded as Record<string, unknown>;
}

function functionError(reply: Record<string, unknown>): never {
  if (reply.status === 'error' && typeof reply.code === 'string') {
    throw new RedisRepositoryError(reply.code, 'Redis rejected the wake intent transition.');
  }
  return invalid();
}

function projectionFromFunction(value: unknown, expectedIntentId: string): WakeIntentView {
  const record = pairsToRecord(value);
  if (record === null) return invalid();
  const intent = publicProjection(record);
  if (intent.id !== expectedIntentId || intent.messageId !== expectedIntentId) return invalid();
  return intent;
}

function parseMutation(reply: unknown, expectedIntentId: string): WakeIntentMutationResult {
  const decoded = decode(reply);
  if (decoded.status === 'error') return functionError(decoded);
  if (decoded.status !== 'updated' && decoded.status !== 'unchanged') return invalid();
  return {
    status: decoded.status,
    intent: projectionFromFunction(decoded.intent, expectedIntentId),
  };
}

function parseEntries(value: unknown): RawStreamEntry[] {
  if (!Array.isArray(value)) return invalid();
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      return invalid();
    }
    if (!redisStreamIdPattern.test(entry[0])) return invalid();
    return [entry[0], entry[1]];
  });
}

function parseReadGroup(reply: unknown): RawStreamEntry[] {
  if (reply === null) return [];
  if (typeof reply === 'object' && !Array.isArray(reply)) {
    return Object.values(reply).flatMap((value) => parseEntries(value));
  }
  if (!Array.isArray(reply)) return invalid();
  const entries: RawStreamEntry[] = [];
  for (const stream of reply) {
    if (!Array.isArray(stream) || stream.length !== 2) return invalid();
    entries.push(...parseEntries(stream[1]));
  }
  return entries;
}

function parseAutoClaim(reply: unknown): ParsedAutoClaim {
  if (!Array.isArray(reply) || reply.length < 2 || reply.length > 3) return invalid();
  if (typeof reply[0] !== 'string' || !redisStreamIdPattern.test(reply[0])) return invalid();
  if (
    reply.length === 3 &&
    (!Array.isArray(reply[2]) ||
      !reply[2].every((value) => typeof value === 'string' && redisStreamIdPattern.test(value)))
  ) {
    return invalid();
  }
  return { cursor: reply[0], entries: parseEntries(reply[1]) };
}

function fieldValue(fields: unknown, expected: string): string | null {
  const record = pairsToRecord(fields);
  return record?.[expected] ?? null;
}

function isBusyGroup(error: unknown): boolean {
  return error instanceof Error && /BUSYGROUP/i.test(error.message);
}

function parseIndex(reply: unknown): string[] {
  if (!Array.isArray(reply) || !reply.every((id): id is string => typeof id === 'string')) {
    return invalid();
  }
  return reply;
}

function parseRedisMilliseconds(reply: unknown): number {
  if (
    !Array.isArray(reply) ||
    reply.length !== 2 ||
    !reply.every((part) => typeof part === 'string' && /^\d+$/.test(part))
  ) {
    return invalid();
  }
  const seconds = Number(reply[0]);
  const microseconds = Number(reply[1]);
  const milliseconds = seconds * 1000 + Math.floor(microseconds / 1000);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(microseconds) ||
    microseconds > 999_999 ||
    !Number.isSafeInteger(milliseconds)
  ) {
    return invalid();
  }
  return milliseconds;
}

export function createWakeIntentRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
  createId?: () => string;
}): WakeIntentRepository {
  const { client, keys, functions } = options;
  const createId = options.createId ?? randomUUID;
  const reclaimCursors = new Map<string, string>();

  const readStored = async (intentId: string): Promise<StoredWakeIntent> =>
    parseStoredPrivate(
      await client.sendCommand([
        'HGETALL',
        keys.wakeIntent(assertIdentifier(intentId, 'intentId')),
      ]),
      intentId,
    );

  const wakeKeys = (stored: StoredWakeIntent): string[] => [
    keys.wakeIntent(stored.intent.id),
    keys.wakeStream,
    keys.globalEvents,
    keys.projectEvents(stored.projectId),
  ];

  const terminalKeys = (stored: StoredWakeIntent): string[] => [
    ...wakeKeys(stored),
    keys.wakeIntentDeadlines,
    keys.workflow(stored.intent.workflowId),
  ];

  const claimEntry = async (
    entry: RawStreamEntry,
    dispatcherInstanceId: string,
  ): Promise<ClaimTransition> => {
    const [streamId, fields] = entry;
    const intentId = fieldValue(fields, 'wakeIntentId');
    if (intentId === null) return invalid();
    assertIdentifier(intentId, 'wakeIntentId');
    const stored = await readStored(intentId);
    if (stored.streamId !== streamId) return invalid();
    const claimId = assertIdentifier(createId(), 'claimId');
    const eventId = assertIdentifier(createId(), 'eventId');
    const command = [
      'FCALL',
      functions.functions.wakeClaim,
      '4',
      ...wakeKeys(stored),
      intentId,
      streamId,
      dispatcherInstanceId,
      claimId,
      eventId,
      WAKE_CONSUMER_GROUP,
    ];
    let decoded: Record<string, unknown>;
    try {
      decoded = decode(await client.sendCommand(command));
    } catch (error) {
      let reread: StoredWakeIntent;
      try {
        reread = await readStored(intentId);
      } catch {
        throw error;
      }
      if (
        reread.intent.state === 'claimed' &&
        reread.dispatcherInstanceId === dispatcherInstanceId &&
        reread.claimId === claimId
      ) {
        return { status: 'claimed', item: { intent: reread.intent, claimId } };
      }
      if (reread.intent.state === 'dispatching') return { status: 'recover_dispatching' };
      if (
        terminalWakeStates.has(reread.intent.state) &&
        reread.streamAcknowledgedAt !== undefined
      ) {
        return { status: 'terminal_acknowledged' };
      }
      throw error;
    }
    if (decoded.status === 'error') return functionError(decoded);
    if (decoded.status === 'recover_dispatching') return { status: 'recover_dispatching' };
    if (decoded.status === 'terminal_acknowledged') return { status: 'terminal_acknowledged' };
    if (decoded.status !== 'updated' && decoded.status !== 'unchanged') return invalid();
    if (decoded.claimId !== claimId) return invalid();
    const intent = projectionFromFunction(decoded.intent, intentId);
    if (intent.state !== 'claimed') return invalid();
    return { status: 'claimed', item: { intent, claimId } };
  };

  const recoverOne = async (
    input: RecoverDispatchingWakeInput,
  ): Promise<WakeIntentMutationResult> => {
    assertIdentifier(input.dispatcherInstanceId, 'dispatcherInstanceId');
    assertIdentifier(input.eventId, 'eventId');
    const stored = await readStored(input.intentId);
    const result = parseMutation(
      await client.sendCommand([
        'FCALL',
        functions.functions.wakeRecoverDispatching,
        '6',
        ...terminalKeys(stored),
        stored.intent.id,
        stored.streamId,
        input.dispatcherInstanceId,
        input.eventId,
        WAKE_CONSUMER_GROUP,
      ]),
      stored.intent.id,
    );
    if (result.intent.state !== 'indeterminate') return invalid();
    return result;
  };

  const processEntries = async (
    entries: RawStreamEntry[],
    dispatcherInstanceId: string,
  ): Promise<WakeClaimBatch> => {
    const items: ClaimedWakeIntent[] = [];
    const recoverIds: string[] = [];
    let terminalAcknowledged = 0;
    for (const entry of entries) {
      const transition = await claimEntry(entry, dispatcherInstanceId);
      if (transition.status === 'claimed') items.push(transition.item);
      else if (transition.status === 'recover_dispatching') {
        const intentId = fieldValue(entry[1], 'wakeIntentId');
        if (intentId === null) return invalid();
        recoverIds.push(intentId);
      } else terminalAcknowledged += 1;
    }
    const recoveredDispatching: WakeIntentView[] = [];
    for (const intentId of recoverIds) {
      const result = await recoverOne({
        intentId,
        dispatcherInstanceId,
        eventId: assertIdentifier(createId(), 'eventId'),
      });
      if (result.intent.state !== 'indeterminate') return invalid();
      recoveredDispatching.push(result.intent);
    }
    return { items, recoveredDispatching, terminalAcknowledged };
  };

  return {
    async createGroupAtZero() {
      try {
        await client.sendCommand([
          'XGROUP',
          'CREATE',
          keys.wakeStream,
          WAKE_CONSUMER_GROUP,
          '0-0',
          'MKSTREAM',
        ]);
        return { created: true };
      } catch (error) {
        if (isBusyGroup(error)) return { created: false };
        throw error;
      }
    },
    async get(intentId) {
      assertIdentifier(intentId, 'intentId');
      return parseStoredWakeIntent(
        await client.sendCommand(['HGETALL', keys.wakeIntent(intentId)]),
        intentId,
      );
    },
    async getByMessage(messageId) {
      assertIdentifier(messageId, 'messageId');
      return parseStoredWakeIntent(
        await client.sendCommand(['HGETALL', keys.wakeIntent(messageId)]),
        messageId,
      );
    },
    async list(query = {}) {
      const parsed = wakeIntentListQuerySchema.safeParse(query);
      if (!parsed.success) return argumentInvalid('Wake intent list query is invalid.');
      const index =
        parsed.data.projectId === undefined
          ? keys.wakeIntentsIndex
          : keys.projectWakeIntents(parsed.data.projectId);
      const wakeIntents: WakeIntentView[] = [];
      const pageSize = parsed.data.state === undefined ? parsed.data.limit : LIST_SCAN_PAGE_SIZE;
      const maxPages = parsed.data.state === undefined ? 1 : MAX_LIST_SCAN_PAGES;
      let offset = 0;
      for (let page = 0; page < maxPages; page += 1) {
        const ids = parseIndex(
          await client.sendCommand([
            'ZRANGE',
            index,
            String(offset),
            String(offset + pageSize - 1),
          ]),
        );
        for (const id of ids) {
          assertIdentifier(id, 'wakeIntentId');
          const stored = await readStored(id);
          if (parsed.data.projectId !== undefined && stored.projectId !== parsed.data.projectId) {
            return invalid();
          }
          if (parsed.data.state === undefined || stored.intent.state === parsed.data.state) {
            wakeIntents.push(stored.intent);
            if (wakeIntents.length === parsed.data.limit) return wakeIntents;
          }
        }
        if (ids.length < pageSize) break;
        offset += ids.length;
      }
      return wakeIntents;
    },
    async claim(input) {
      const parsed = wakeIntentClaimRequestSchema.safeParse({ ...input, minIdleMs: 0 });
      if (!parsed.success) return argumentInvalid('Wake intent claim is invalid.');
      const command = [
        'XREADGROUP',
        'GROUP',
        WAKE_CONSUMER_GROUP,
        parsed.data.dispatcherInstanceId,
        'COUNT',
        String(parsed.data.limit),
        ...(parsed.data.blockMs === 0 ? [] : ['BLOCK', String(parsed.data.blockMs)]),
        'STREAMS',
        keys.wakeStream,
        '>',
      ];
      return processEntries(
        parseReadGroup(await client.sendCommand(command)),
        parsed.data.dispatcherInstanceId,
      );
    },
    async reclaim(input) {
      const parsed = wakeIntentClaimRequestSchema.safeParse({ ...input, blockMs: 0 });
      if (!parsed.success) return argumentInvalid('Wake intent recovery claim is invalid.');
      const combined: WakeClaimBatch = {
        items: [],
        recoveredDispatching: [],
        terminalAcknowledged: 0,
      };
      let cursor = reclaimCursors.get(parsed.data.dispatcherInstanceId) ?? '0-0';
      for (let page = 0; page < MAX_RECLAIM_SCAN_PAGES; page += 1) {
        const remaining =
          parsed.data.limit -
          combined.items.length -
          combined.recoveredDispatching.length -
          combined.terminalAcknowledged;
        if (remaining === 0) break;
        const claimed = parseAutoClaim(
          await client.sendCommand([
            'XAUTOCLAIM',
            keys.wakeStream,
            WAKE_CONSUMER_GROUP,
            parsed.data.dispatcherInstanceId,
            String(parsed.data.minIdleMs),
            cursor,
            'COUNT',
            String(remaining),
          ]),
        );
        cursor = claimed.cursor;
        if (cursor === '0-0') reclaimCursors.delete(parsed.data.dispatcherInstanceId);
        else reclaimCursors.set(parsed.data.dispatcherInstanceId, cursor);
        const processed = await processEntries(claimed.entries, parsed.data.dispatcherInstanceId);
        combined.items.push(...processed.items);
        combined.recoveredDispatching.push(...processed.recoveredDispatching);
        combined.terminalAcknowledged += processed.terminalAcknowledged;
        if (cursor === '0-0') break;
      }
      return combined;
    },
    async markDispatching(input) {
      assertIdentifier(input.intentId, 'intentId');
      assertIdentifier(input.eventId, 'eventId');
      const parsed = wakeIntentDispatchingRequestSchema.safeParse({
        dispatcherInstanceId: input.dispatcherInstanceId,
        claimId: input.claimId,
        attemptId: input.attemptId,
      });
      if (!parsed.success) return argumentInvalid('Wake dispatching fence is invalid.');
      const stored = await readStored(input.intentId);
      const command = [
        'FCALL',
        functions.functions.wakeDispatching,
        '4',
        ...wakeKeys(stored),
        stored.intent.id,
        stored.streamId,
        parsed.data.dispatcherInstanceId,
        parsed.data.claimId,
        parsed.data.attemptId,
        input.eventId,
        WAKE_CONSUMER_GROUP,
      ];
      try {
        const result = parseMutation(await client.sendCommand(command), stored.intent.id);
        if (result.intent.state !== 'dispatching') return invalid();
        return result;
      } catch (error) {
        let reread: StoredWakeIntent;
        try {
          reread = await readStored(input.intentId);
        } catch {
          throw error;
        }
        if (
          reread.intent.state === 'dispatching' &&
          reread.dispatcherInstanceId === parsed.data.dispatcherInstanceId &&
          reread.claimId === parsed.data.claimId &&
          reread.attemptId === parsed.data.attemptId
        ) {
          return { status: 'unchanged', intent: reread.intent };
        }
        throw error;
      }
    },
    async complete(input) {
      assertIdentifier(input.intentId, 'intentId');
      assertIdentifier(input.eventId, 'eventId');
      const parsed = wakeIntentCompleteRequestSchema.safeParse({
        dispatcherInstanceId: input.dispatcherInstanceId,
        claimId: input.claimId,
        attemptId: input.attemptId,
        state: input.state,
        reasonCode: input.reasonCode,
      });
      if (!parsed.success) return argumentInvalid('Wake completion fence is invalid.');
      const stored = await readStored(input.intentId);
      const result = parseMutation(
        await client.sendCommand([
          'FCALL',
          functions.functions.wakeComplete,
          '6',
          ...terminalKeys(stored),
          stored.intent.id,
          stored.streamId,
          parsed.data.dispatcherInstanceId,
          parsed.data.claimId,
          parsed.data.attemptId,
          parsed.data.state,
          parsed.data.reasonCode,
          input.eventId,
          WAKE_CONSUMER_GROUP,
        ]),
        stored.intent.id,
      );
      if (result.intent.state !== parsed.data.state) return invalid();
      return result;
    },
    recoverDispatching: recoverOne,
    async sweep(input) {
      if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
        return argumentInvalid('Wake sweep time is invalid.');
      }
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
        return argumentInvalid('Wake sweep limit is invalid.');
      }
      const redisNowMs = parseRedisMilliseconds(await client.sendCommand(['TIME']));
      const ids = parseIndex(
        await client.sendCommand([
          'ZRANGE',
          keys.wakeIntentDeadlines,
          '-inf',
          String(redisNowMs),
          'BYSCORE',
          'LIMIT',
          '0',
          String(input.limit),
        ]),
      );
      let fallbackOnly = 0;
      let unchanged = 0;
      for (const intentId of ids) {
        const stored = await readStored(intentId);
        const result = parseMutation(
          await client.sendCommand([
            'FCALL',
            functions.functions.wakeSweep,
            '6',
            ...terminalKeys(stored),
            stored.intent.id,
            stored.streamId,
            String(stored.deadlineMs),
            assertIdentifier(createId(), 'eventId'),
            WAKE_CONSUMER_GROUP,
            'wake_deadline_elapsed',
          ]),
          stored.intent.id,
        );
        if (result.status === 'updated' && result.intent.state === 'fallback_only') {
          fallbackOnly += 1;
        } else unchanged += 1;
      }
      return { candidates: ids.length, fallbackOnly, unchanged };
    },
  };
}
