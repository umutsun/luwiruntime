import { z } from 'zod';

import { goalBudgetSchema } from './autopilot.js';
import { evidenceTypeSchema, MESSAGE_MAX_EVIDENCE_ITEMS } from './message.js';
import { agentIdSchema } from './session.js';
import { taskPathSchema, TASK_MAX_DEPENDENCIES, TASK_MAX_PATHS } from './task.js';
import { utf8ByteLength } from './utf8-bytes.js';

/**
 * A goal is the unit of autonomy (ADR 0035): an objective with acceptance
 * criteria and a budget, a versioned plan of tasks, and at most one open
 * question to the operator at a time.
 */

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

export const GOAL_MAX_OBJECTIVE_BYTES = 32_768;
export const GOAL_MAX_CRITERIA = 16;
export const GOAL_MAX_RETROSPECTIVE_BYTES = 8_192;
export const GOAL_MAX_RETROSPECTIVES_PER_PROJECT = 20;

export const goalStateSchema = z.enum([
  'proposed',
  'planning',
  'plan_review',
  'running',
  'blocked',
  'achieved',
  'failed',
  'abandoned',
]);

export const goalTerminalStateSchema = z.enum(['achieved', 'failed', 'abandoned']);

export const escalationReasonSchema = z.enum([
  'budget_exhausted',
  'rework_limit',
  'low_confidence',
  'brain_invalid',
  'brain_unavailable',
  'worker_unavailable',
  'review_escalated',
  'plan_rejected',
]);

export const goalActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operator'), via: z.string().max(200).optional() }),
  z.strictObject({
    kind: z.literal('session'),
    sessionId: identifierSchema,
    agentId: agentIdSchema,
  }),
]);

const objectiveSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, { message: 'An objective cannot be blank.' })
  .refine((value) => utf8ByteLength(value) <= GOAL_MAX_OBJECTIVE_BYTES, {
    message: `An objective must not exceed ${String(GOAL_MAX_OBJECTIVE_BYTES)} UTF-8 bytes.`,
  });

export const goalEscalationSchema = z.strictObject({
  reason: escalationReasonSchema,
  question: z.string().trim().min(1).max(4000),
  options: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  taskId: identifierSchema.optional(),
  askedAt: timestampSchema,
});

export const goalAnswerSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  at: timestampSchema,
  by: z.string().max(200),
});

const goalRetrospectiveObjectSchema = z.strictObject({
  summary: z.string().trim().min(1).max(GOAL_MAX_RETROSPECTIVE_BYTES),
  workerNotes: z.record(agentIdSchema, z.string().max(1000)).default({}),
  writtenAt: timestampSchema,
});

export const goalRetrospectiveSchema = goalRetrospectiveObjectSchema.refine(
  (value) => utf8ByteLength(JSON.stringify(value)) <= GOAL_MAX_RETROSPECTIVE_BYTES * 2,
  { message: 'A retrospective is too large.' },
);

/** What the orchestrator submits; the runtime stamps `writtenAt`. */
export const goalRetrospectiveInputSchema = goalRetrospectiveObjectSchema.omit({ writtenAt: true });

export const goalUsageSchema = z.strictObject({
  tasks: z.number().int().min(0),
  reworks: z.number().int().min(0),
  replans: z.number().int().min(0),
  judgments: z.number().int().min(0),
  invalidJudgments: z.number().int().min(0),
  startedAt: timestampSchema.optional(),
});

export const goalSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  title: z.string().trim().min(1).max(200),
  objective: objectiveSchema,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(GOAL_MAX_CRITERIA),
  createdBy: goalActorSchema,
  budget: goalBudgetSchema,
  state: goalStateSchema,
  planVersion: z.number().int().min(0),
  /** The current plan's task ids in dependency order; empty before the first plan. */
  taskIds: z.array(identifierSchema).max(64),
  planRationale: z.string().max(2048).optional(),
  escalation: goalEscalationSchema.optional(),
  answer: goalAnswerSchema.optional(),
  usage: goalUsageSchema,
  retrospective: goalRetrospectiveSchema.optional(),
  failureReason: z.string().max(1000).optional(),
  version: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  terminalAt: timestampSchema.optional(),
});

export const goalCollectionSchema = z.strictObject({
  goals: z.array(goalSchema).max(1000),
  truncated: z.boolean(),
});

export const goalListQuerySchema = z.strictObject({
  state: goalStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const goalCreateRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  objective: objectiveSchema,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(500)).max(GOAL_MAX_CRITERIA).default([]),
  /** A session creating on the operator's behalf; absent means the operator surface itself. */
  sessionId: identifierSchema.optional(),
  budget: goalBudgetSchema.partial().optional(),
});

/** One planned task as the brain proposes it; ids are assigned by the runtime. */
export const plannedTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(32_768),
  agentId: agentIdSchema,
  paths: z.array(taskPathSchema).max(TASK_MAX_PATHS).default([]),
  /** Indices into the same plan; earlier tasks only. */
  dependsOn: z.array(z.number().int().min(0).max(63)).max(TASK_MAX_DEPENDENCIES).default([]),
  evidenceRequirements: z.array(evidenceTypeSchema).max(MESSAGE_MAX_EVIDENCE_ITEMS).default([]),
  doneCriteria: z.string().max(2000).optional(),
});

export const goalPlanRequestSchema = z.strictObject({
  sessionId: identifierSchema,
  tasks: z.array(plannedTaskSchema).max(64),
  /** On a replan: ids of current non-terminal tasks to keep; every other one is cancelled. */
  keep: z.array(identifierSchema).max(64).optional(),
  rationale: z.string().max(2048).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const goalPlanDecisionRequestSchema = z.strictObject({
  sessionId: identifierSchema.optional(),
  note: z.string().max(500).optional(),
});

export const goalAnswerRequestSchema = z.strictObject({
  sessionId: identifierSchema.optional(),
  text: z.string().trim().min(1).max(4000),
});

export const goalAbandonRequestSchema = z.strictObject({
  sessionId: identifierSchema.optional(),
  reason: z.string().max(500).optional(),
});

/** The orchestrator's own transitions, taken from the bound coordinator session. */
export const goalTransitionRequestSchema = z.discriminatedUnion('transition', [
  z.strictObject({
    transition: z.literal('escalate'),
    sessionId: identifierSchema,
    escalation: goalEscalationSchema.omit({ askedAt: true }),
  }),
  z.strictObject({ transition: z.literal('achieve'), sessionId: identifierSchema }),
  z.strictObject({
    transition: z.literal('fail'),
    sessionId: identifierSchema,
    reason: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({
    transition: z.literal('retrospective'),
    sessionId: identifierSchema,
    retrospective: goalRetrospectiveInputSchema,
  }),
  /** Records one brain judgment on the goal and in the event stream — never the prompt. */
  z.strictObject({
    transition: z.literal('count_judgment'),
    sessionId: identifierSchema,
    kind: z.enum(['plan', 'review', 'replan', 'summarize']),
    invalid: z.boolean().default(false),
    brain: z.string().max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
    summary: z.string().max(500).optional(),
    promptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    ms: z.number().int().min(0).optional(),
  }),
]);

export const goalErrorCodeSchema = z.enum([
  'GOAL_NOT_FOUND',
  'GOAL_STATE_INVALID',
  'GOAL_PLAN_INVALID',
  'GOAL_LIMIT_REACHED',
  'GOAL_VERSION_CONFLICT',
]);

export type GoalState = z.infer<typeof goalStateSchema>;
export type EscalationReason = z.infer<typeof escalationReasonSchema>;
export type GoalActor = z.infer<typeof goalActorSchema>;
export type GoalEscalation = z.infer<typeof goalEscalationSchema>;
export type GoalRetrospective = z.infer<typeof goalRetrospectiveSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type GoalCollection = z.infer<typeof goalCollectionSchema>;
export type GoalListQuery = z.infer<typeof goalListQuerySchema>;
export type GoalCreateRequest = z.infer<typeof goalCreateRequestSchema>;
export type PlannedTask = z.infer<typeof plannedTaskSchema>;
export type GoalPlanRequest = z.infer<typeof goalPlanRequestSchema>;
export type GoalTransitionRequest = z.infer<typeof goalTransitionRequestSchema>;
export type GoalErrorCode = z.infer<typeof goalErrorCodeSchema>;
