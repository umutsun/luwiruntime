import { createHash } from 'node:crypto';

import type {
  ContinueWorkflowRequest,
  WorkflowContinuationProof,
  WorkflowDecision,
  WorkflowState,
  WakeIntentState,
} from '@luwi/protocol';

export type WorkflowDecisionFingerprintInput = ContinueWorkflowRequest & {
  actorSessionId: string;
};

/** Hashes only semantic authority and decision fields, never generated message routing ids. */
export function createWorkflowDecisionFingerprint(input: WorkflowDecisionFingerprintInput): string {
  const proof =
    input.proof.kind === 'wake'
      ? { kind: 'wake', wakeIntentId: input.proof.wakeIntentId }
      : { kind: 'human', continuationId: input.proof.continuationId };
  const decision =
    input.decision.kind === 'next_message'
      ? {
          kind: 'next_message',
          targetAgentId: input.decision.targetAgentId,
          message: {
            kind: input.decision.message.kind,
            ...(input.decision.message.subject === undefined
              ? {}
              : { subject: input.decision.message.subject }),
            content: input.decision.message.content,
          },
        }
      : input.decision.kind === 'waiting_for_human'
        ? { kind: 'waiting_for_human', humanDecision: input.decision.humanDecision }
        : { kind: 'complete' };
  return createHash('sha256')
    .update(
      JSON.stringify({
        workflowId: input.workflowId,
        expectedRevision: input.expectedRevision,
        proof,
        decision,
        actorSessionId: input.actorSessionId,
      }),
    )
    .digest('hex');
}

type WorkflowAuthorizationView = {
  id: string;
  projectId: string;
  coordinatorSessionId: string;
  revision: number;
  state: WorkflowState;
  currentWakeIntentId?: string;
  currentHumanContinuationId?: string;
};

type CoordinatorAuthorizationView = {
  sessionId: string;
  agentId: string;
  projectId: string;
};

type ActorAuthorizationView = CoordinatorAuthorizationView & {
  live: boolean;
};

type WakeAuthorizationView = {
  id: string;
  workflowId: string;
  workflowRevision: number;
  sourceSessionId: string;
  state: WakeIntentState;
};

export type WorkflowContinuationAuthorizationInput = {
  expectedRevision: number;
  workflow: WorkflowAuthorizationView;
  coordinator: CoordinatorAuthorizationView;
  actor: ActorAuthorizationView;
  proof: WorkflowContinuationProof;
  wakeIntent?: WakeAuthorizationView;
  decisionKind: WorkflowDecision['kind'];
};

export type WorkflowContinuationRefusalReason =
  | 'revision_mismatch'
  | 'workflow_state_mismatch'
  | 'coordinator_mismatch'
  | 'actor_unavailable'
  | 'actor_agent_mismatch'
  | 'actor_project_mismatch'
  | 'wake_intent_mismatch'
  | 'wake_record_mismatch'
  | 'wake_intent_state_invalid'
  | 'human_continuation_mismatch'
  | 'replacement_coordinator_required';

export type WorkflowContinuationAuthorization =
  | { allowed: true; rebindCoordinator: boolean }
  | { allowed: false; reason: WorkflowContinuationRefusalReason };

const continuableWakeStates = new Set<WakeIntentState>([
  'dispatching',
  'dispatched',
  'indeterminate',
]);

/**
 * Evaluates the public continuation fence and the trusted actor observation.
 * Redis remains responsible for checking the same facts and consuming the
 * revision atomically with the committed decision receipt.
 */
export function authorizeWorkflowContinuation(
  input: WorkflowContinuationAuthorizationInput,
): WorkflowContinuationAuthorization {
  if (input.expectedRevision !== input.workflow.revision) {
    return { allowed: false, reason: 'revision_mismatch' };
  }
  if (
    input.coordinator.sessionId !== input.workflow.coordinatorSessionId ||
    input.coordinator.projectId !== input.workflow.projectId
  ) {
    return { allowed: false, reason: 'coordinator_mismatch' };
  }
  if (!input.actor.live) {
    return { allowed: false, reason: 'actor_unavailable' };
  }
  if (input.actor.projectId !== input.workflow.projectId) {
    return { allowed: false, reason: 'actor_project_mismatch' };
  }
  if (input.actor.agentId !== input.coordinator.agentId) {
    return { allowed: false, reason: 'actor_agent_mismatch' };
  }

  if (input.proof.kind === 'wake') {
    if (input.workflow.state !== 'active') {
      return { allowed: false, reason: 'workflow_state_mismatch' };
    }
    if (input.actor.sessionId !== input.workflow.coordinatorSessionId) {
      return { allowed: false, reason: 'coordinator_mismatch' };
    }
    if (input.workflow.currentWakeIntentId !== input.proof.wakeIntentId) {
      return { allowed: false, reason: 'wake_intent_mismatch' };
    }
    if (
      input.wakeIntent === undefined ||
      input.wakeIntent.id !== input.proof.wakeIntentId ||
      input.wakeIntent.workflowId !== input.workflow.id ||
      input.wakeIntent.workflowRevision !== input.workflow.revision ||
      input.wakeIntent.sourceSessionId !== input.workflow.coordinatorSessionId
    ) {
      return { allowed: false, reason: 'wake_record_mismatch' };
    }
    if (!continuableWakeStates.has(input.wakeIntent.state)) {
      return { allowed: false, reason: 'wake_intent_state_invalid' };
    }
    return { allowed: true, rebindCoordinator: false };
  }

  if (input.workflow.state !== 'waiting_for_human') {
    return { allowed: false, reason: 'workflow_state_mismatch' };
  }
  if (input.workflow.currentHumanContinuationId !== input.proof.continuationId) {
    return { allowed: false, reason: 'human_continuation_mismatch' };
  }
  const replacement = input.actor.sessionId !== input.workflow.coordinatorSessionId;
  if (input.decisionKind === 'next_message' && !replacement) {
    return { allowed: false, reason: 'replacement_coordinator_required' };
  }
  return { allowed: true, rebindCoordinator: replacement && input.decisionKind === 'next_message' };
}
