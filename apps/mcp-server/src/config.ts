import { z } from 'zod';
import { isAbsolute } from 'node:path';

const environmentSchema = z
  .object({
    LUWI_DAEMON_URL: z.url().default('http://127.0.0.1:4782'),
    LUWI_SESSION_ID: z.string().trim().min(1).max(128).optional(),
    LUWI_SESSION_FILE: z.string().trim().min(1).max(4096).optional(),
    LUWI_MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(30_000),
  })
  .superRefine((value, context) => {
    if ((value.LUWI_SESSION_ID === undefined) === (value.LUWI_SESSION_FILE === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one LUWI session binding source is required.',
      });
    }
    if (value.LUWI_SESSION_FILE !== undefined && !isAbsolute(value.LUWI_SESSION_FILE)) {
      context.addIssue({
        code: 'custom',
        path: ['LUWI_SESSION_FILE'],
        message: 'LUWI_SESSION_FILE must be absolute.',
      });
    }
  });

export type McpSessionBindingConfig =
  { kind: 'static'; sessionId: string } | { kind: 'file'; path: string };

export type McpServerConfig = {
  daemonUrl: string;
  sessionBinding: McpSessionBindingConfig;
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
    sessionBinding:
      parsed.LUWI_SESSION_ID === undefined
        ? { kind: 'file', path: parsed.LUWI_SESSION_FILE! }
        : { kind: 'static', sessionId: parsed.LUWI_SESSION_ID },
    requestTimeoutMs: parsed.LUWI_MCP_REQUEST_TIMEOUT_MS,
  };
}
