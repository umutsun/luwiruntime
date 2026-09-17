import {
  AUTOPILOT_DISPATCH_WINDOW_MS,
  leasePathsConflict,
  normalizeLeasePath,
  type AutopilotMode,
  type AutopilotPolicy,
  type SessionView,
  type Task,
  type TaskDispatchDenialReason,
  type TaskGate,
  type WorkLease,
} from '@luwi/protocol';

import { rankAgentSessions } from './message-routing.js';

/**
 * Whether a task may be dispatched now (ADR 0035). Pure: the daemon gathers the
 * inputs and applies the answer; the Redis Function re-checks the atomic subset
 * (state, in-flight count, rate window, overlap) with the same limits.
 */

export type DispatchEvaluation =
  | { decision: 'dispatch'; targetSession: SessionView }
  | { decision: 'gate'; gate: TaskGate }
  | { decision: 'deny'; reason: TaskDispatchDenialReason; detail: string };

export type EvaluateDispatchInput = {
  mode: AutopilotMode;
  policy: AutopilotPolicy;
  task: Task;
  /** The effective worker agent ids (see `effectiveWorkers`). */
  workers: readonly string[];
  /** Tasks currently `dispatching` or `dispatched` in the project. */
  inFlight: readonly Pick<Task, 'id' | 'matchPaths' | 'agentId' | 'targetSessionId' | 'state'>[];
  /** Epoch ms of dispatches inside the rate window. */
  recentDispatchesMs: readonly number[];
  /** The task's dependencies, as currently stored; a missing one counts as unmet. */
  dependencies: readonly Pick<Task, 'id' | 'state' | 'verification'>[];
  /** Held leases in the project. */
  leases: readonly Pick<WorkLease, 'matchPath' | 'sessionId' | 'agentId' | 'state'>[];
  /** Every session the runtime holds; ranking picks the worker's best one. */
  sessions: readonly SessionView[];
  nowMs: number;
};

/** A task that declares no path touches the whole project: the empty match form prefixes everything. */
export function taskMatchPaths(paths: readonly string[]): string[] {
  return paths.length === 0 ? [''] : [...paths];
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((one) => right.some((other) => leasePathsConflict(one, other)));
}

export function evaluateDispatch(input: EvaluateDispatchInput): DispatchEvaluation {
  const { task, policy } = input;
  if (input.mode === 'off') {
    return { decision: 'deny', reason: 'mode_off', detail: 'Autopilot is off for this project.' };
  }
  if (task.state !== 'ready' && task.state !== 'approved') {
    return {
      decision: 'deny',
      reason: 'task_state',
      detail: `A ${task.state} task cannot be dispatched.`,
    };
  }
  if (task.agentId === undefined) {
    return { decision: 'deny', reason: 'worker_not_allowed', detail: 'The task names no worker.' };
  }
  if (task.agentId === policy.coordinatorAgentId || !input.workers.includes(task.agentId)) {
    return {
      decision: 'deny',
      reason: 'worker_not_allowed',
      detail: `Agent ${task.agentId} is not an autopilot worker of this project.`,
    };
  }
  for (const dependencyId of task.dependsOn) {
    const dependency = input.dependencies.find((candidate) => candidate.id === dependencyId);
    if (
      dependency === undefined ||
      dependency.state !== 'done' ||
      dependency.verification?.verdict !== 'accept'
    ) {
      return {
        decision: 'deny',
        reason: 'dependency_unmet',
        detail: `Task ${dependencyId} is not done and accepted yet.`,
      };
    }
  }
  if (task.state !== 'approved') {
    if (input.mode === 'supervised') return { decision: 'gate', gate: 'supervised' };
    const protectedMatches = policy.protectedPaths.map(
      (path) => normalizeLeasePath(path).matchPath,
    );
    if (overlaps(task.matchPaths, protectedMatches)) {
      return { decision: 'gate', gate: 'protected_path' };
    }
  }
  if (input.inFlight.length >= policy.maxInFlight) {
    return {
      decision: 'deny',
      reason: 'in_flight_limit',
      detail: `${String(input.inFlight.length)} of ${String(policy.maxInFlight)} tasks are already in flight.`,
    };
  }
  const windowStart = input.nowMs - AUTOPILOT_DISPATCH_WINDOW_MS;
  const recent = input.recentDispatchesMs.filter((at) => at > windowStart).length;
  if (recent >= policy.maxDispatchesPerHour) {
    return {
      decision: 'deny',
      reason: 'rate_limit',
      detail: `${String(recent)} dispatches in the last hour reach the limit of ${String(policy.maxDispatchesPerHour)}.`,
    };
  }
  const overlapping = input.inFlight.find((other) => overlaps(task.matchPaths, other.matchPaths));
  if (overlapping !== undefined) {
    return {
      decision: 'deny',
      reason: 'path_overlap',
      detail: `Task ${overlapping.id} is in flight over an overlapping path.`,
    };
  }
  const workerSessionIds = new Set(
    input.sessions
      .filter((session) => session.agentId === task.agentId)
      .map((session) => session.id),
  );
  const leased = input.leases.find(
    (lease) =>
      lease.state === 'held' &&
      !workerSessionIds.has(lease.sessionId) &&
      overlaps(task.matchPaths, [lease.matchPath]),
  );
  if (leased !== undefined) {
    return {
      decision: 'deny',
      reason: 'lease_overlap',
      detail: `Session ${leased.sessionId} (${leased.agentId}) holds a lease over an overlapping path.`,
    };
  }
  const [targetSession] = rankAgentSessions({
    sessions: input.sessions,
    projectId: task.projectId,
    agentId: task.agentId,
  });
  if (targetSession === undefined) {
    return {
      decision: 'deny',
      reason: 'worker_unavailable',
      detail: `No online, ready session of ${task.agentId} in this project.`,
    };
  }
  return { decision: 'dispatch', targetSession };
}
