import { z } from 'zod';

const environmentSchema = z.object({
  LUWI_DAEMON_URL: z.url().default('http://127.0.0.1:4782'),
  LUWI_SESSION_ID: z.string().trim().min(1).max(128),
  LUWI_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(30_000),
});

export type McpServerConfig = {
  daemonUrl: string;
  sessionId: string;
  requestTimeoutMs: number;
};

export function loadMcpServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): McpServerConfig {
  const parsed = environmentSchema.parse(environment);
  const daemon = new URL(parsed.LUWI_DAEMON_URL);
  if (
    daemon.protocol !== 'http:' ||
    (daemon.hostname !== '127.0.0.1' &&
      daemon.hostname !== 'localhost' &&
      daemon.hostname !== '[::1]') ||
    daemon.username !== '' ||
    daemon.password !== '' ||
    daemon.pathname !== '/' ||
    daemon.search !== '' ||
    daemon.hash !== ''
  ) {
    throw new Error('LUWI_DAEMON_URL must be an exact loopback HTTP origin.');
  }
  return {
    daemonUrl: daemon.origin,
    sessionId: parsed.LUWI_SESSION_ID,
    requestTimeoutMs: parsed.LUWI_MCP_REQUEST_TIMEOUT_MS,
  };
}
