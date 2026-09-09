import { z } from 'zod';

import { messageTerminalStateSchema } from './message.js';

const idSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

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
  reasonCode: z.string().trim().min(1).max(128).optional(),
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

export const wakeIntentDispatchingRequestSchema = z.strictObject({
  dispatcherInstanceId: idSchema,
  claimId: idSchema,
  attemptId: idSchema,
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
  reasonCode: z.string().trim().min(1).max(128),
});

export function parseWakeIntentView(input: unknown): WakeIntentView {
  return wakeIntentViewSchema.parse(input);
}

export type WakeAdapter = z.infer<typeof wakeAdapterSchema>;
export type WakeIntentState = z.infer<typeof wakeIntentStateSchema>;
export type WakeIntentView = z.infer<typeof wakeIntentViewSchema>;
export type WakeIntentCollection = z.infer<typeof wakeIntentCollectionSchema>;
export type WakeIntentListQuery = z.infer<typeof wakeIntentListQuerySchema>;
export type WakeIntentClaimRequest = z.infer<typeof wakeIntentClaimRequestSchema>;
export type WakeIntentDispatchingRequest = z.infer<typeof wakeIntentDispatchingRequestSchema>;
export type WakeIntentCompleteRequest = z.infer<typeof wakeIntentCompleteRequestSchema>;
