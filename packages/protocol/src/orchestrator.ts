import { z } from 'zod';

import { plannedTaskSchema } from './goal.js';
import { taskVerdictSchema } from './task.js';

/**
 * Judgments: the bounded questions the orchestrator asks its brain, and the
 * schema every answer must satisfy before it is applied (ADR 0035). The brain
 * answers; it never acts.
 */

export const ORCHESTRATOR_CONTEXT_MAX_BYTES = 65_536;
export const ORCHESTRATOR_RATIONALE_MAX = 2048;
export const ORCHESTRATOR_FEEDBACK_MAX = 4096;

export const judgmentKindSchema = z.enum(['plan', 'review', 'replan', 'summarize']);

export const planDecisionSchema = z.strictObject({
  tasks: z.array(plannedTaskSchema).min(1).max(64),
  rationale: z.string().max(ORCHESTRATOR_RATIONALE_MAX).default(''),
  confidence: z.number().min(0).max(1).default(0.7),
});

export const reviewDecisionSchema = z.strictObject({
  verdict: taskVerdictSchema,
  feedback: z.string().max(ORCHESTRATOR_FEEDBACK_MAX).default(''),
  confidence: z.number().min(0).max(1).default(0.7),
});

export const replanDecisionSchema = z.strictObject({
  /** Ids of current non-terminal tasks to keep; the rest are cancelled. */
  keep: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  add: z.array(plannedTaskSchema).max(64).default([]),
  /** The brain may give up: the goal fails with this reason instead of replanning. */
  giveUp: z.string().max(1000).optional(),
  rationale: z.string().max(ORCHESTRATOR_RATIONALE_MAX).default(''),
  confidence: z.number().min(0).max(1).default(0.7),
});

export const summarizeDecisionSchema = z.strictObject({
  summary: z.string().trim().min(1).max(8192),
  workerNotes: z.record(z.string().min(1).max(128), z.string().max(1000)).default({}),
});

export const judgmentDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan'), decision: planDecisionSchema }),
  z.strictObject({ kind: z.literal('review'), decision: reviewDecisionSchema }),
  z.strictObject({ kind: z.literal('replan'), decision: replanDecisionSchema }),
  z.strictObject({ kind: z.literal('summarize'), decision: summarizeDecisionSchema }),
]);

export type JudgmentKind = z.infer<typeof judgmentKindSchema>;
export type PlanDecision = z.infer<typeof planDecisionSchema>;
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type ReplanDecision = z.infer<typeof replanDecisionSchema>;
export type SummarizeDecision = z.infer<typeof summarizeDecisionSchema>;
export type JudgmentDecision = z.infer<typeof judgmentDecisionSchema>;
