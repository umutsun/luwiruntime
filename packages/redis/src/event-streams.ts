import { createHash } from 'node:crypto';

import {
  realtimeEventMessageSchema,
  runtimeEventSchema,
  type RealtimeEventMessage,
} from '@luwi/protocol';

import type { RedisCommandClient } from './runtime-repository.js';
import { RedisRepositoryError } from './runtime-repository.js';

export const REALTIME_CONSUMER_GROUP = 'luwi-realtime-v1';

type GroupMetadata = {
  name?: string;
  pending?: number;
  lag?: number;
};

function pairsToRecord(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const record: Record<string, unknown> = {};
    for (let index = 0; index < value.length; index += 2) {
      const key = value[index];
      if (typeof key === 'string') {
        record[key] = value[index + 1];
      }
    }
    return record;
  }
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseGroups(reply: unknown): GroupMetadata[] {
  if (!Array.isArray(reply)) {
    throw new Error('Redis returned invalid consumer-group metadata.');
  }
  return reply.map((value) => {
    const record = pairsToRecord(value);
    return {
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.pending === 'number' ? { pending: record.pending } : {}),
      ...(typeof record.lag === 'number' ? { lag: record.lag } : {}),
    };
  });
}

export async function ensureRealtimeStreamGroup(
  client: RedisCommandClient,
  stream: string,
  group: string,
): Promise<{ created: boolean }> {
  const typeReply = await client.sendCommand(['TYPE', stream]);
  if (typeReply !== 'none' && typeReply !== 'stream') {
    throw new Error('The global event key is not a Redis Stream.');
  }

  if (typeReply === 'stream') {
    const groups = parseGroups(await client.sendCommand(['XINFO', 'GROUPS', stream]));
    if (groups.some((metadata) => metadata.name === group)) {
      return { created: false };
    }
  }

  try {
    await client.sendCommand([
      'XGROUP',
      'CREATE',
      stream,
      group,
      '$',
      ...(typeReply === 'none' ? ['MKSTREAM'] : []),
    ]);
    return { created: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes('BUSYGROUP')) {
      return { created: false };
    }
    throw error;
  }
}

export type StreamRetentionOptions = {
  client: RedisCommandClient;
  globalStream: string;
  projectStream: (projectId: string) => string;
  deadLetterStream: string;
  projectsIndex: string;
  consumerGroup: string;
  globalMaxLength: number;
  projectMaxLength: number;
  deadLetterMaxLength: number;
  relayHealthy: boolean;
};

export type StreamRetentionResult = {
  globalTrimmed: boolean;
  globalDeferredReason: 'relay_unhealthy' | 'metadata_unavailable' | 'pending' | 'lag' | undefined;
  projectStreamsTrimmed: number;
  deadLetterTrimmed: boolean;
};

async function trim(client: RedisCommandClient, stream: string, maxLength: number): Promise<void> {
  await client.sendCommand(['XTRIM', stream, 'MAXLEN', '~', String(maxLength)]);
}

export async function runStreamRetention(
  options: StreamRetentionOptions,
): Promise<StreamRetentionResult> {
  const groups = parseGroups(
    await options.client.sendCommand(['XINFO', 'GROUPS', options.globalStream]),
  );
  const group = groups.find((metadata) => metadata.name === options.consumerGroup);
  let globalDeferredReason: StreamRetentionResult['globalDeferredReason'];
  if (!options.relayHealthy) {
    globalDeferredReason = 'relay_unhealthy';
  } else if (group?.pending === undefined || group.lag === undefined) {
    globalDeferredReason = 'metadata_unavailable';
  } else if (group.pending !== 0) {
    globalDeferredReason = 'pending';
  } else if (group.lag !== 0) {
    globalDeferredReason = 'lag';
  }

  if (globalDeferredReason === undefined) {
    await trim(options.client, options.globalStream, options.globalMaxLength);
  }

  const projectReply = await options.client.sendCommand(['SMEMBERS', options.projectsIndex]);
  if (!Array.isArray(projectReply) || !projectReply.every((value) => typeof value === 'string')) {
    throw new Error('Redis returned an invalid project index during retention.');
  }
  for (const projectId of projectReply) {
    await trim(
      options.client,
      options.projectStream(projectId as string),
      options.projectMaxLength,
    );
  }
  await trim(options.client, options.deadLetterStream, options.deadLetterMaxLength);

  return {
    globalTrimmed: globalDeferredReason === undefined,
    globalDeferredReason,
    projectStreamsTrimmed: projectReply.length,
    deadLetterTrimmed: true,
  };
}

type RawStreamEntry = { streamId: string; fields: string[] };

function parseRawEntries(reply: unknown): RawStreamEntry[] {
  if (!Array.isArray(reply)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned invalid event history.');
  }
  return reply.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !Array.isArray(entry[1]) ||
      !entry[1].every((field) => typeof field === 'string')
    ) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned invalid event history.');
    }
    return { streamId: entry[0], fields: entry[1] };
  });
}

async function deadLetterHistoryEntry(options: {
  client: RedisCommandClient;
  deadLetterStream: string;
  deadLetterMaxLength: number;
  sourceStream: string;
  entry: RawStreamEntry;
  now: () => Date;
}): Promise<void> {
  const fieldNames = options.entry.fields
    .filter((_value, index) => index % 2 === 0)
    .map((name) => (/^[A-Za-z0-9._:-]{1,128}$/.test(name) ? name : 'redacted'));
  await options.client.sendCommand([
    'XADD',
    options.deadLetterStream,
    'MAXLEN',
    '~',
    String(options.deadLetterMaxLength),
    '*',
    'sourceStream',
    options.sourceStream,
    'sourceStreamId',
    options.entry.streamId,
    'reason',
    'RUNTIME_EVENT_INVALID',
    'eventType',
    'unknown',
    'detectedAt',
    options.now().toISOString(),
    'fieldsSha256',
    createHash('sha256').update(JSON.stringify(options.entry.fields)).digest('hex'),
    'preview',
    JSON.stringify({ fieldNames }).slice(0, 2_048),
  ]);
}

export async function readLatestRuntimeEvents(options: {
  client: RedisCommandClient;
  stream: string;
  deadLetterStream: string;
  deadLetterMaxLength: number;
  limit: number;
  now?: () => Date;
}): Promise<RealtimeEventMessage[]> {
  const entries = parseRawEntries(
    await options.client.sendCommand([
      'XREVRANGE',
      options.stream,
      '+',
      '-',
      'COUNT',
      String(options.limit),
    ]),
  );
  const messages: RealtimeEventMessage[] = [];
  for (const entry of entries) {
    const rawEvent =
      entry.fields.length === 2 && entry.fields[0] === 'event' ? entry.fields[1] : undefined;
    try {
      if (rawEvent === undefined) {
        throw new Error('Missing event field');
      }
      const event = runtimeEventSchema.parse(JSON.parse(rawEvent) as unknown);
      messages.push(realtimeEventMessageSchema.parse({ streamId: entry.streamId, event }));
    } catch {
      await deadLetterHistoryEntry({
        client: options.client,
        deadLetterStream: options.deadLetterStream,
        deadLetterMaxLength: options.deadLetterMaxLength,
        sourceStream: options.stream,
        entry,
        now: options.now ?? (() => new Date()),
      });
      throw new RedisRepositoryError(
        'REDIS_DATA_INVALID',
        'Redis contains an invalid Runtime event.',
      );
    }
  }
  return messages.reverse();
}
