import {
  createManagedRedisConnection,
  inspectRuntimeNamespace,
  resetRuntimeNamespace,
  type ManagedRedisConnection,
} from '@luwi/redis';
import { ApplicationError } from '@luwi/runtime';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_RUNTIME_NAMESPACE = 'luwi:v1:';

export type RuntimeResetMainOptions = {
  argv: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  createConnection: (url: string) => ManagedRedisConnection;
  stdout: { write(value: string): unknown };
};

function parseArguments(argv: readonly string[]): {
  mode: 'inspect' | 'apply';
  configuredUrl?: string;
} {
  const mode = argv[0] === '--inspect' ? 'inspect' : argv[0] === '--apply' ? 'apply' : undefined;
  if (mode !== undefined && argv.length === 1) return { mode };
  if (mode !== undefined && argv.length === 3 && argv[1] === '--redis-url') {
    const configuredUrl = argv[2];
    if (configuredUrl !== undefined) return { mode, configuredUrl };
  }
  throw new ApplicationError(
    'RUNTIME_RESET_ARGUMENT_INVALID',
    'The runtime reset maintenance arguments are invalid.',
    400,
  );
}

function redisUrl(
  environment: Readonly<Record<string, string | undefined>>,
  configuredUrl?: string,
): string {
  const value = configuredUrl ?? environment['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApplicationError('RUNTIME_RESET_CONFIG_INVALID', 'The Redis URL is invalid.', 400);
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (
    parsed.protocol !== 'redis:' ||
    !loopback ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ApplicationError(
      'RUNTIME_RESET_CONFIG_INVALID',
      'The Redis URL must be credential-free and loopback-only.',
      400,
    );
  }
  return parsed.toString();
}

async function close(connection: ManagedRedisConnection): Promise<void> {
  if (!connection.isOpen) return;
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
}

export async function runRuntimeResetMain(options: RuntimeResetMainOptions): Promise<void> {
  const { mode, configuredUrl } = parseArguments(options.argv);
  const connection = options.createConnection(redisUrl(options.environment, configuredUrl));
  try {
    await connection.connect();
    const result =
      mode === 'inspect'
        ? await inspectRuntimeNamespace(connection, { namespace: PRODUCTION_RUNTIME_NAMESPACE })
        : await resetRuntimeNamespace(connection, { namespace: PRODUCTION_RUNTIME_NAMESPACE });
    options.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await close(connection);
  }
}

const currentEntry = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (currentEntry === fileURLToPath(import.meta.url)) {
  void runRuntimeResetMain({
    argv: process.argv.slice(2),
    environment: process.env,
    createConnection: (url) => createManagedRedisConnection({ url }),
    stdout: process.stdout,
  }).catch((error: unknown) => {
    const code =
      error !== null &&
      typeof error === 'object' &&
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'RUNTIME_RESET_FAILED';
    process.stderr.write(
      `${JSON.stringify({ level: 'error', code, message: 'LUWI runtime reset failed' })}\n`,
    );
    process.exitCode = 1;
  });
}
