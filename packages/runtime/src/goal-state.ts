import type { Goal, GoalEscalation, GoalRetrospective, GoalState } from '@luwi/protocol';

/**
 * The goal lifecycle (ADR 0035) as a pure transition function. The operator's
 * moves (approve, reject, answer, abandon) and the orchestrator's moves
 * (start, plan, escalate, achieve, fail, replan, retrospective) share one table
 * so nothing can move a goal by a path the table does not name.
 */

export type GoalTransition =
  | { kind: 'start' }
  | { kind: 'plan'; taskIds: string[]; rationale?: string; needsReview: boolean }
  | { kind: 'plan_approved' }
  | { kind: 'plan_rejected'; note?: string; by: string }
  | { kind: 'escalate'; escalation: Omit<GoalEscalation, 'askedAt'> }
  | { kind: 'answer'; text: string; by: string }
  | { kind: 'abandon'; reason?: string }
  | { kind: 'achieve' }
  | { kind: 'fail'; reason: string }
  | { kind: 'replan'; taskIds: string[]; rationale?: string; needsReview: boolean }
  | { kind: 'retrospective'; retrospective: Omit<GoalRetrospective, 'writtenAt'> }
  | { kind: 'count_judgment'; invalid: boolean }
  | { kind: 'count_task'; reworks?: number };

export type GoalTransitionResult =
  | { status: 'ok'; goal: Goal }
  | { status: 'invalid'; from: GoalState; transition: GoalTransition['kind']; reason: string };

const TERMINAL: ReadonlySet<GoalState> = new Set(['achieved', 'failed', 'abandoned']);

export function isTerminalGoalState(state: GoalState): boolean {
  return TERMINAL.has(state);
}

function invalid(goal: Goal, transition: GoalTransition, reason: string): GoalTransitionResult {
  return { status: 'invalid', from: goal.state, transition: transition.kind, reason };
}

function next(goal: Goal, patch: Partial<Goal>, now: string): Goal {
  return { ...goal, ...patch, version: goal.version + 1, updatedAt: now };
}

export function applyGoalTransition(
  goal: Goal,
  transition: GoalTransition,
  now: string,
): GoalTransitionResult {
  switch (transition.kind) {
    case 'start':
      if (goal.state !== 'proposed')
        return invalid(goal, transition, 'only a proposed goal starts');
      return {
        status: 'ok',
        goal: next(goal, { state: 'planning', usage: { ...goal.usage, startedAt: now } }, now),
      };
    case 'plan':
      if (goal.state !== 'planning')
        return invalid(goal, transition, 'only a planning goal takes a plan');
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            state: transition.needsReview ? 'plan_review' : 'running',
            planVersion: goal.planVersion + 1,
            taskIds: transition.taskIds,
            ...(transition.rationale === undefined ? {} : { planRationale: transition.rationale }),
            usage: { ...goal.usage, tasks: goal.usage.tasks + transition.taskIds.length },
          },
          now,
        ),
      };
    case 'plan_approved':
      if (goal.state !== 'plan_review') return invalid(goal, transition, 'no plan is under review');
      return { status: 'ok', goal: next(goal, { state: 'running' }, now) };
    case 'plan_rejected': {
      if (goal.state !== 'plan_review') return invalid(goal, transition, 'no plan is under review');
      // The rejection note is the guidance for the next plan; it counts as a replan.
      const replans = goal.usage.replans + 1;
      if (replans > goal.budget.maxReplans) {
        return {
          status: 'ok',
          goal: next(
            goal,
            {
              state: 'blocked',
              taskIds: [],
              usage: { ...goal.usage, replans },
              escalation: {
                reason: 'budget_exhausted',
                question: `The plan was rejected and the replan budget (${String(goal.budget.maxReplans)}) is spent. Answer with guidance to allow one more plan, or abandon the goal.`,
                askedAt: now,
              },
            },
            now,
          ),
        };
      }
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            state: 'planning',
            taskIds: [],
            usage: { ...goal.usage, replans },
            answer: {
              text: transition.note ?? 'The plan was rejected without a note.',
              at: now,
              by: transition.by,
            },
          },
          now,
        ),
      };
    }
    case 'escalate':
      if (goal.state !== 'planning' && goal.state !== 'running' && goal.state !== 'plan_review') {
        return invalid(goal, transition, 'only an active goal can escalate');
      }
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            state: 'blocked',
            escalation: { ...transition.escalation, askedAt: now },
            answer: undefined,
          },
          now,
        ),
      };
    case 'answer':
      if (goal.state !== 'blocked')
        return invalid(goal, transition, 'the goal is not waiting on an answer');
      // Back to planning when there is no plan to continue, otherwise running;
      // the cycle runs a replan judgment with the answer in context either way.
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            state: goal.taskIds.length === 0 ? 'planning' : 'running',
            escalation: undefined,
            answer: { text: transition.text, at: now, by: transition.by },
          },
          now,
        ),
      };
    case 'abandon':
      if (isTerminalGoalState(goal.state))
        return invalid(goal, transition, 'the goal is already over');
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            state: 'abandoned',
            terminalAt: now,
            ...(transition.reason === undefined ? {} : { failureReason: transition.reason }),
          },
          now,
        ),
      };
    case 'achieve':
      if (goal.state !== 'running')
        return invalid(goal, transition, 'only a running goal is achieved');
      return { status: 'ok', goal: next(goal, { state: 'achieved', terminalAt: now }, now) };
    case 'fail':
      if (isTerminalGoalState(goal.state))
        return invalid(goal, transition, 'the goal is already over');
      return {
        status: 'ok',
        goal: next(
          goal,
          { state: 'failed', terminalAt: now, failureReason: transition.reason },
          now,
        ),
      };
    case 'replan': {
      if (goal.state !== 'running' && goal.state !== 'planning') {
        return invalid(goal, transition, 'only an active goal replans');
      }
      const replans = goal.usage.replans + 1;
      if (replans > goal.budget.maxReplans) {
        return invalid(goal, transition, 'the replan budget is spent');
      }
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            state: transition.needsReview ? 'plan_review' : 'running',
            planVersion: goal.planVersion + 1,
            taskIds: transition.taskIds,
            ...(transition.rationale === undefined ? {} : { planRationale: transition.rationale }),
            answer: undefined,
            usage: {
              ...goal.usage,
              replans,
              tasks:
                goal.usage.tasks + Math.max(0, transition.taskIds.length - goal.taskIds.length),
            },
          },
          now,
        ),
      };
    }
    case 'retrospective':
      if (!isTerminalGoalState(goal.state))
        return invalid(goal, transition, 'the goal is not over yet');
      if (goal.retrospective !== undefined) return invalid(goal, transition, 'already written');
      return {
        status: 'ok',
        goal: next(goal, { retrospective: { ...transition.retrospective, writtenAt: now } }, now),
      };
    case 'count_judgment':
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            usage: {
              ...goal.usage,
              judgments: goal.usage.judgments + 1,
              invalidJudgments: goal.usage.invalidJudgments + (transition.invalid ? 1 : 0),
            },
          },
          now,
        ),
      };
    case 'count_task':
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            usage: {
              ...goal.usage,
              tasks: goal.usage.tasks + 1,
              reworks: goal.usage.reworks + (transition.reworks ?? 0),
            },
          },
          now,
        ),
      };
    default:
      return invalid(goal, transition, 'unknown transition');
  }
}
