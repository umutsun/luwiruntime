import type {
  Task,
  TaskCheck,
  TaskGate,
  TaskOutcome,
  TaskState,
  TaskVerdict,
} from '@luwi/protocol';

/**
 * The task state machine (ADR 0035), as a pure function from a task and a
 * transition to the next task or a typed refusal. The Redis Function checks
 * only the version; every rule about which move is legal lives here.
 */

export type TaskTransition =
  | { kind: 'gate'; gate: TaskGate }
  | { kind: 'approve'; by: string; note?: string }
  | { kind: 'reject'; by: string; note?: string }
  | { kind: 'cancel' }
  | { kind: 'dispatching'; sourceSessionId: string }
  | { kind: 'dispatched'; correlationId: string; targetSessionId: string }
  | { kind: 'dispatch_failed'; reason: string }
  | { kind: 'complete'; outcome: TaskOutcome; checks: TaskCheck[] }
  | {
      kind: 'verdict';
      verdict: TaskVerdict;
      feedback?: string;
      confidence?: number;
      reviewTaskId?: string;
    }
  | { kind: 'review_task'; reviewTaskId: string }
  | {
      kind: 'update';
      fields: Partial<
        Pick<
          Task,
          | 'title'
          | 'brief'
          | 'agentId'
          | 'paths'
          | 'matchPaths'
          | 'dependsOn'
          | 'evidenceRequirements'
          | 'timeoutMs'
          | 'doneCriteria'
        >
      >;
    };

export type TaskTransitionResult =
  | { status: 'ok'; task: Task }
  | { status: 'invalid'; from: TaskState; transition: TaskTransition['kind']; reason: string };

const TERMINAL: ReadonlySet<TaskState> = new Set(['done', 'failed', 'cancelled', 'rejected']);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL.has(state);
}

export function isInFlightTaskState(state: TaskState): boolean {
  return state === 'dispatching' || state === 'dispatched';
}

function invalid(task: Task, transition: TaskTransition, reason: string): TaskTransitionResult {
  return { status: 'invalid', from: task.state, transition: transition.kind, reason };
}

function next(task: Task, patch: Partial<Task>, now: string): Task {
  return { ...task, ...patch, version: task.version + 1, updatedAt: now };
}

export function applyTaskTransition(
  task: Task,
  transition: TaskTransition,
  now: string,
): TaskTransitionResult {
  switch (transition.kind) {
    case 'gate':
      if (task.state !== 'ready')
        return invalid(task, transition, 'only a ready task can be gated');
      return {
        status: 'ok',
        task: next(task, { state: 'awaiting_approval', gate: transition.gate }, now),
      };
    case 'approve':
      if (task.state !== 'awaiting_approval' && task.state !== 'ready') {
        return invalid(task, transition, 'only a ready or gated task can be approved');
      }
      return {
        status: 'ok',
        task: next(
          task,
          {
            state: 'approved',
            approval: {
              decision: 'approved',
              at: now,
              by: transition.by,
              ...(transition.note === undefined ? {} : { note: transition.note }),
            },
          },
          now,
        ),
      };
    case 'reject':
      if (task.state !== 'awaiting_approval') {
        return invalid(task, transition, 'only a gated task can be rejected');
      }
      return {
        status: 'ok',
        task: next(
          task,
          {
            state: 'rejected',
            terminalAt: now,
            approval: {
              decision: 'rejected',
              at: now,
              by: transition.by,
              ...(transition.note === undefined ? {} : { note: transition.note }),
            },
          },
          now,
        ),
      };
    case 'cancel':
      if (
        task.state !== 'ready' &&
        task.state !== 'awaiting_approval' &&
        task.state !== 'approved'
      ) {
        return invalid(
          task,
          transition,
          'a dispatched task belongs to its worker until its deadline; a terminal one is already over',
        );
      }
      return { status: 'ok', task: next(task, { state: 'cancelled', terminalAt: now }, now) };
    case 'dispatching':
      if (task.state !== 'ready' && task.state !== 'approved') {
        return invalid(task, transition, 'only a ready or approved task can be dispatched');
      }
      return {
        status: 'ok',
        task: next(
          task,
          { state: 'dispatching', dispatchSourceSessionId: transition.sourceSessionId },
          now,
        ),
      };
    case 'dispatched':
      if (task.state !== 'dispatching') {
        return invalid(task, transition, 'only a dispatching task can become dispatched');
      }
      return {
        status: 'ok',
        task: next(
          task,
          {
            state: 'dispatched',
            correlationId: transition.correlationId,
            targetSessionId: transition.targetSessionId,
            dispatchedAt: now,
          },
          now,
        ),
      };
    case 'dispatch_failed':
      if (task.state !== 'dispatching') {
        return invalid(task, transition, 'only a dispatching task can fail to dispatch');
      }
      return {
        status: 'ok',
        task: next(
          task,
          {
            state: 'failed',
            terminalAt: now,
            outcome: {
              messageState: 'failed',
              answer: transition.reason,
              evidenceCount: 0,
              evidenceTypes: [],
            },
          },
          now,
        ),
      };
    case 'complete': {
      if (task.state !== 'dispatched') {
        return invalid(task, transition, 'only a dispatched task can complete');
      }
      const state: TaskState = transition.outcome.messageState === 'responded' ? 'done' : 'failed';
      return {
        status: 'ok',
        task: next(
          task,
          {
            state,
            terminalAt: now,
            outcome: transition.outcome,
            verification: { checks: transition.checks },
          },
          now,
        ),
      };
    }
    case 'review_task':
      if (task.state !== 'done' || task.verification === undefined) {
        return invalid(task, transition, 'only a completed task can be reviewed');
      }
      if (task.verification.verdict !== undefined) {
        return invalid(task, transition, 'the task already has a verdict');
      }
      return {
        status: 'ok',
        task: next(
          task,
          { verification: { ...task.verification, reviewTaskId: transition.reviewTaskId } },
          now,
        ),
      };
    case 'verdict':
      if (task.state !== 'done' || task.verification === undefined) {
        return invalid(task, transition, 'only a completed task can receive a verdict');
      }
      if (task.verification.verdict !== undefined) {
        return invalid(task, transition, 'the task already has a verdict');
      }
      return {
        status: 'ok',
        task: next(
          task,
          {
            verification: {
              ...task.verification,
              verdict: transition.verdict,
              decidedAt: now,
              ...(transition.feedback === undefined ? {} : { feedback: transition.feedback }),
              ...(transition.confidence === undefined ? {} : { confidence: transition.confidence }),
              ...(transition.reviewTaskId === undefined
                ? {}
                : { reviewTaskId: transition.reviewTaskId }),
            },
          },
          now,
        ),
      };
    case 'update': {
      if (task.state !== 'ready' && task.state !== 'awaiting_approval') {
        return invalid(task, transition, 'only a ready or gated task can be edited');
      }
      // An edit to a gated task returns it to ready: the operator approved a
      // particular brief, not a slot.
      const patch: Partial<Task> = { ...transition.fields };
      if (task.state === 'awaiting_approval') {
        patch.state = 'ready';
        patch.gate = undefined;
      }
      return { status: 'ok', task: next(task, patch, now) };
    }
    default:
      return invalid(task, transition, 'unknown transition');
  }
}
