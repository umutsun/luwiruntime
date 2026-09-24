import {
  canonicalJsonStringify,
  inboxClaimResponseSchema,
  inboxEnvelopeSchema,
  type AgentMessage,
  type CanonicalJsonValue,
  type InboxClaimResponse,
} from '@luwi/protocol';

import { SESSION_INBOX_CONSUMER_GROUP, type RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

type RawStreamEntry = [streamId: string, fields: unknown];

export type ClaimSessionInboxInput = {
  client: RedisCommandClient;
  keys: RedisKeys;
  sessionId: string;
  bridgeInstanceId: string;
  limit: number;
  minIdleMs: number;
  getMessage: (messageId: string) => Promise<AgentMessage | null>;
  markDelivered: (correlationId: string, streamId: string) => Promise<void>;
  onInvalidEntry?: (diagnostic: {
    streamId: string;
    reason: 'envelope_invalid' | 'projection_missing' | 'projection_mismatch';
  }) => Promise<void> | void;
};

function isBusyGroup(error: unknown): boolean {
  return error instanceof Error && /BUSYGROUP/i.test(error.message);
}

export async function ensureSessionInboxGroup(
  client: RedisCommandClient,
  stream: string,
): Promise<void> {
  try {
    await client.sendCommand([
      'XGROUP',
      'CREATE',
      stream,
      SESSION_INBOX_CONSUMER_GROUP,
      '0-0',
      'MKSTREAM',
    ]);
  } catch (error) {
    if (!isBusyGroup(error)) {
      throw error;
    }
  }
}

function parseEntries(value: unknown): RawStreamEntry[] {
  if (!Array.isArray(value)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis inbox entries are invalid.');
  }
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis inbox entry is invalid.');
    }
    return [entry[0], entry[1]];
  });
}

function parseAutoClaim(reply: unknown): RawStreamEntry[] {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis inbox recovery is invalid.');
  }
  return parseEntries(reply[1]);
}

function parseReadGroup(reply: unknown): RawStreamEntry[] {
  if (reply === null) {
    return [];
  }
  if (typeof reply === 'object' && !Array.isArray(reply)) {
    const entries: RawStreamEntry[] = [];
    for (const value of Object.values(reply)) {
      entries.push(...parseEntries(value));
    }
    return entries;
  }
  if (!Array.isArray(reply)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis inbox read is invalid.');
  }
  const entries: RawStreamEntry[] = [];
  for (const stream of reply) {
    if (!Array.isArray(stream) || stream.length !== 2) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis inbox read is invalid.');
    }
    entries.push(...parseEntries(stream[1]));
  }
  return entries;
}

function fieldValue(fields: unknown, expected: string): string | null {
  if (!Array.isArray(fields)) {
    return null;
  }
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === expected && typeof fields[index + 1] === 'string') {
      return fields[index + 1];
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyArray(value: unknown): unknown {
  return value === null ||
    value === undefined ||
    (isRecord(value) && Object.keys(value).length === 0)
    ? []
    : value;
}

function normalizeInboxEnvelope(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.payload)) {
    return value;
  }
  if (value.itemKind === 'request') {
    return {
      ...value,
      payload: {
        ...value.payload,
        evidenceRequirements: emptyArray(value.payload.evidenceRequirements),
      },
    };
  }
  if (value.itemKind === 'response' && isRecord(value.payload.response)) {
    return {
      ...value,
      payload: {
        ...value.payload,
        response: {
          ...value.payload.response,
          evidence: emptyArray(value.payload.response.evidence),
        },
      },
    };
  }
  return value;
}

async function acknowledge(
  client: RedisCommandClient,
  stream: string,
  streamId: string,
): Promise<void> {
  await client.sendCommand(['XACK', stream, SESSION_INBOX_CONSUMER_GROUP, streamId]);
}

const terminalStates = new Set<AgentMessage['state']>([
  'responded',
  'rejected',
  'timed_out',
  'failed',
]);

function canonical(value: unknown): string {
  return canonicalJsonStringify(JSON.parse(JSON.stringify(value) ?? 'null') as CanonicalJsonValue);
}

function envelopeMatchesProjection(
  envelope: Exclude<InboxClaimResponse['items'][number], { itemKind: 'notice' }>,
  message: AgentMessage,
): boolean {
  if (envelope.messageId !== message.id || envelope.correlationId !== message.correlationId) {
    return false;
  }
  if (envelope.itemKind === 'request') {
    return (
      envelope.sourceSessionId === message.sourceSessionId &&
      envelope.targetSessionId === message.targetSessionId &&
      envelope.createdAt === message.createdAt &&
      envelope.payload.kind === message.kind &&
      envelope.payload.subject === message.subject &&
      envelope.payload.content === message.content &&
      envelope.payload.deadlineAt === message.deadlineAt &&
      canonical(envelope.payload.evidenceRequirements) ===
        canonical(message.evidenceRequirements ?? [])
    );
  }
  return (
    envelope.sourceSessionId === message.targetSessionId &&
    envelope.targetSessionId === message.sourceSessionId &&
    envelope.createdAt === message.updatedAt &&
    envelope.payload.state === message.state &&
    canonical(envelope.payload.response ?? null) === canonical(message.response ?? null)
  );
}

export async function claimSessionInbox(
  input: ClaimSessionInboxInput,
): Promise<InboxClaimResponse> {
  const stream = input.keys.sessionInbox(input.sessionId);
  const consumer = `bridge-${input.bridgeInstanceId}`;
  await ensureSessionInboxGroup(input.client, stream);

  const recovered = parseAutoClaim(
    await input.client.sendCommand([
      'XAUTOCLAIM',
      stream,
      SESSION_INBOX_CONSUMER_GROUP,
      consumer,
      String(input.minIdleMs),
      '0-0',
      'COUNT',
      String(input.limit),
    ]),
  );

  const remaining = input.limit - recovered.length;
  let fresh: RawStreamEntry[] = [];
  if (remaining > 0) {
    fresh = parseReadGroup(
      await input.client.sendCommand([
        'XREADGROUP',
        'GROUP',
        SESSION_INBOX_CONSUMER_GROUP,
        consumer,
        'COUNT',
        String(remaining),
        'STREAMS',
        stream,
        '>',
      ]),
    );
  }

  const items: InboxClaimResponse['items'] = [];
  let invalidEntries = 0;
  for (const [streamId, fields] of [...recovered, ...fresh]) {
    const json = fieldValue(fields, 'item');
    let decoded: unknown;
    try {
      decoded = json === null ? null : (JSON.parse(json) as unknown);
    } catch {
      decoded = null;
    }
    const parsed = inboxEnvelopeSchema.safeParse(
      typeof decoded === 'object' && decoded !== null
        ? normalizeInboxEnvelope({ ...(decoded as Record<string, unknown>), streamId })
        : decoded,
    );
    if (!parsed.success) {
      invalidEntries += 1;
      await input.onInvalidEntry?.({ streamId, reason: 'envelope_invalid' });
      await acknowledge(input.client, stream, streamId);
      continue;
    }

    // A notice (ADR 0035) has no message projection: it is a wake-up for a
    // coordinator, returned once and acknowledged on claim, so a lost or
    // duplicated one costs latency and never correctness.
    if (parsed.data.itemKind === 'notice') {
      items.push(parsed.data);
      await acknowledge(input.client, stream, streamId);
      continue;
    }

    const message = await input.getMessage(parsed.data.messageId);
    if (message === null || message.correlationId !== parsed.data.correlationId) {
      invalidEntries += 1;
      await input.onInvalidEntry?.({ streamId, reason: 'projection_missing' });
      await acknowledge(input.client, stream, streamId);
      continue;
    }
    if (!envelopeMatchesProjection(parsed.data, message)) {
      invalidEntries += 1;
      await input.onInvalidEntry?.({ streamId, reason: 'projection_mismatch' });
      await acknowledge(input.client, stream, streamId);
      continue;
    }
    if (parsed.data.itemKind === 'request') {
      if (terminalStates.has(message.state)) {
        await acknowledge(input.client, stream, streamId);
        continue;
      }
      if (message.state === 'queued') {
        await input.markDelivered(parsed.data.correlationId, streamId);
      }
      items.push(parsed.data);
      continue;
    }

    if (!terminalStates.has(message.state)) {
      invalidEntries += 1;
      await input.onInvalidEntry?.({ streamId, reason: 'projection_mismatch' });
      await acknowledge(input.client, stream, streamId);
      continue;
    }
    items.push(parsed.data);
    await acknowledge(input.client, stream, streamId);
  }

  if (items.length === 0 && invalidEntries > 0) {
    throw new RedisRepositoryError('INBOX_ENTRY_INVALID', 'The inbox contains an invalid entry.');
  }
  return inboxClaimResponseSchema.parse({ items });
}
