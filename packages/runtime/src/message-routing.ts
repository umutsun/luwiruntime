import type { AgentId, MessageDelivery, SessionView } from '@luwi/protocol';

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
  | { status: 'selected'; session: SessionView; reason: string; delivery: MessageDelivery }
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

// A managed worker launched via the native bridge carries metadata.bridge === 'native-headless'
// (set at `session bridge native` startup); interactive / PM sessions that auto-register under the
// same agentId (via `session attach`) do not. An agentId-routed dispatch is meant for a worker, so we
// PREFER bridge workers over interactive sessions that merely share the agentId — otherwise an idle
// PM session (rank 0, fresh heartbeat) wins selection and the task never reaches the worker. This is a
// preference, not a hard filter: with no bridge worker present, an interactive session is still a valid
// fallback, so single-session setups keep working. A direct targetSessionId is unaffected.
function isDispatchWorker(session: SessionView): boolean {
  return session.metadata['bridge'] === 'native-headless';
}

// A LIVE bridge session runs a continuous inbox-claim loop, so it answers within a claim block:
// `live`. Two conditions must BOTH hold. (1) It carries a non-empty `metadata.bridge` — the
// native-headless fleet worker, the DeepSeek ACP bridge, or any future bridge; this is deliberately
// BROADER than `isDispatchWorker` (native-headless only), which governs routing PREFERENCE, not
// reader liveness. (2) It is still available — online and non-terminal. The bridge flag alone is
// insufficient: it is retained on the record after the bridge exits, so an offline, `completed`, or
// `disconnected` session still carries it. `deliveryForSession` is also called OUTSIDE the
// `selectMessageTarget` availability gate — the daemon re-derives delivery when an idempotent
// re-ask replays against the retained target — so classifying a dead bridge session `live` there
// resurrects the exact false-timeout this signal exists to prevent. Anything not a live bridge
// reader (an interactive GUI, or a bridge whose reader is gone) is `deferred`: the message waits in
// the durable inbox until a reader claims it (ADR 0006 turn-based-GUI gap).
export function deliveryForSession(session: SessionView): MessageDelivery {
  const bridge = session.metadata['bridge'];
  const isBridge = typeof bridge === 'string' && bridge.length > 0;
  return isBridge && isAvailable(session) ? 'live' : 'deferred';
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
      delivery: deliveryForSession(target),
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
      // Managed bridge workers first, so a dispatch never lands on an interactive/PM session that
      // shares the agentId while a real worker is available.
      const workerDifference = Number(isDispatchWorker(right)) - Number(isDispatchWorker(left));
      if (workerDifference !== 0) {
        return workerDifference;
      }
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
    delivery: deliveryForSession(selected),
  };
}
