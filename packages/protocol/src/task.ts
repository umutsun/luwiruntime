import { z } from 'zod';

import { normalizeLeasePath } from './lease.js';
import {
  MESSAGE_MAX_CONTENT_BYTES,
  MESSAGE_MAX_EVIDENCE_ITEMS,
  MESSAGE_MAX_TIMEOUT_MS,
  evidenceTypeSchema,
} from './message.js';
import { agentIdSchema } from './session.js';
import { utf8ByteLength } from './utf8-bytes.js';

/**
 * A task is one unit of dispatched work inside a goal (ADR 0035): a brief that
 * becomes an `instruction` message to a bridge worker, declared paths the
 * runtime checks for overlap, and an outcome copied from the worker's own
 * answer. The runtime never judges quality here; the orchestrator's verdict is
 * recorded beside the outcome, never in place of it.
 */

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

export const TASK_MAX_PATHS = 32;
export const TASK_MAX_DEPENDENCIES = 8;
export const TASK_MAX_BRIEF_BYTES = MESSAGE_MAX_CONTENT_BYTES;
export const TASK_MAX_ACTIVE_PER_PROJECT = 200;
export const TASK_MAX_OUTCOME_ANSWER_CHARS = 4096;

export const taskStateSchema = z.enum([
  'ready',
  'awaiting_approval',
  'approved',
  'dispatching',
  'dispatched',
  'done',
  'failed',
  'cancelled',
  'rejected',
]);

export const taskTerminalStateSchema = z.enum(['done', 'failed', 'cancelled', 'rejected']);

export const taskGateSchema = z.enum(['supervised', 'protected_path']);

export const taskPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) => {
      try {
        normalizeLeasePath(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'A task path must be relative to the project root.' },
  );

const briefSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, { message: 'A brief cannot be blank.' })
  .refine((value) => utf8ByteLength(value) <= TASK_MAX_BRIEF_BYTES, {
    message: `A brief must not exceed ${String(TASK_MAX_BRIEF_BYTES)} UTF-8 bytes.`,
  });

export const taskOutcomeSchema = z.strictObject({
  messageState: z.enum(['responded', 'rejected', 'failed', 'timed_out']),
  status: z.enum(['answered', 'partially_answered', 'rejected', 'failed']).optional(),
  /** The first characters of the worker's answer; the whole answer is on the message. */
  answer: z.string().max(TASK_MAX_OUTCOME_ANSWER_CHARS).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidenceCount: z.number().int().min(0),
  evidenceTypes: z.array(evidenceTypeSchema).max(MESSAGE_MAX_EVIDENCE_ITEMS).default([]),
});

export const taskCheckSchema = z.strictObject({
  check: z.enum(['evidence_required', 'commit_evidence', 'test_claim', 'answer_status']),
  passed: z.boolean(),
  detail: z.string().max(500),
});

export const taskVerdictSchema = z.enum(['accept', 'rework', 'escalate']);

export const taskVerificationSchema = z.strictObject({
  checks: z.array(taskCheckSchema).max(16),
  verdict: taskVerdictSchema.optional(),
  feedback: z.string().max(4096).optional(),
  confidence: z.number().min(0).max(1).optional(),
  decidedAt: timestampSchema.optional(),
  reviewTaskId: identifierSchema.optional(),
});

export const taskSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  goalId: identifierSchema,
  title: z.string().trim().min(1).max(200),
  brief: briefSchema,
  agentId: agentIdSchema.optional(),
  /** As declared, for display. */
  paths: z.array(taskPathSchema).max(TASK_MAX_PATHS),
  /** The lease match forms of `paths`; `['']` when no path was declared (the whole project). */
  matchPaths: z.array(z.string().max(4097)).min(1).max(TASK_MAX_PATHS),
  dependsOn: z.array(identifierSchema).max(TASK_MAX_DEPENDENCIES),
  evidenceRequirements: z.array(evidenceTypeSchema).max(MESSAGE_MAX_EVIDENCE_ITEMS),
  timeoutMs: z.number().int().min(60_000).max(MESSAGE_MAX_TIMEOUT_MS),
  doneCriteria: z.string().max(2000).optional(),
  /** `review` tasks verify another task; `work` tasks change things. */
  kind: z.enum(['work', 'review']),
  reviewOf: identifierSchema.optional(),
  reworkOf: identifierSchema.optional(),
  reworkCount: z.number().int().min(0),
  state: taskStateSchema,
  gate: taskGateSchema.optional(),
  approval: z
    .strictObject({
      decision: z.enum(['approved', 'rejected']),
      at: timestampSchema,
      by: z.string().max(200),
      note: z.string().max(500).optional(),
    })
    .optional(),
  correlationId: identifierSchema.optional(),
  targetSessionId: identifierSchema.optional(),
  dispatchSourceSessionId: identifierSchema.optional(),
  dispatchedAt: timestampSchema.optional(),
  terminalAt: timestampSchema.optional(),
  outcome: taskOutcomeSchema.optional(),
  verification: taskVerificationSchema.optional(),
  /** The last refused dispatch, kept on the record so the refusal is readable. */
  lastDenial: z
    .strictObject({
      reason: z.string().max(64),
      detail: z.string().max(1000),
      at: timestampSchema,
    })
    .optional(),
  version: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const taskCollectionSchema = z.strictObject({
  tasks: z.array(taskSchema).max(1000),
  truncated: z.boolean(),
});

export const taskListQuerySchema = z.strictObject({
  goalId: identifierSchema.optional(),
  state: taskStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const taskDispatchDenialReasonSchema = z.enum([
  'mode_off',
  'task_state',
  'worker_not_allowed',
  'dependency_unmet',
  'in_flight_limit',
  'rate_limit',
  'path_overlap',
  'lease_overlap',
  'worker_unavailable',
]);

export const taskDispatchRequestSchema = z.strictObject({ sessionId: identifierSchema });

export const taskDispatchResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('dispatched'),
    task: taskSchema,
    correlationId: identifierSchema,
  }),
  z.strictObject({ outcome: z.literal('gated'), task: taskSchema, gate: taskGateSchema }),
  z.strictObject({
    outcome: z.literal('denied'),
    task: taskSchema,
    reason: taskDispatchDenialReasonSchema,
    detail: z.string().max(1000),
  }),
]);

export const taskVerdictRequestSchema = z.strictObject({
  sessionId: identifierSchema,
  verdict: taskVerdictSchema,
  feedback: z.string().max(4096).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const taskCancelRequestSchema = z.strictObject({
  sessionId: identifierSchema.optional(),
  reason: z.string().max(500).optional(),
});

export const taskErrorCodeSchema = z.enum([
  'TASK_NOT_FOUND',
  'TASK_STATE_INVALID',
  'TASK_PATH_INVALID',
  'TASK_DEPENDENCY_INVALID',
  'TASK_LIMIT_REACHED',
  'TASK_VERSION_CONFLICT',
]);

export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskGate = z.infer<typeof taskGateSchema>;
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;
export type TaskCheck = z.infer<typeof taskCheckSchema>;
export type TaskVerdict = z.infer<typeof taskVerdictSchema>;
export type TaskVerification = z.infer<typeof taskVerificationSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskCollection = z.infer<typeof taskCollectionSchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type TaskDispatchDenialReason = z.infer<typeof taskDispatchDenialReasonSchema>;
export type TaskDispatchResponse = z.infer<typeof taskDispatchResponseSchema>;
export type TaskVerdictRequest = z.infer<typeof taskVerdictRequestSchema>;
export type TaskErrorCode = z.infer<typeof taskErrorCodeSchema>;

/** What the in-flight hash holds per task: enough for the overlap scan and completion lookup. */
export const activeTaskEntrySchema = z.strictObject({
  taskId: identifierSchema,
  goalId: identifierSchema,
  agentId: agentIdSchema,
  state: z.enum(['dispatching', 'dispatched']),
  matchPaths: z.array(z.string().max(4097)).min(1).max(TASK_MAX_PATHS),
  correlationId: identifierSchema.optional(),
});
export type ActiveTaskEntry = z.infer<typeof activeTaskEntrySchema>;
