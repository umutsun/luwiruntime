import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

const DEFAULT_SCAN_COUNT = 500;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_KEYS = 100_000;

export type RuntimeNamespaceOptions = {
  namespace: string;
  scanCount?: number;
  batchSize?: number;
  maxKeys?: number;
};

export type RuntimeNamespaceInspection = {
  namespace: string;
  matched: number;
};

export type RuntimeNamespaceResetResult = RuntimeNamespaceInspection & {
  deleted: number;
  status: 'reset' | 'empty';
};

export class RuntimeResetPartialError extends RedisRepositoryError {
  readonly matched: number;
  readonly deleted: number;

  constructor(matched: number, deleted: number) {
    super('RUNTIME_RESET_PARTIAL', 'The LUWI runtime namespace was only partially reset.');
    this.name = 'RuntimeResetPartialError';
    this.matched = matched;
    this.deleted = deleted;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RedisRepositoryError('REDIS_ARGUMENT_INVALID', `${label} must be positive.`);
  }
  return value;
}

function validateNamespace(namespace: string): string {
  if (namespace.length < 2 || namespace.length > 128 || !namespace.endsWith(':')) {
    throw new RedisRepositoryError('REDIS_ARGUMENT_INVALID', 'The runtime namespace is invalid.');
  }
  return namespace;
}

function parseScanReply(value: unknown): { cursor: string; keys: string[] } {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    !/^\d+$/u.test(value[0]) ||
    !Array.isArray(value[1]) ||
    !value[1].every((key) => typeof key === 'string')
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid SCAN reply.');
  }
  return { cursor: value[0], keys: value[1] };
}

async function collectKeys(
  client: RedisCommandClient,
  options: RuntimeNamespaceOptions,
): Promise<{ namespace: string; keys: string[] }> {
  const namespace = validateNamespace(options.namespace);
  const scanCount = positiveInteger(options.scanCount ?? DEFAULT_SCAN_COUNT, 'SCAN count');
  const maxKeys = positiveInteger(options.maxKeys ?? DEFAULT_MAX_KEYS, 'Maximum key count');
  const keys = new Set<string>();
  const seenCursors = new Set(['0']);
  let cursor = '0';
  do {
    const reply = parseScanReply(
      await client.sendCommand([
        'SCAN',
        cursor,
        'MATCH',
        `${namespace}*`,
        'COUNT',
        String(scanCount),
      ]),
    );
    if (reply.cursor !== '0' && seenCursors.has(reply.cursor)) {
      throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned a cycling SCAN cursor.');
    }
    cursor = reply.cursor;
    seenCursors.add(cursor);
    for (const key of reply.keys) {
      if (!key.startsWith(namespace)) {
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          'Redis returned a key outside the LUWI runtime namespace.',
        );
      }
      keys.add(key);
      if (keys.size > maxKeys) {
        throw new RedisRepositoryError(
          'RUNTIME_RESET_LIMIT_EXCEEDED',
          'The LUWI runtime namespace exceeds the reset key limit.',
        );
      }
    }
  } while (cursor !== '0');
  return { namespace, keys: [...keys].sort() };
}

export async function inspectRuntimeNamespace(
  client: RedisCommandClient,
  options: RuntimeNamespaceOptions,
): Promise<RuntimeNamespaceInspection> {
  const collected = await collectKeys(client, options);
  return { namespace: collected.namespace, matched: collected.keys.length };
}

export async function resetRuntimeNamespace(
  client: RedisCommandClient,
  options: RuntimeNamespaceOptions,
): Promise<RuntimeNamespaceResetResult> {
  const collected = await collectKeys(client, options);
  const matched = collected.keys.length;
  if (matched === 0) {
    return { namespace: collected.namespace, matched, deleted: 0, status: 'empty' };
  }
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'Deletion batch size');
  if (batchSize > MAX_BATCH_SIZE) {
    throw new RedisRepositoryError(
      'REDIS_ARGUMENT_INVALID',
      'Deletion batch size exceeds the hard safety limit.',
    );
  }
  let deleted = 0;
  for (let offset = 0; offset < collected.keys.length; offset += batchSize) {
    const batch = collected.keys.slice(offset, offset + batchSize);
    try {
      const reply = await client.sendCommand(['UNLINK', ...batch]);
      if (
        !Number.isSafeInteger(reply) ||
        (reply as number) < 0 ||
        (reply as number) > batch.length
      ) {
        throw new RedisRepositoryError(
          'REDIS_DATA_INVALID',
          'Redis returned an invalid UNLINK result.',
        );
      }
      deleted += reply as number;
      if (reply !== batch.length) throw new RuntimeResetPartialError(matched, deleted);
    } catch (error) {
      if (error instanceof RuntimeResetPartialError) throw error;
      throw new RuntimeResetPartialError(matched, deleted);
    }
  }
  return { namespace: collected.namespace, matched, deleted, status: 'reset' };
}
