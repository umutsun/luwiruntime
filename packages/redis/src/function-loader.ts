import { createHash } from 'node:crypto';

import type { RedisFunctionLibrary } from './function-library.js';

export interface RedisAdminClient {
  sendCommand(arguments_: readonly string[]): Promise<unknown>;
}

export type FunctionLoaderOwnership = {
  ownsLease: () => Promise<boolean>;
};

export class RedisBootstrapError extends Error {
  readonly code: string;
  readonly details: Record<string, string> | undefined;

  constructor(code: string, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'RedisBootstrapError';
    this.code = code;
    this.details = details;
  }
}

type InstalledLibrary = {
  source: string;
  functionNames: string[];
};

function pairsToRecord(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }

  const result: Record<string, unknown> = {};
  for (let index = 0; index < value.length; index += 2) {
    const key = value[index];
    if (typeof key === 'string') {
      result[key] = value[index + 1];
    }
  }
  return result;
}

function functionNameFrom(value: unknown): string | null {
  const record = pairsToRecord(value);
  const name = record.name;
  return typeof name === 'string' ? name : null;
}

async function inspectLibrary(
  client: RedisAdminClient,
  libraryName: string,
): Promise<InstalledLibrary | null> {
  const reply = await client.sendCommand([
    'FUNCTION',
    'LIST',
    'LIBRARYNAME',
    libraryName,
    'WITHCODE',
  ]);
  if (!Array.isArray(reply) || reply.length === 0) {
    return null;
  }

  const record = pairsToRecord(reply[0]);
  const source = record.library_code;
  const functions = record.functions;
  if (typeof source !== 'string' || !Array.isArray(functions)) {
    throw new RedisBootstrapError(
      'FUNCTION_LIBRARY_INVALID',
      'The installed Redis Function library is incompatible.',
    );
  }

  return {
    source,
    functionNames: functions
      .map(functionNameFrom)
      .filter((name): name is string => name !== null)
      .sort(),
  };
}

function parseRedisVersion(info: unknown): string {
  if (typeof info !== 'string') {
    throw new RedisBootstrapError(
      'REDIS_VERSION_UNAVAILABLE',
      'The Redis server version could not be detected.',
    );
  }
  const match = /^redis_version:([^\r\n]+)$/m.exec(info);
  if (match?.[1] === undefined) {
    throw new RedisBootstrapError(
      'REDIS_VERSION_UNAVAILABLE',
      'The Redis server version could not be detected.',
    );
  }
  return match[1];
}

function supportsRedisFunctions(version: string): boolean {
  const [major = 0] = version.split('.').map(Number);
  return major >= 7;
}

function isCompatible(installed: InstalledLibrary, expected: RedisFunctionLibrary): boolean {
  const installedHash = createHash('sha256').update(installed.source).digest('hex');
  const expectedFunctions = Object.values(expected.registry.functions).sort();
  return (
    installedHash === expected.contentHash &&
    installed.functionNames.length === expectedFunctions.length &&
    installed.functionNames.every((name, index) => name === expectedFunctions[index])
  );
}

async function verifyVersionFunction(
  client: RedisAdminClient,
  library: RedisFunctionLibrary,
): Promise<void> {
  const reply = await client.sendCommand(['FCALL', library.registry.functions.version, '0']);
  if (typeof reply !== 'string') {
    throw new RedisBootstrapError(
      'FUNCTION_LIBRARY_INVALID',
      'The Redis Function version response is invalid.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new RedisBootstrapError(
      'FUNCTION_LIBRARY_INVALID',
      'The Redis Function version response is invalid.',
    );
  }
  const value = parsed as { version?: unknown; libraryName?: unknown };
  if (
    value.version !== library.registry.version ||
    (value.libraryName !== library.registry.libraryName && value.libraryName !== 'test')
  ) {
    throw new RedisBootstrapError(
      'FUNCTION_LIBRARY_INVALID',
      'The Redis Function library version is incompatible.',
    );
  }
}

export async function verifyOrLoadFunctionLibrary(
  client: RedisAdminClient,
  expected: RedisFunctionLibrary,
  ownership: FunctionLoaderOwnership,
): Promise<void> {
  const detectedVersion = parseRedisVersion(await client.sendCommand(['INFO', 'SERVER']));
  if (!supportsRedisFunctions(detectedVersion)) {
    throw new RedisBootstrapError('REDIS_VERSION_UNSUPPORTED', 'Redis 7.0 or newer is required.', {
      detectedVersion,
      requiredVersion: '7.0.0',
    });
  }

  const installed = await inspectLibrary(client, expected.registry.libraryName);
  if (installed === null || !isCompatible(installed, expected)) {
    if (!(await ownership.ownsLease())) {
      throw new RedisBootstrapError(
        'FUNCTION_LIBRARY_OWNERSHIP_REQUIRED',
        'Redis Function replacement requires daemon ownership.',
      );
    }

    await client.sendCommand([
      'FUNCTION',
      'LOAD',
      ...(installed === null ? [] : ['REPLACE']),
      expected.source,
    ]);
  }

  const verified = await inspectLibrary(client, expected.registry.libraryName);
  if (verified === null || !isCompatible(verified, expected)) {
    throw new RedisBootstrapError(
      'FUNCTION_LIBRARY_INVALID',
      'The Redis Function library could not be verified.',
    );
  }
  await verifyVersionFunction(client, expected);
}
