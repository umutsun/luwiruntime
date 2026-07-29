import { z } from 'zod';

const environmentSchema = z.object({
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4782),
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'))
    .default('redis://127.0.0.1:6379'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKSPACE_ID: z.string().min(1).default('local'),
  LUWI_DAEMON_OWNER_TTL_MS: z.coerce.number().int().min(1_000).default(15_000),
  LUWI_DAEMON_OWNER_RENEW_INTERVAL_MS: z.coerce.number().int().min(250).default(5_000),
  LUWI_SESSION_PRESENCE_TTL_MS: z.coerce.number().int().min(100).default(15_000),
  LUWI_PRESENCE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  LUWI_HEARTBEAT_EVENT_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  LUWI_CONSUMER_CLAIM_IDLE_MS: z.coerce.number().int().min(0).default(30_000),
  LUWI_RELAY_BLOCK_MS: z.coerce.number().int().min(1).max(5_000).default(1_000),
  LUWI_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  LUWI_WS_QUEUE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(256),
  LUWI_WS_SEND_TIMEOUT_MS: z.coerce.number().int().min(10).default(1_000),
  LUWI_WS_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1_024).default(65_536),
  LUWI_WS_MAX_BUFFERED_BYTES: z.coerce.number().int().min(1_024).default(1_048_576),
  LUWI_STREAM_MAXLEN_GLOBAL: z.coerce.number().int().min(100).default(100_000),
  LUWI_STREAM_MAXLEN_PROJECT: z.coerce.number().int().min(100).default(50_000),
  LUWI_STREAM_MAXLEN_DEAD_LETTER: z.coerce.number().int().min(10).default(10_000),
  LUWI_RETENTION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  LUWI_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  LUWI_RECONNECT_INITIAL_MS: z.coerce.number().int().min(50).default(250),
  LUWI_RECONNECT_MAX_MS: z.coerce.number().int().min(250).default(5_000),
  LUWI_ALLOWED_ORIGINS: z.string().optional(),
});

export type DaemonConfig = {
  host: string;
  port: number;
  redisUrl: string;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
  workspaceId: string;
  ownerTtlMs?: number;
  ownerRenewIntervalMs?: number;
  sessionPresenceTtlMs?: number;
  presenceSweepIntervalMs?: number;
  heartbeatEventIntervalMs?: number;
  consumerClaimIdleMs?: number;
  relayBlockMs?: number;
  relayBatchSize?: number;
  websocketQueueLimit?: number;
  websocketSendTimeoutMs?: number;
  websocketMaxPayloadBytes?: number;
  websocketMaxBufferedBytes?: number;
  globalStreamMaxLength?: number;
  projectStreamMaxLength?: number;
  deadLetterStreamMaxLength?: number;
  retentionIntervalMs?: number;
  drainTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  allowedOrigins?: string[];
};

export function loadDaemonConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DaemonConfig {
  const parsed = environmentSchema.parse(environment);
  const defaultOrigins = [`http://127.0.0.1:${parsed.PORT}`, `http://localhost:${parsed.PORT}`];
  const allowedOrigins =
    parsed.LUWI_ALLOWED_ORIGINS === undefined
      ? defaultOrigins
      : parsed.LUWI_ALLOWED_ORIGINS.split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin !== '');
  if (parsed.LUWI_DAEMON_OWNER_RENEW_INTERVAL_MS >= parsed.LUWI_DAEMON_OWNER_TTL_MS) {
    throw new Error('Daemon owner renewal interval must be shorter than its TTL.');
  }
  if (parsed.LUWI_RECONNECT_INITIAL_MS > parsed.LUWI_RECONNECT_MAX_MS) {
    throw new Error('Redis reconnect initial delay must not exceed its maximum delay.');
  }
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    const loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (
      !loopback ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      throw new Error('Allowed WebSocket origins must be exact loopback HTTP origins.');
    }
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    redisUrl: parsed.REDIS_URL,
    logLevel: parsed.LOG_LEVEL,
    workspaceId: parsed.WORKSPACE_ID,
    ownerTtlMs: parsed.LUWI_DAEMON_OWNER_TTL_MS,
    ownerRenewIntervalMs: parsed.LUWI_DAEMON_OWNER_RENEW_INTERVAL_MS,
    sessionPresenceTtlMs: parsed.LUWI_SESSION_PRESENCE_TTL_MS,
    presenceSweepIntervalMs: parsed.LUWI_PRESENCE_SWEEP_INTERVAL_MS,
    heartbeatEventIntervalMs: parsed.LUWI_HEARTBEAT_EVENT_INTERVAL_MS,
    consumerClaimIdleMs: parsed.LUWI_CONSUMER_CLAIM_IDLE_MS,
    relayBlockMs: parsed.LUWI_RELAY_BLOCK_MS,
    relayBatchSize: parsed.LUWI_RELAY_BATCH_SIZE,
    websocketQueueLimit: parsed.LUWI_WS_QUEUE_LIMIT,
    websocketSendTimeoutMs: parsed.LUWI_WS_SEND_TIMEOUT_MS,
    websocketMaxPayloadBytes: parsed.LUWI_WS_MAX_PAYLOAD_BYTES,
    websocketMaxBufferedBytes: parsed.LUWI_WS_MAX_BUFFERED_BYTES,
    globalStreamMaxLength: parsed.LUWI_STREAM_MAXLEN_GLOBAL,
    projectStreamMaxLength: parsed.LUWI_STREAM_MAXLEN_PROJECT,
    deadLetterStreamMaxLength: parsed.LUWI_STREAM_MAXLEN_DEAD_LETTER,
    retentionIntervalMs: parsed.LUWI_RETENTION_INTERVAL_MS,
    drainTimeoutMs: parsed.LUWI_DRAIN_TIMEOUT_MS,
    reconnectInitialMs: parsed.LUWI_RECONNECT_INITIAL_MS,
    reconnectMaxMs: parsed.LUWI_RECONNECT_MAX_MS,
    allowedOrigins: [...new Set(allowedOrigins)],
  };
}
