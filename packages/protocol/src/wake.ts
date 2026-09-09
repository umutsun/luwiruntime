import { z } from 'zod';

import { messageTerminalStateSchema } from './message.js';

const idSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });
const reasonCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]{0,127}$/u);
const nativeSessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);

export const WAKE_DEFAULT_CLAIM_LIMIT = 10;
export const WAKE_MAX_CLAIM_LIMIT = 100;
export const WAKE_DEFAULT_BLOCK_MS = 5_000;
export const WAKE_DEFAULT_MIN_IDLE_MS = 15_000;

export const wakeAdapterSchema = z.literal('codex-queue-v1');
export const wakeIntentStateSchema = z.enum([
  'pending',
  'claimed',
  'dispatching',
  'dispatched',
  'fallback_only',
  'indeterminate',
]);

/** A redacted durable wake projection. It intentionally has no native target or process data. */
export const wakeIntentViewSchema = z.strictObject({
  id: idSchema,
  messageId: idSchema,
  workflowId: idSchema,
  sourceSessionId: idSchema,
  correlationId: idSchema,
  terminalState: messageTerminalStateSchema,
  adapter: wakeAdapterSchema,
  state: wakeIntentStateSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  reasonCode: reasonCodeSchema.optional(),
});

export const wakeIntentCollectionSchema = z.strictObject({
  wakeIntents: z.array(wakeIntentViewSchema).max(1000),
});

export const wakeIntentListQuerySchema = z.strictObject({
  projectId: idSchema.optional(),
  state: wakeIntentStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const wakeIntentClaimRequestSchema = z.strictObject({
  dispatcherInstanceId: idSchema,
  limit: z.coerce.number().int().min(1).max(WAKE_MAX_CLAIM_LIMIT).default(WAKE_DEFAULT_CLAIM_LIMIT),
  blockMs: z.coerce.number().int().min(0).max(30_000).default(WAKE_DEFAULT_BLOCK_MS),
  minIdleMs: z.coerce.number().int().min(0).max(86_400_000).default(WAKE_DEFAULT_MIN_IDLE_MS),
});

/** Private dispatcher target. It is intentionally absent from every public/browser view. */
export const wakeDispatchTargetSchema = z.strictObject({
  adapter: wakeAdapterSchema,
  nativeSessionId: nativeSessionIdSchema,
});

const claimedWakeIntentViewSchema = wakeIntentViewSchema.extend({
  state: z.literal('claimed'),
});

export const wakeIntentClaimItemSchema = z.union([
  z.strictObject({
    intent: claimedWakeIntentViewSchema,
    claimId: idSchema,
    target: wakeDispatchTargetSchema,
  }),
  z.strictObject({
    intent: claimedWakeIntentViewSchema,
    claimId: idSchema,
    refusalReasonCode: reasonCodeSchema,
  }),
]);

const indeterminateWakeIntentViewSchema = wakeIntentViewSchema.extend({
  state: z.literal('indeterminate'),
});

/**
 * Shared private result for fresh claims and XAUTOCLAIM recovery. Reclaimed
 * claimed work remains dispatchable through `items`; uncertain post-fence work
 * is reported separately after becoming terminal and acknowledged.
 */
export const wakeIntentClaimBatchResponseSchema = z.strictObject({
  items: z.array(wakeIntentClaimItemSchema).max(WAKE_MAX_CLAIM_LIMIT),
  recoveredDispatching: z.array(indeterminateWakeIntentViewSchema).max(WAKE_MAX_CLAIM_LIMIT),
  terminalAcknowledged: z.number().int().nonnegative().max(WAKE_MAX_CLAIM_LIMIT),
});

export const wakeIntentClaimResponseSchema = wakeIntentClaimBatchResponseSchema;
export const wakeIntentReclaimResponseSchema = wakeIntentClaimBatchResponseSchema;

export const wakeIntentDispatchingRequestSchema = z.strictObject({
  dispatcherInstanceId: idSchema,
  claimId: idSchema,
  attemptId: idSchema,
});

const wakeIntentMutationStatusSchema = z.enum(['updated', 'unchanged']);

export const wakeIntentDispatchingResponseSchema = z.strictObject({
  status: wakeIntentMutationStatusSchema,
  intent: wakeIntentViewSchema.extend({ state: z.literal('dispatching') }),
});

export const wakeIntentCompletionStateSchema = z.enum([
  'dispatched',
  'fallback_only',
  'indeterminate',
]);

export const wakeIntentCompleteRequestSchema = z.strictObject({
  dispatcherInstanceId: idSchema,
  claimId: idSchema,
  attemptId: idSchema,
  state: wakeIntentCompletionStateSchema,
  reasonCode: reasonCodeSchema,
});

export const wakeIntentCompleteResponseSchema = z.strictObject({
  status: wakeIntentMutationStatusSchema,
  intent: wakeIntentViewSchema.extend({ state: wakeIntentCompletionStateSchema }),
});

/**
 * A dispatcher asks the daemon for a bounded, PEL-verified recovery pass. It
 * cannot name an intent, claim, or attempt; those fences come from Redis.
 */
export const wakeIntentRecoverRequestSchema = z.strictObject({
  dispatcherInstanceId: idSchema,
  limit: z.coerce.number().int().min(1).max(WAKE_MAX_CLAIM_LIMIT).default(WAKE_DEFAULT_CLAIM_LIMIT),
  minIdleMs: z.coerce.number().int().min(0).max(86_400_000).default(WAKE_DEFAULT_MIN_IDLE_MS),
});

export const wakeIntentRecoverResponseSchema = wakeIntentClaimBatchResponseSchema;

export function parseWakeIntentView(input: unknown): WakeIntentView {
  return wakeIntentViewSchema.parse(input);
}

export type WakeAdapter = z.infer<typeof wakeAdapterSchema>;
export type WakeIntentState = z.infer<typeof wakeIntentStateSchema>;
export type WakeIntentView = z.infer<typeof wakeIntentViewSchema>;
export type WakeIntentCollection = z.infer<typeof wakeIntentCollectionSchema>;
export type WakeIntentListQuery = z.infer<typeof wakeIntentListQuerySchema>;
export type WakeIntentClaimRequest = z.infer<typeof wakeIntentClaimRequestSchema>;
export type WakeDispatchTarget = z.infer<typeof wakeDispatchTargetSchema>;
export type WakeIntentClaimItem = z.infer<typeof wakeIntentClaimItemSchema>;
export type WakeIntentClaimBatchResponse = z.infer<typeof wakeIntentClaimBatchResponseSchema>;
export type WakeIntentClaimResponse = WakeIntentClaimBatchResponse;
export type WakeIntentReclaimResponse = WakeIntentClaimBatchResponse;
export type WakeIntentDispatchingRequest = z.infer<typeof wakeIntentDispatchingRequestSchema>;
export type WakeIntentDispatchingResponse = z.infer<typeof wakeIntentDispatchingResponseSchema>;
export type WakeIntentCompleteRequest = z.infer<typeof wakeIntentCompleteRequestSchema>;
export type WakeIntentCompleteResponse = z.infer<typeof wakeIntentCompleteResponseSchema>;
export type WakeIntentRecoverRequest = z.infer<typeof wakeIntentRecoverRequestSchema>;
export type WakeIntentRecoverResponse = WakeIntentClaimBatchResponse;
