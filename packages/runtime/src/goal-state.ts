import {
  goalBudgetSchema,
  type Goal,
  type GoalEscalation,
  type GoalRetrospective,
  type GoalState,
} from '@luwi/protocol';

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

/** The schema's own maximum, so an answer never writes a budget the record would refuse. */
const REPLAN_CEILING =
  goalBudgetSchema.shape.maxReplans.unwrap().maxValue ?? Number.POSITIVE_INFINITY;

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
            // The plan judgment carried the operator's answer; the plan consumes it.
            answer: undefined,
            usage: { ...goal.usage, tasks: goal.usage.tasks + transition.taskIds.length },
          },
          now,
        ),
      };
    // A plan decision, like an answer, is the operator acting on the goal: the wall clock
    // (usage.startedAt) restarts. Both are reachable only through the daemon's operator paths.
    case 'plan_approved':
      if (goal.state !== 'plan_review') return invalid(goal, transition, 'no plan is under review');
      return {
        status: 'ok',
        goal: next(goal, { state: 'running', usage: { ...goal.usage, startedAt: now } }, now),
      };
    case 'plan_rejected': {
      if (goal.state !== 'plan_review') return invalid(goal, transition, 'no plan is under review');
      // The rejection note is the guidance for the next plan; it counts as a replan.
      const usage = { ...goal.usage, replans: goal.usage.replans + 1, startedAt: now };
      if (usage.replans > goal.budget.maxReplans) {
        return {
          status: 'ok',
          goal: next(
            goal,
            {
              state: 'blocked',
              taskIds: [],
              usage,
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
            usage,
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
    case 'answer': {
      if (goal.state !== 'blocked')
        return invalid(goal, transition, 'the goal is not waiting on an answer');
      // Budgets are never raised by a session: only the operator's (or its policy-named proxy's) answer extends them.
      // An answer to a running goal is consumed by a replan judgment, and a budget answer may need
      // one after planning: leave at least one replan, even after a rejection counted past it.
      const replansSpent =
        (goal.escalation?.reason === 'budget_exhausted' || goal.taskIds.length > 0) &&
        goal.usage.replans >= goal.budget.maxReplans;
      const maxReplans = Math.max(goal.budget.maxReplans, goal.usage.replans) + 1;
      if (replansSpent && maxReplans > REPLAN_CEILING) {
        return invalid(goal, transition, 'the replan budget is at its ceiling; abandon the goal');
      }
      // Back to planning when there is no plan to continue, otherwise running; the
      // cycle's next plan or replan judgment carries the answer and consumes it.
      // The operator acted, so the wall clock restarts.
      return {
        status: 'ok',
        goal: next(
          goal,
          {
            state: goal.taskIds.length === 0 ? 'planning' : 'running',
            escalation: undefined,
            answer: { text: transition.text, at: now, by: transition.by },
            usage: { ...goal.usage, startedAt: now },
            ...(replansSpent ? { budget: { ...goal.budget, maxReplans } } : {}),
          },
          now,
        ),
      };
    }
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
