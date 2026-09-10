import type { AgentId, SessionView } from '@luwi/protocol';

const statusRank: Readonly<Record<SessionView['status'], number>> = {
  idle: 0,
  waiting_for_input: 1,
  waiting_for_agent: 2,
  starting: 3,
  thinking: 4,
  tool_running: 5,
  blocked: 6,
  completed: 7,
  disconnected: 8,
};

export type MessageTargetSelection =
  | { status: 'selected'; session: SessionView; reason: string }
  | { status: 'project_mismatch'; targetSessionId: string }
  | { status: 'unavailable'; selector: string };

export type SelectMessageTargetInput = {
  sourceSession: SessionView;
  sessions: readonly SessionView[];
  targetSessionId?: string;
  targetAgentId?: AgentId;
};

function isAvailable(session: SessionView): boolean {
  return (
    session.presence === 'online' &&
    session.status !== 'completed' &&
    session.status !== 'disconnected'
  );
}

export function selectMessageTarget(input: SelectMessageTargetInput): MessageTargetSelection {
  if (input.targetSessionId !== undefined) {
    const target = input.sessions.find((candidate) => candidate.id === input.targetSessionId);
    if (target === undefined || !isAvailable(target)) {
      return { status: 'unavailable', selector: input.targetSessionId };
    }
    if (target.projectId !== input.sourceSession.projectId) {
      return { status: 'project_mismatch', targetSessionId: target.id };
    }
    return {
      status: 'selected',
      session: target,
      reason: `direct target session ${target.id}`,
    };
  }

  const targetAgentId = input.targetAgentId;
  if (targetAgentId === undefined) {
    return { status: 'unavailable', selector: '' };
  }

  const candidates = input.sessions
    .filter(
      (candidate) =>
        candidate.agentId === targetAgentId &&
        candidate.projectId === input.sourceSession.projectId &&
        isAvailable(candidate) &&
        // ponytail: 'starting' means no inbox reader has confirmed readiness yet, so
        // auto-routing to it guarantees a message.timed_out. A worker becomes selectable
        // only once it leaves 'starting' (reader-readiness transition, ADR 0031). A direct
        // targetSessionId is intentionally unaffected — a caller naming a session gets it.
        candidate.status !== 'starting',
    )
    .toSorted((left, right) => {
      const rankDifference = statusRank[left.status] - statusRank[right.status];
      if (rankDifference !== 0) {
        return rankDifference;
      }
      const heartbeatDifference =
        Date.parse(right.lastHeartbeatAt) - Date.parse(left.lastHeartbeatAt);
      if (heartbeatDifference !== 0) {
        return heartbeatDifference;
      }
      return left.id.localeCompare(right.id);
    });

  const selected = candidates[0];
  if (selected === undefined) {
    return { status: 'unavailable', selector: targetAgentId };
  }
  return {
    status: 'selected',
    session: selected,
    reason: `selected agent ${targetAgentId} session ${selected.id} by status, heartbeat, and session ID`,
  };
}
