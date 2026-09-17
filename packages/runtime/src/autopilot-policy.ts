import type { AutopilotMode, AutopilotPolicy, AutopilotRecord, SessionView } from '@luwi/protocol';

/**
 * Pure autopilot policy (ADR 0035): who the coordinator is, who may work, who
 * may speak for the operator, and what a mode change means. Nothing here
 * touches Redis; the daemon applies the answers.
 */

export type ModeChangeEvaluation =
  | { status: 'changed'; from: AutopilotMode; to: AutopilotMode }
  | { status: 'unchanged'; mode: AutopilotMode }
  | { status: 'not_configured' };

export function evaluateModeChange(
  record: AutopilotRecord | null,
  requested: AutopilotMode,
): ModeChangeEvaluation {
  const current = record?.mode ?? 'off';
  if (requested !== 'off' && (record === null || record.policy === null)) {
    return { status: 'not_configured' };
  }
  if (current === requested) return { status: 'unchanged', mode: current };
  return { status: 'changed', from: current, to: requested };
}

/** The agents a dispatch may target: the declared list, or every enabled binding but the coordinator. */
export function effectiveWorkers(
  policy: AutopilotPolicy,
  bindings: readonly { agentId: string; enabled: boolean }[],
): string[] {
  if (policy.workerAgentIds.length > 0) return [...policy.workerAgentIds];
  return bindings
    .filter((binding) => binding.enabled && binding.agentId !== policy.coordinatorAgentId)
    .map((binding) => binding.agentId);
}

function isLive(session: SessionView): boolean {
  return (
    session.presence === 'online' &&
    session.status !== 'completed' &&
    session.status !== 'disconnected'
  );
}

export function isCoordinatorSession(
  policy: AutopilotPolicy,
  session: SessionView,
  projectId: string,
): boolean {
  return (
    session.projectId === projectId &&
    session.agentId === policy.coordinatorAgentId &&
    isLive(session)
  );
}

/** A session that may approve, answer and abandon for the operator — the human behind the bot. */
export function isOperatorProxySession(
  policy: AutopilotPolicy,
  session: SessionView,
  projectId: string,
): boolean {
  return (
    session.projectId === projectId &&
    policy.operatorProxyAgentIds.includes(session.agentId) &&
    isLive(session)
  );
}

/**
 * Once a policy names a coordinator, an `instruction` from it outside a task
 * is refused: dispatch is the only choke point. Questions and status requests
 * stay free in every mode — asking is not orchestration (ADR 0025).
 */
export function coordinatorInstructionRefused(input: {
  policy: AutopilotPolicy | null;
  sourceAgentId: string;
  kind: 'question' | 'status_request' | 'instruction';
  origin: 'client' | 'task';
}): boolean {
  if (input.origin === 'task' || input.kind !== 'instruction' || input.policy === null)
    return false;
  return input.sourceAgentId === input.policy.coordinatorAgentId;
}
