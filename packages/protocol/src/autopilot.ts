import { z } from 'zod';

import { MESSAGE_MAX_TIMEOUT_MS } from './message.js';
import { normalizeLeasePath } from './lease.js';
import { agentIdSchema } from './session.js';

/**
 * Per-project autopilot (ADR 0035).
 *
 * The mode is operator-held runtime state — never canonical, default `off`.
 * The policy is a declaration of who may do what: the coordinator agent that
 * owns the orchestrator loop, the worker agents it may dispatch to, the agents
 * whose sessions may act for the operator (the human in the LuwiBot chat), the
 * paths that always wait for a human, and the budgets the runtime enforces.
 */

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

export const AUTOPILOT_MAX_WORKERS = 16;
export const AUTOPILOT_MAX_PROTECTED_PATHS = 32;
export const AUTOPILOT_MAX_IN_FLIGHT = 8;
export const AUTOPILOT_MAX_DISPATCHES_PER_HOUR = 120;
export const AUTOPILOT_DISPATCH_WINDOW_MS = 3_600_000;
export const AUTOPILOT_DEFAULT_TASK_TIMEOUT_MS = 1_800_000;

export const autopilotModeSchema = z.enum(['off', 'supervised', 'autopilot']);

const projectRelativePathSchema = z
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
    { message: 'A protected path must be relative to the project root.' },
  );

/** Budgets a goal carries; the policy's `goalDefaults` seeds them. */
export const goalBudgetSchema = z.strictObject({
  maxTasks: z.number().int().min(1).max(64).default(12),
  maxReworksPerTask: z.number().int().min(0).max(4).default(1),
  maxReplans: z.number().int().min(0).max(8).default(2),
  maxWallClockMs: z.number().int().min(60_000).max(604_800_000).default(14_400_000),
  minConfidence: z.number().min(0).max(1).default(0.6),
});

export const autopilotPolicySchema = z
  .strictObject({
    coordinatorAgentId: agentIdSchema,
    /** Empty means every enabled binding of the project except the coordinator. */
    workerAgentIds: z.array(agentIdSchema).max(AUTOPILOT_MAX_WORKERS).default([]),
    /** A read-only reviewer for verification; never the task's own author. */
    reviewerAgentId: agentIdSchema.optional(),
    /**
     * Sessions of these agents may approve, answer and abandon on the operator's
     * behalf — the human in the LuwiBot chat, relayed through the bot's tools.
     */
    operatorProxyAgentIds: z.array(agentIdSchema).max(AUTOPILOT_MAX_WORKERS).default([]),
    protectedPaths: z
      .array(projectRelativePathSchema)
      .max(AUTOPILOT_MAX_PROTECTED_PATHS)
      .default([]),
    maxInFlight: z.number().int().min(1).max(AUTOPILOT_MAX_IN_FLIGHT).default(2),
    maxDispatchesPerHour: z
      .number()
      .int()
      .min(1)
      .max(AUTOPILOT_MAX_DISPATCHES_PER_HOUR)
      .default(20),
    defaultTaskTimeoutMs: z
      .number()
      .int()
      .min(60_000)
      .max(MESSAGE_MAX_TIMEOUT_MS)
      .default(AUTOPILOT_DEFAULT_TASK_TIMEOUT_MS),
    maxJudgmentsPerHour: z.number().int().min(1).max(600).default(30),
    maxConcurrentGoals: z.number().int().min(1).max(8).default(1),
    goalDefaults: goalBudgetSchema.default({
      maxTasks: 12,
      maxReworksPerTask: 1,
      maxReplans: 2,
      maxWallClockMs: 14_400_000,
      minConfidence: 0.6,
    }),
    /** How many past retrospectives the next plan judgment is shown. */
    retrospectives: z.number().int().min(0).max(20).default(5),
  })
  .superRefine((value, context) => {
    if (value.workerAgentIds.includes(value.coordinatorAgentId)) {
      context.addIssue({
        code: 'custom',
        message: 'The coordinator cannot be one of its own workers.',
        path: ['workerAgentIds'],
      });
    }
    if (value.reviewerAgentId === value.coordinatorAgentId) {
      context.addIssue({
        code: 'custom',
        message: 'The coordinator cannot be the reviewer.',
        path: ['reviewerAgentId'],
      });
    }
  });

export const autopilotRecordSchema = z.strictObject({
  projectId: identifierSchema,
  mode: autopilotModeSchema,
  policy: autopilotPolicySchema.nullable(),
  policyHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** Monotonic; every write is a compare-and-set on it. */
  version: z.number().int().min(1),
  changedAt: timestampSchema,
});

export const autopilotPolicyPutRequestSchema = autopilotPolicySchema;
export const autopilotModeRequestSchema = z.strictObject({ mode: autopilotModeSchema });

export const autopilotModeResponseSchema = z.strictObject({
  record: autopilotRecordSchema,
  changed: z.boolean(),
  /** Whether an online coordinator session received the wake-up notice. */
  coordinatorNotified: z.boolean(),
});

export const autopilotKickResponseSchema = z.strictObject({
  coordinatorNotified: z.boolean(),
  coordinatorSessionId: identifierSchema.optional(),
});

export const autopilotCollectionSchema = z.strictObject({
  records: z.array(autopilotRecordSchema).max(1000),
});

/** One project's autopilot, with the coordinator's presence derived from live sessions. */
export const autopilotStatusResponseSchema = z.strictObject({
  record: autopilotRecordSchema.nullable(),
  coordinatorOnline: z.boolean(),
  coordinatorSessionIds: z.array(identifierSchema).max(100),
});

export const autopilotErrorCodeSchema = z.enum([
  'AUTOPILOT_NOT_CONFIGURED',
  'AUTOPILOT_NOT_COORDINATOR',
  'AUTOPILOT_NOT_OPERATOR',
  'AUTOPILOT_DISPATCH_REQUIRED',
  'AUTOPILOT_POLICY_INVALID',
  'AUTOPILOT_VERSION_CONFLICT',
]);

export type AutopilotMode = z.infer<typeof autopilotModeSchema>;
export type AutopilotPolicy = z.infer<typeof autopilotPolicySchema>;
export type AutopilotPolicyInput = z.input<typeof autopilotPolicySchema>;
export type GoalBudget = z.infer<typeof goalBudgetSchema>;
export type AutopilotRecord = z.infer<typeof autopilotRecordSchema>;
export type AutopilotModeResponse = z.infer<typeof autopilotModeResponseSchema>;
export type AutopilotKickResponse = z.infer<typeof autopilotKickResponseSchema>;
export type AutopilotCollection = z.infer<typeof autopilotCollectionSchema>;
export type AutopilotStatusResponse = z.infer<typeof autopilotStatusResponseSchema>;
export type AutopilotErrorCode = z.infer<typeof autopilotErrorCodeSchema>;
