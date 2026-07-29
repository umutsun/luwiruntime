import { createHash } from 'node:crypto';

import {
  LUWI_RUNTIME_VERSION,
  realtimeEventMessageSchema,
  runtimeEventSchema,
  type RealtimeEventMessage,
} from '@luwi/protocol';
import type { RedisCommandClient } from '@luwi/redis';

type StreamEntry = {
  streamId: string;
  fields: string[];
};

export type RealtimeRelayOptions = {
  client: RedisCommandClient;
  stream: string;
  group: string;
  consumer: string;
  deadLetterStream: string;
  claimIdleMs: number;
  blockMs: number;
  batchSize: number;
  deadLetterMaxLength: number;
  accept: (message: RealtimeEventMessage) => boolean | Promise<boolean>;
  onFailure: (error: Error) => void;
  now: () => Date;
};

export interface RealtimeRelay {
  readonly healthy: boolean;
  recoverPending(): Promise<void>;
  pollOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

function parseEntry(value: unknown): StreamEntry | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    !Array.isArray(value[1]) ||
    !value[1].every((field) => typeof field === 'string')
  ) {
    return null;
  }
  return { streamId: value[0], fields: value[1] };
}

function parseEntries(value: unknown): StreamEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parseEntry).filter((entry): entry is StreamEntry => entry !== null);
}

function readGroupEntries(reply: unknown): StreamEntry[] {
  if (reply === null) {
    return [];
  }
  if (reply !== null && typeof reply === 'object' && !Array.isArray(reply)) {
    return Object.values(reply as Record<string, unknown>).flatMap(parseEntries);
  }
  if (Array.isArray(reply)) {
    return reply.flatMap((stream) =>
      Array.isArray(stream) && stream.length === 2 ? parseEntries(stream[1]) : [],
    );
  }
  throw new Error('Redis returned an invalid XREADGROUP response.');
}

function claimedEntries(reply: unknown): { nextId: string; entries: StreamEntry[] } {
  if (!Array.isArray(reply) || typeof reply[0] !== 'string') {
    throw new Error('Redis returned an invalid XAUTOCLAIM response.');
  }
  return { nextId: reply[0], entries: parseEntries(reply[1]) };
}

function pendingCount(reply: unknown): number {
  if (Array.isArray(reply)) {
    return Number(reply[0]);
  }
  if (reply !== null && typeof reply === 'object') {
    return Number((reply as Record<string, unknown>).pending);
  }
  throw new Error('Redis returned an invalid XPENDING response.');
}

function eventField(entry: StreamEntry): string | null {
  if (entry.fields.length !== 2 || entry.fields[0] !== 'event') {
    return null;
  }
  return entry.fields[1] ?? null;
}

function parseMessage(entry: StreamEntry): RealtimeEventMessage | null {
  const rawEvent = eventField(entry);
  if (rawEvent === null) {
    return null;
  }
  try {
    const event = runtimeEventSchema.parse(JSON.parse(rawEvent) as unknown);
    return realtimeEventMessageSchema.parse({ streamId: entry.streamId, event });
  } catch {
    return null;
  }
}

function safeEventType(entry: StreamEntry): string {
  const rawEvent = eventField(entry);
  if (rawEvent === null) {
    return 'unknown';
  }
  try {
    const decoded = JSON.parse(rawEvent) as unknown;
    if (
      decoded !== null &&
      typeof decoded === 'object' &&
      typeof (decoded as { type?: unknown }).type === 'string' &&
      /^[A-Za-z0-9._:-]{1,128}$/.test((decoded as { type: string }).type)
    ) {
      return (decoded as { type: string }).type;
    }
  } catch {
    // The bounded diagnostic below intentionally excludes the raw value.
  }
  return 'unknown';
}

function diagnosticPreview(entry: StreamEntry): string {
  const fields: Array<{ name: string; byteLength: number }> = [];
  for (let index = 0; index < entry.fields.length; index += 2) {
    const name = entry.fields[index] ?? 'unknown';
    const value = entry.fields[index + 1] ?? '';
    fields.push({
      name: /^[A-Za-z0-9._:-]{1,128}$/.test(name) ? name : 'redacted',
      byteLength: Buffer.byteLength(value, 'utf8'),
    });
  }
  return JSON.stringify({ fields }).slice(0, 2_048);
}

class RedisRealtimeRelay implements RealtimeRelay {
  readonly #options: RealtimeRelayOptions;
  readonly #poisonFailures = new Map<string, number>();
  #healthy = true;
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: RealtimeRelayOptions) {
    this.#options = options;
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  async #ack(streamId: string): Promise<void> {
    await this.#options.client.sendCommand([
      'XACK',
      this.#options.stream,
      this.#options.group,
      streamId,
    ]);
  }

  async #deadLetter(entry: StreamEntry): Promise<void> {
    const hash = createHash('sha256').update(JSON.stringify(entry.fields)).digest('hex');
    await this.#options.client.sendCommand([
      'XADD',
      this.#options.deadLetterStream,
      'MAXLEN',
      '~',
      String(this.#options.deadLetterMaxLength),
      '*',
      'sourceStream',
      this.#options.stream,
      'sourceStreamId',
      entry.streamId,
      'reason',
      'RUNTIME_EVENT_INVALID',
      'issueCodes',
      'RUNTIME_EVENT_INVALID',
      'runtimeVersion',
      LUWI_RUNTIME_VERSION,
      'consumer',
      this.#options.consumer,
      'eventType',
      safeEventType(entry),
      'detectedAt',
      this.#options.now().toISOString(),
      'fieldsSha256',
      hash,
      'preview',
      diagnosticPreview(entry),
    ]);
  }

  async #process(entry: StreamEntry): Promise<boolean> {
    const message = parseMessage(entry);
    if (message === null) {
      try {
        await this.#deadLetter(entry);
        this.#poisonFailures.delete(entry.streamId);
        await this.#ack(entry.streamId);
        return true;
      } catch {
        const failures = (this.#poisonFailures.get(entry.streamId) ?? 0) + 1;
        this.#poisonFailures.set(entry.streamId, failures);
        return false;
      }
    }

    try {
      if (await this.#options.accept(message)) {
        await this.#ack(entry.streamId);
        return true;
      }
      return false;
    } catch (error) {
      this.#healthy = false;
      this.#options.onFailure(
        error instanceof Error ? error : new Error('Realtime broadcast failed.'),
      );
      return false;
    }
  }

  async recoverPending(): Promise<void> {
    const summary = await this.#options.client.sendCommand([
      'XPENDING',
      this.#options.stream,
      this.#options.group,
    ]);
    let processingFailed = false;
    if (pendingCount(summary) !== 0) {
      let startId = '0-0';
      do {
        const reply = await this.#options.client.sendCommand([
          'XAUTOCLAIM',
          this.#options.stream,
          this.#options.group,
          this.#options.consumer,
          String(this.#options.claimIdleMs),
          startId,
          'COUNT',
          String(this.#options.batchSize),
        ]);
        const claimed = claimedEntries(reply);
        for (const entry of claimed.entries) {
          if (!(await this.#process(entry))) {
            processingFailed = true;
          }
        }
        startId = claimed.nextId;
      } while (startId !== '0-0');
    }
    if ([...this.#poisonFailures.values()].some((failures) => failures >= 3)) {
      const error = new Error('Poison Runtime event remains pending.');
      this.#healthy = false;
      this.#options.onFailure(error);
      throw error;
    }
    if (!processingFailed) {
      this.#healthy = true;
    }
  }

  async pollOnce(): Promise<number> {
    const reply = await this.#options.client.sendCommand([
      'XREADGROUP',
      'GROUP',
      this.#options.group,
      this.#options.consumer,
      'COUNT',
      String(this.#options.batchSize),
      'BLOCK',
      String(this.#options.blockMs),
      'STREAMS',
      this.#options.stream,
      '>',
    ]);
    const entries = readGroupEntries(reply);
    for (const entry of entries) {
      await this.#process(entry);
    }
    return entries.length;
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#loop = (async () => {
      try {
        while (this.#running) {
          await this.recoverPending();
          if (!this.#running) {
            break;
          }
          await this.pollOnce();
        }
      } catch (error) {
        if (this.#running && this.#healthy) {
          this.#healthy = false;
          this.#options.onFailure(
            error instanceof Error ? error : new Error('Realtime relay failed.'),
          );
        }
      } finally {
        this.#running = false;
      }
    })();
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#loop;
  }
}

export function createRealtimeRelay(options: RealtimeRelayOptions): RealtimeRelay {
  return new RedisRealtimeRelay(options);
}
