import {
  INBOX_DEFAULT_BLOCK_MS,
  INBOX_DEFAULT_CLAIM_LIMIT,
  INBOX_DEFAULT_MIN_IDLE_MS,
  INBOX_MAX_CLAIM_LIMIT,
  MESSAGE_DEFAULT_TIMEOUT_MS,
  MESSAGE_MAX_CONTENT_BYTES,
  MESSAGE_MAX_EVIDENCE_ITEMS,
  MESSAGE_MAX_RESPONSE_BYTES,
  MESSAGE_MAX_SUBJECT_BYTES,
  MESSAGE_MAX_TIMEOUT_MS,
} from '@luwi/protocol';
import { z } from 'zod';
import { delimiter, isAbsolute } from 'node:path';

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
  LUWI_NATIVE_LINK_RETENTION_MAX: z.coerce.number().int().min(1).max(1_000_000).default(1_000),
  LUWI_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  LUWI_MESSAGE_TIMEOUT_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  LUWI_MESSAGE_MAX_CONTENT_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_MAX_CONTENT_BYTES)
    .default(MESSAGE_MAX_CONTENT_BYTES),
  LUWI_MESSAGE_MAX_SUBJECT_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_MAX_SUBJECT_BYTES)
    .default(MESSAGE_MAX_SUBJECT_BYTES),
  LUWI_MESSAGE_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_MAX_RESPONSE_BYTES)
    .default(MESSAGE_MAX_RESPONSE_BYTES),
  LUWI_MESSAGE_MAX_EVIDENCE_ITEMS: z.coerce
    .number()
    .int()
    .min(0)
    .max(MESSAGE_MAX_EVIDENCE_ITEMS)
    .default(MESSAGE_MAX_EVIDENCE_ITEMS),
  LUWI_MESSAGE_DEFAULT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_MAX_TIMEOUT_MS)
    .default(MESSAGE_DEFAULT_TIMEOUT_MS),
  LUWI_MESSAGE_MAX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_MAX_TIMEOUT_MS)
    .default(MESSAGE_MAX_TIMEOUT_MS),
  LUWI_INBOX_CLAIM_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(INBOX_MAX_CLAIM_LIMIT)
    .default(INBOX_DEFAULT_CLAIM_LIMIT),
  LUWI_INBOX_BLOCK_MS: z.coerce.number().int().min(0).max(30_000).default(INBOX_DEFAULT_BLOCK_MS),
  LUWI_INBOX_MIN_IDLE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(MESSAGE_MAX_TIMEOUT_MS)
    .default(INBOX_DEFAULT_MIN_IDLE_MS),
  LUWI_INBOX_MAX_CLAIM_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(INBOX_MAX_CLAIM_LIMIT)
    .default(INBOX_MAX_CLAIM_LIMIT),
  LUWI_TERMINAL_MESSAGE_RETENTION_MS: z.coerce.number().int().min(60_000).default(604_800_000),
  LUWI_MESSAGE_IDEMPOTENCY_RETENTION_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  LUWI_SESSION_INBOX_MAXLEN: z.coerce.number().int().min(100).default(10_000),
  LUWI_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  LUWI_RECONNECT_INITIAL_MS: z.coerce.number().int().min(50).default(250),
  LUWI_RECONNECT_MAX_MS: z.coerce.number().int().min(250).default(5_000),
  LUWI_ALLOWED_ORIGINS: z.string().optional(),
  LUWI_HOME: z.string().trim().min(1).optional(),
  LUWI_NATIVE_HOME: z.string().trim().min(1).optional(),
  LUWI_CAPABILITY_ROOTS: z.string().max(131_072).optional(),
  LUWI_CONFIG_SNAPSHOT_RETENTION_COUNT: z.coerce.number().int().min(1).max(10_000).default(50),
  LUWI_GIT_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5_000),
  LUWI_GIT_SCAN_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  LUWI_TRANSCRIPT_SCAN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(300_000),
  LUWI_TRANSCRIPT_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(268_435_456)
    .default(16_777_216),
  LUWI_TRANSCRIPT_MAX_FILES_PER_SCAN: z.coerce.number().int().min(1).max(100_000).default(2_000),
  LUWI_USAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  LUWI_GIT_OBSERVATION_RETENTION_COUNT: z.coerce.number().int().min(1).max(10_000).default(100),
  LUWI_GRAPH_GENERATION_RETENTION_COUNT: z.coerce.number().int().min(2).max(100).default(2),
  LUWI_OPTIMIZATION_MIN_BASELINE_SESSIONS: z.coerce.number().int().min(1).max(10_000).default(3),
  LUWI_OPTIMIZATION_MIN_POST_SESSIONS: z.coerce.number().int().min(1).max(10_000).default(3),
  LUWI_OPTIMIZATION_MIN_OBSERVATION_HOURS: z.coerce.number().nonnegative().max(8760).default(24),
  LUWI_OPTIMIZATION_MAX_FINDINGS_PER_RUN: z.coerce.number().int().min(1).max(1000).default(100),
  LUWI_OPTIMIZATION_MAX_PROPOSALS_PER_RUN: z.coerce.number().int().min(1).max(100).default(25),
  LUWI_OPTIMIZATION_OVERSIZED_CONTEXT_TOKENS: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000_000)
    .default(8_000),
});

const runtimeInstanceIdSchema = z.string().uuid().optional();

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
  nativeLinkRetentionMax?: number;
  messageTimeoutSweepIntervalMs?: number;
  messageTimeoutBatchSize?: number;
  messageMaxContentBytes?: number;
  messageMaxSubjectBytes?: number;
  messageMaxResponseBytes?: number;
  messageMaxEvidenceItems?: number;
  messageDefaultTimeoutMs?: number;
  messageMaxTimeoutMs?: number;
  inboxClaimLimit?: number;
  inboxBlockMs?: number;
  inboxMinIdleMs?: number;
  inboxMaxClaimLimit?: number;
  terminalMessageRetentionMs?: number;
  messageIdempotencyRetentionMs?: number;
  sessionInboxMaxLength?: number;
  drainTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  allowedOrigins?: string[];
  luwiHome?: string;
  nativeHome?: string;
  capabilityRoots?: string[];
  configSnapshotRetentionCount?: number;
  gitCommandTimeoutMs?: number;
  gitScanIntervalMs?: number;
  transcriptScanIntervalMs?: number;
  transcriptMaxFileBytes?: number;
  transcriptMaxFilesPerScan?: number;
  usageRetentionDays?: number;
  gitObservationRetentionCount?: number;
  graphGenerationRetentionCount?: number;
  optimizationMinimumBaselineSessions?: number;
  optimizationMinimumPostSessions?: number;
  optimizationMinimumObservationHours?: number;
  optimizationMaximumFindings?: number;
  optimizationMaximumProposals?: number;
  optimizationOversizedContextTokens?: number;
};

export function loadRuntimeInstanceId(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return runtimeInstanceIdSchema.parse(environment['LUWI_RUNTIME_INSTANCE_ID']);
}

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
  const configuredCapabilityRoots =
    parsed.LUWI_CAPABILITY_ROOTS === undefined
      ? []
      : parsed.LUWI_CAPABILITY_ROOTS.split(delimiter).map((root) => root.trim());
  if (configuredCapabilityRoots.some((root) => root === '')) {
    throw new Error('Capability roots must not contain blank entries.');
  }
  if (
    configuredCapabilityRoots.length > 32 ||
    configuredCapabilityRoots.some(
      (root) =>
        root.length > 4_096 ||
        !isAbsolute(root) ||
        Array.from(root).some((character) => {
          const point = character.codePointAt(0);
          return point !== undefined && (point <= 0x1f || point === 0x7f);
        }),
    )
  ) {
    throw new Error('Capability roots must be at most 32 absolute filesystem paths.');
  }
  const seenCapabilityRoots = new Set<string>();
  const capabilityRoots = configuredCapabilityRoots.filter((root) => {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seenCapabilityRoots.has(key)) return false;
    seenCapabilityRoots.add(key);
    return true;
  });
  if (parsed.LUWI_DAEMON_OWNER_RENEW_INTERVAL_MS >= parsed.LUWI_DAEMON_OWNER_TTL_MS) {
    throw new Error('Daemon owner renewal interval must be shorter than its TTL.');
  }
  if (parsed.LUWI_RECONNECT_INITIAL_MS > parsed.LUWI_RECONNECT_MAX_MS) {
    throw new Error('Redis reconnect initial delay must not exceed its maximum delay.');
  }
  if (parsed.LUWI_MESSAGE_DEFAULT_TIMEOUT_MS > parsed.LUWI_MESSAGE_MAX_TIMEOUT_MS) {
    throw new Error('The default message timeout must not exceed its maximum.');
  }
  if (parsed.LUWI_INBOX_CLAIM_LIMIT > parsed.LUWI_INBOX_MAX_CLAIM_LIMIT) {
    throw new Error('The default inbox claim limit must not exceed its maximum.');
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
    nativeLinkRetentionMax: parsed.LUWI_NATIVE_LINK_RETENTION_MAX,
    capabilityRoots,
    messageTimeoutSweepIntervalMs: parsed.LUWI_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS,
    messageTimeoutBatchSize: parsed.LUWI_MESSAGE_TIMEOUT_BATCH_SIZE,
    messageMaxContentBytes: parsed.LUWI_MESSAGE_MAX_CONTENT_BYTES,
    messageMaxSubjectBytes: parsed.LUWI_MESSAGE_MAX_SUBJECT_BYTES,
    messageMaxResponseBytes: parsed.LUWI_MESSAGE_MAX_RESPONSE_BYTES,
    messageMaxEvidenceItems: parsed.LUWI_MESSAGE_MAX_EVIDENCE_ITEMS,
    messageDefaultTimeoutMs: parsed.LUWI_MESSAGE_DEFAULT_TIMEOUT_MS,
    messageMaxTimeoutMs: parsed.LUWI_MESSAGE_MAX_TIMEOUT_MS,
    inboxClaimLimit: parsed.LUWI_INBOX_CLAIM_LIMIT,
    inboxBlockMs: parsed.LUWI_INBOX_BLOCK_MS,
    inboxMinIdleMs: parsed.LUWI_INBOX_MIN_IDLE_MS,
    inboxMaxClaimLimit: parsed.LUWI_INBOX_MAX_CLAIM_LIMIT,
    terminalMessageRetentionMs: parsed.LUWI_TERMINAL_MESSAGE_RETENTION_MS,
    messageIdempotencyRetentionMs: parsed.LUWI_MESSAGE_IDEMPOTENCY_RETENTION_MS,
    sessionInboxMaxLength: parsed.LUWI_SESSION_INBOX_MAXLEN,
    drainTimeoutMs: parsed.LUWI_DRAIN_TIMEOUT_MS,
    reconnectInitialMs: parsed.LUWI_RECONNECT_INITIAL_MS,
    reconnectMaxMs: parsed.LUWI_RECONNECT_MAX_MS,
    allowedOrigins: [...new Set(allowedOrigins)],
    ...(parsed.LUWI_HOME === undefined ? {} : { luwiHome: parsed.LUWI_HOME }),
    ...(parsed.LUWI_NATIVE_HOME === undefined ? {} : { nativeHome: parsed.LUWI_NATIVE_HOME }),
    configSnapshotRetentionCount: parsed.LUWI_CONFIG_SNAPSHOT_RETENTION_COUNT,
    gitCommandTimeoutMs: parsed.LUWI_GIT_COMMAND_TIMEOUT_MS,
    gitScanIntervalMs: parsed.LUWI_GIT_SCAN_INTERVAL_MS,
    transcriptScanIntervalMs: parsed.LUWI_TRANSCRIPT_SCAN_INTERVAL_MS,
    transcriptMaxFileBytes: parsed.LUWI_TRANSCRIPT_MAX_FILE_BYTES,
    transcriptMaxFilesPerScan: parsed.LUWI_TRANSCRIPT_MAX_FILES_PER_SCAN,
    usageRetentionDays: parsed.LUWI_USAGE_RETENTION_DAYS,
    gitObservationRetentionCount: parsed.LUWI_GIT_OBSERVATION_RETENTION_COUNT,
    graphGenerationRetentionCount: parsed.LUWI_GRAPH_GENERATION_RETENTION_COUNT,
    optimizationMinimumBaselineSessions: parsed.LUWI_OPTIMIZATION_MIN_BASELINE_SESSIONS,
    optimizationMinimumPostSessions: parsed.LUWI_OPTIMIZATION_MIN_POST_SESSIONS,
    optimizationMinimumObservationHours: parsed.LUWI_OPTIMIZATION_MIN_OBSERVATION_HOURS,
    optimizationMaximumFindings: parsed.LUWI_OPTIMIZATION_MAX_FINDINGS_PER_RUN,
    optimizationMaximumProposals: parsed.LUWI_OPTIMIZATION_MAX_PROPOSALS_PER_RUN,
    optimizationOversizedContextTokens: parsed.LUWI_OPTIMIZATION_OVERSIZED_CONTEXT_TOKENS,
  };
}
