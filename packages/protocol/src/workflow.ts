import { z } from 'zod';

import { agentIdSchema } from './session.js';

const idSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });
const nonBlankStringSchema = z.string().trim().min(1);

export const workflowStateSchema = z.enum(['active', 'waiting_for_human', 'completed', 'failed']);

export const workflowViewSchema = z
  .strictObject({
    id: idSchema,
    projectId: idSchema,
    coordinatorSessionId: idSchema,
    rootCorrelationId: idSchema,
    objective: nonBlankStringSchema.max(4000),
    revision: z.number().int().positive(),
    state: workflowStateSchema,
    currentMessageId: idSchema.optional(),
    currentWakeIntentId: idSchema.optional(),
    currentHumanContinuationId: idSchema.optional(),
    humanDecision: nonBlankStringSchema.max(2000).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((workflow, context) => {
    const hasWake = workflow.currentWakeIntentId !== undefined;
    const hasHumanId = workflow.currentHumanContinuationId !== undefined;
    const hasHumanDecision = workflow.humanDecision !== undefined;
    if (hasWake && (hasHumanId || hasHumanDecision)) {
      context.addIssue({
        code: 'custom',
        message: 'Wake and human continuation fences are mutually exclusive.',
        path: ['currentWakeIntentId'],
      });
    }
    if (hasHumanId !== hasHumanDecision) {
      context.addIssue({
        code: 'custom',
        message: 'Human continuation id and decision must be present together.',
        path: ['currentHumanContinuationId'],
      });
    }
    if (workflow.state === 'waiting_for_human' && (!hasHumanId || !hasHumanDecision)) {
      context.addIssue({
        code: 'custom',
        message: 'A waiting workflow requires a complete human continuation fence.',
        path: ['state'],
      });
    }
    if (workflow.state !== 'waiting_for_human' && (hasHumanId || hasHumanDecision)) {
      context.addIssue({
        code: 'custom',
        message: 'Only a waiting workflow may expose a human continuation fence.',
        path: ['state'],
      });
    }
    if (workflow.state !== 'active' && hasWake) {
      context.addIssue({
        code: 'custom',
        message: 'Only an active workflow may expose a wake continuation fence.',
        path: ['currentWakeIntentId'],
      });
    }
  });

export const workflowCollectionSchema = z.strictObject({
  workflows: z.array(workflowViewSchema).max(1000),
});

/** Mirrors the bounded indexes the workflow repository can query without a scan. */
export const workflowListQuerySchema = z.strictObject({
  projectId: idSchema.optional(),
  coordinatorSessionId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const workflowCreateRequestSchema = z.strictObject({
  objective: nonBlankStringSchema.max(4000),
  coordinatorSessionId: idSchema,
  rootCorrelationId: idSchema,
  firstMessage: z.strictObject({
    targetAgentId: agentIdSchema,
    kind: z.enum(['question', 'status_request', 'instruction']),
    subject: nonBlankStringSchema.max(512).optional(),
    content: nonBlankStringSchema.max(32_768),
  }),
});

const nextMessageDecisionSchema = z.strictObject({
  kind: z.literal('next_message'),
  targetAgentId: agentIdSchema,
  message: z.strictObject({
    kind: z.enum(['question', 'status_request', 'instruction']),
    subject: nonBlankStringSchema.max(512).optional(),
    content: nonBlankStringSchema.max(32_768),
  }),
});
const completeDecisionSchema = z.strictObject({ kind: z.literal('complete') });
const waitingForHumanDecisionSchema = z.strictObject({
  kind: z.literal('waiting_for_human'),
  humanDecision: nonBlankStringSchema.max(2000),
});

export const workflowDecisionSchema = z.discriminatedUnion('kind', [
  nextMessageDecisionSchema,
  completeDecisionSchema,
  waitingForHumanDecisionSchema,
]);

export const workflowContinuationProofSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('wake'), wakeIntentId: idSchema }),
  z.strictObject({ kind: z.literal('human'), continuationId: idSchema }),
]);

export const continueWorkflowRequestSchema = z.strictObject({
  workflowId: idSchema,
  expectedRevision: z.number().int().positive(),
  proof: workflowContinuationProofSchema,
  decision: workflowDecisionSchema,
});

export function parseContinueWorkflowRequest(input: unknown): ContinueWorkflowRequest {
  return continueWorkflowRequestSchema.parse(input);
}

export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type WorkflowView = z.infer<typeof workflowViewSchema>;
export type WorkflowCollection = z.infer<typeof workflowCollectionSchema>;
export type WorkflowListQuery = z.infer<typeof workflowListQuerySchema>;
export type WorkflowCreateRequest = z.infer<typeof workflowCreateRequestSchema>;
export type WorkflowDecision = z.infer<typeof workflowDecisionSchema>;
export type WorkflowContinuationProof = z.infer<typeof workflowContinuationProofSchema>;
export type ContinueWorkflowRequest = z.infer<typeof continueWorkflowRequestSchema>;
