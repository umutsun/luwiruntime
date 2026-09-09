import { wakeIntentViewSchema, type WakeIntentView } from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

export interface WakeIntentRepository {
  getByMessage(messageId: string): Promise<WakeIntentView | null>;
}

function invalid(): never {
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis wake intent data is invalid.');
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

/** Reads only the explicitly public wake projection; every private hash field is discarded. */
function parseStoredWakeIntent(reply: unknown, expectedMessageId: string): WakeIntentView | null {
  const record = pairsToRecord(reply);
  if (record === null) return null;
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
  if (
    !parsed.success ||
    parsed.data.id !== expectedMessageId ||
    parsed.data.messageId !== expectedMessageId
  ) {
    return invalid();
  }
  return parsed.data;
}

export function createWakeIntentRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
}): WakeIntentRepository {
  const { client, keys } = options;
  return {
    async getByMessage(messageId) {
      return parseStoredWakeIntent(
        await client.sendCommand(['HGETALL', keys.wakeIntent(messageId)]),
        messageId,
      );
    },
  };
}
