import { loadDaemonConfig } from './config.js';
import { startDaemon } from './runtime.js';

async function main(): Promise<void> {
  const config = loadDaemonConfig(process.env);
  await startDaemon({ config });
}

void main().catch((error: unknown) => {
  const code =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'DAEMON_START_FAILED';
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      code,
      message: 'LUWI Runtime daemon failed to start',
    })}\n`,
  );
  process.exitCode = 1;
});
