import { z } from 'zod';

import { redisStreamIdSchema } from './stream-id.js';
import { utf8ByteLength } from './utf8-bytes.js';
import { agentIdSchema } from './session.js';

export const MESSAGE_MAX_CONTENT_BYTES = 32_768;
export const MESSAGE_MAX_SUBJECT_BYTES = 512;
export const MESSAGE_MAX_RESPONSE_BYTES = 65_536;
export const MESSAGE_MAX_EVIDENCE_ITEMS = 32;
export const MESSAGE_DEFAULT_TIMEOUT_MS = 120_000;
export const MESSAGE_MAX_TIMEOUT_MS = 86_400_000;
export const MESSAGE_MAX_WAIT_MS = 30_000;
export const INBOX_DEFAULT_CLAIM_LIMIT = 10;
export const INBOX_MAX_CLAIM_LIMIT = 100;
export const INBOX_DEFAULT_BLOCK_MS = 5_000;
export const INBOX_DEFAULT_MIN_IDLE_MS = 15_000;

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });
const nonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'Value must contain non-whitespace characters.',
  });
const utf8BytesAtMost =
  (maximum: number) =>
  (value: string): boolean =>
    utf8ByteLength(value) <= maximum;

export const messageStateSchema = z.enum([
  'queued',
  'delivered',
  'acknowledged',
  'processing',
  'responded',
  'rejected',
  'timed_out',
  'failed',
]);

export const messageTerminalStateSchema = z.enum(['responded', 'rejected', 'timed_out', 'failed']);

export const messageKindSchema = z.enum(['question', 'status_request', 'instruction']);

export const evidenceTypeSchema = z.enum([
  'session_state',
  'git_commit',
  'git_diff',
  'test_result',
  'build_result',
  'file_reference',
  'memory_reference',
  'other',
]);

const evidenceMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 16_384, {
    message: 'Evidence metadata must not exceed 16 KiB.',
  });

export const agentEvidenceSchema = z.strictObject({
  type: evidenceTypeSchema,
  reference: z.string().trim().min(1).max(4096).optional(),
  summary: nonBlankStringSchema.max(8192),
  observedAt: timestampSchema.optional(),
  gitHead: z.string().trim().min(1).max(256).optional(),
  metadata: evidenceMetadataSchema.optional(),
});

export const agentMessageResponseSchema = z.strictObject({
  status: z.enum(['answered', 'partially_answered', 'rejected', 'failed']),
  answer: nonBlankStringSchema.refine(utf8BytesAtMost(MESSAGE_MAX_RESPONSE_BYTES), {
    message: `Response must not exceed ${MESSAGE_MAX_RESPONSE_BYTES} UTF-8 bytes.`,
  }),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(agentEvidenceSchema).max(MESSAGE_MAX_EVIDENCE_ITEMS),
  verifiedAt: timestampSchema,
});

const messageBaseFields = {
  sourceSessionId: identifierSchema,
  kind: messageKindSchema,
  subject: z
    .string()
    .trim()
    .min(1)
    .refine(utf8BytesAtMost(MESSAGE_MAX_SUBJECT_BYTES), {
      message: `Subject must not exceed ${MESSAGE_MAX_SUBJECT_BYTES} UTF-8 bytes.`,
    })
    .optional(),
  content: nonBlankStringSchema.refine(utf8BytesAtMost(MESSAGE_MAX_CONTENT_BYTES), {
    message: `Content must not exceed ${MESSAGE_MAX_CONTENT_BYTES} UTF-8 bytes.`,
  }),
  evidenceRequirements: z.array(evidenceTypeSchema).max(MESSAGE_MAX_EVIDENCE_ITEMS).default([]),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(MESSAGE_MAX_TIMEOUT_MS)
    .default(MESSAGE_DEFAULT_TIMEOUT_MS),
  /**
   * The correlation id of the message this one re-asks (a re-dispatch after a
   * previous exchange ended without a usable answer). Declared by the caller,
   * recorded as a fact; the runtime never re-dispatches on its own.
   */
  retryOf: identifierSchema.optional(),
} as const;

export const messageCreateRequestSchema = z
  .strictObject({
    ...messageBaseFields,
    targetSessionId: identifierSchema.optional(),
    targetAgentId: agentIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.targetSessionId === undefined) === (value.targetAgentId === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one of targetSessionId or targetAgentId is required.',
        path: ['targetSessionId'],
      });
    }
  });

export const agentMessageSchema = z.strictObject({
  id: identifierSchema,
  correlationId: identifierSchema,
  projectId: identifierSchema,
  sourceSessionId: identifierSchema,
  sourceAgentId: agentIdSchema,
  targetSessionId: identifierSchema,
  targetAgentId: agentIdSchema,
  selectionReason: z.string().min(1).max(1024),
  kind: messageKindSchema,
  subject: z.string().min(1).optional(),
  content: z.string().min(1),
  evidenceRequirements: z.array(evidenceTypeSchema).max(MESSAGE_MAX_EVIDENCE_ITEMS).optional(),
  retryOf: identifierSchema.optional(),
  state: messageStateSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deadlineAt: timestampSchema,
  acknowledgedAt: timestampSchema.optional(),
  processingAt: timestampSchema.optional(),
  respondedAt: timestampSchema.optional(),
  response: agentMessageResponseSchema.optional(),
});

/**
 * How the selected target will actually receive the message (ADR 0006 / turn-based-GUI gap):
 * `live` — the target continuously claims its inbox (a native-bridge worker), so a prompt reply is
 * expected; `deferred` — the target is a turn-based reader (an interactive GUI) whose inbox is only
 * claimed during its own turn, so the durable message waits until that next turn rather than being
 * answered now. It lets a caller stop presenting a deferred delivery as a live-reader timeout.
 */
export const messageDeliverySchema = z.enum(['live', 'deferred']);
export type MessageDelivery = z.infer<typeof messageDeliverySchema>;

export const messageCreateResponseSchema = z.strictObject({
  message: agentMessageSchema,
  selectedTargetSessionId: identifierSchema,
  selectedTargetAgentId: agentIdSchema,
  selectionReason: z.string().min(1).max(1024),
  delivery: messageDeliverySchema,
  idempotent: z.boolean(),
});

export const messageResponseSchema = agentMessageSchema;

export const messageCollectionResponseSchema = z.strictObject({
  messages: z.array(agentMessageSchema),
});

export const messageListQuerySchema = z.strictObject({
  projectId: identifierSchema.optional(),
  sourceSessionId: identifierSchema.optional(),
  targetSessionId: identifierSchema.optional(),
  state: messageStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const messageWaitQuerySchema = z.strictObject({
  waitMs: z.coerce.number().int().min(0).max(MESSAGE_MAX_WAIT_MS).default(0),
});

export const messageTransitionRequestSchema = z.strictObject({
  responderSessionId: identifierSchema,
});

export const messageRespondRequestSchema = z.strictObject({
  responderSessionId: identifierSchema,
  response: agentMessageResponseSchema,
});

export const inboxClaimRequestSchema = z.strictObject({
  bridgeInstanceId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(INBOX_MAX_CLAIM_LIMIT)
    .default(INBOX_DEFAULT_CLAIM_LIMIT),
  blockMs: z.coerce.number().int().min(0).max(MESSAGE_MAX_WAIT_MS).default(INBOX_DEFAULT_BLOCK_MS),
  minIdleMs: z.coerce
    .number()
    .int()
    .min(0)
    .max(MESSAGE_MAX_TIMEOUT_MS)
    .default(INBOX_DEFAULT_MIN_IDLE_MS),
});

const inboxEnvelopeBase = {
  streamId: redisStreamIdSchema,
  messageId: identifierSchema,
  correlationId: identifierSchema,
  sourceSessionId: identifierSchema,
  targetSessionId: identifierSchema,
  createdAt: timestampSchema,
} as const;

export const inboxRequestEnvelopeSchema = z.strictObject({
  ...inboxEnvelopeBase,
  itemKind: z.literal('request'),
  payload: z.strictObject({
    kind: messageKindSchema,
    subject: z.string().min(1).optional(),
    content: z.string().min(1),
    evidenceRequirements: z.array(evidenceTypeSchema).max(MESSAGE_MAX_EVIDENCE_ITEMS),
    deadlineAt: timestampSchema,
  }),
});

export const inboxResponseEnvelopeSchema = z.strictObject({
  ...inboxEnvelopeBase,
  itemKind: z.literal('response'),
  payload: z.strictObject({
    state: messageTerminalStateSchema,
    response: agentMessageResponseSchema.optional(),
  }),
});

/**
 * A wake-up for a coordinator session (ADR 0035): the mode changed, a plan was
 * approved, the operator answered, a dispatched task completed, or the
 * operator pressed "wake". It carries no work of its own and is acknowledged
 * on claim; the coordinator re-reads the goal and task store on every wake, so
 * a lost or duplicated notice costs latency and never correctness.
 */
export const inboxNoticeKindSchema = z.enum([
  'mode_changed',
  'goal_created',
  'plan_approved',
  'plan_rejected',
  'goal_answered',
  'goal_abandoned',
  'task_completed',
  'kick',
]);

export const inboxNoticeEnvelopeSchema = z.strictObject({
  streamId: redisStreamIdSchema,
  itemKind: z.literal('notice'),
  targetSessionId: identifierSchema,
  createdAt: timestampSchema,
  payload: z.strictObject({
    kind: inboxNoticeKindSchema,
    projectId: identifierSchema,
    goalId: identifierSchema.optional(),
    taskId: identifierSchema.optional(),
    correlationId: identifierSchema.optional(),
    mode: z.enum(['off', 'supervised', 'autopilot']).optional(),
  }),
});

export const inboxEnvelopeSchema = z.discriminatedUnion('itemKind', [
  inboxRequestEnvelopeSchema,
  inboxResponseEnvelopeSchema,
  inboxNoticeEnvelopeSchema,
]);

export const inboxClaimResponseSchema = z.strictObject({
  items: z.array(inboxEnvelopeSchema).max(INBOX_MAX_CLAIM_LIMIT),
});

export const messageErrorCodeSchema = z.enum([
  'MESSAGE_NOT_FOUND',
  'MESSAGE_TERMINAL',
  'MESSAGE_TRANSITION_INVALID',
  'MESSAGE_CONTENT_TOO_LARGE',
  'MESSAGE_RESPONSE_TOO_LARGE',
  'MESSAGE_TIMEOUT_INVALID',
  'TARGET_SESSION_UNAVAILABLE',
  'TARGET_PROJECT_MISMATCH',
  'SOURCE_SESSION_INVALID',
  'RESPONDER_SESSION_MISMATCH',
  'INBOX_ENTRY_INVALID',
  'INBOX_CONSUMER_INVALID',
  'IDEMPOTENCY_KEY_CONFLICT',
]);

export type MessageState = z.infer<typeof messageStateSchema>;
export type MessageTerminalState = z.infer<typeof messageTerminalStateSchema>;
export type MessageKind = z.infer<typeof messageKindSchema>;
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;
export type AgentEvidence = z.infer<typeof agentEvidenceSchema>;
export type AgentMessageResponse = z.infer<typeof agentMessageResponseSchema>;
export type MessageCreateRequest = z.infer<typeof messageCreateRequestSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type MessageCreateResponse = z.infer<typeof messageCreateResponseSchema>;
export type MessageCollectionResponse = z.infer<typeof messageCollectionResponseSchema>;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;
export type MessageWaitQuery = z.infer<typeof messageWaitQuerySchema>;
export type MessageTransitionRequest = z.infer<typeof messageTransitionRequestSchema>;
export type MessageRespondRequest = z.infer<typeof messageRespondRequestSchema>;
export type InboxClaimRequest = z.infer<typeof inboxClaimRequestSchema>;
export type InboxEnvelope = z.infer<typeof inboxEnvelopeSchema>;
export type InboxNoticeKind = z.infer<typeof inboxNoticeKindSchema>;
export type InboxNoticeEnvelope = z.infer<typeof inboxNoticeEnvelopeSchema>;
export type InboxClaimResponse = z.infer<typeof inboxClaimResponseSchema>;
export type MessageErrorCode = z.infer<typeof messageErrorCodeSchema>;
