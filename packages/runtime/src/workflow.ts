export type WorkflowContinuationAuthorizationInput = {
  expectedRevision: number;
  actualRevision: number;
  expectedWakeIntentId: string;
  actualWakeIntentId: string | undefined;
};

export type WorkflowContinuationAuthorization =
  { allowed: true } | { allowed: false; reason: 'revision_mismatch' | 'wake_intent_mismatch' };

/**
 * Authorizes the single durable continuation fence. Repository code remains
 * responsible for atomically consuming the permitted revision and wake intent.
 */
export function authorizeWorkflowContinuation(
  input: WorkflowContinuationAuthorizationInput,
): WorkflowContinuationAuthorization {
  if (input.expectedRevision !== input.actualRevision) {
    return { allowed: false, reason: 'revision_mismatch' };
  }
  if (input.expectedWakeIntentId !== input.actualWakeIntentId) {
    return { allowed: false, reason: 'wake_intent_mismatch' };
  }
  return { allowed: true };
}
