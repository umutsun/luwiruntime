import type {
  AutopilotMode,
  AutopilotPolicy,
  EscalationReason,
  Goal,
  JudgmentKind,
  Task,
} from '@luwi/protocol';

import { isTerminalGoalState } from './goal-state.js';
import { isInFlightTaskState, isTerminalTaskState } from './task-state.js';

/**
 * One cycle of the orchestrator (ADR 0035): from what the store says to the
 * actions the bridge should take now. Pure, so every state combination is a
 * table row in a test, and stateless, so a restarted bridge resumes from the
 * store. At most one judgment per goal per cycle.
 */

export type CycleState = {
  nowMs: number;
  mode: AutopilotMode;
  policy: AutopilotPolicy;
  goals: readonly Goal[];
  tasks: readonly Task[];
  /** Judgments already made in the current hour, for `maxJudgmentsPerHour`. */
  judgmentsInWindow: number;
};

export type CycleAction =
  | { type: 'start_goal'; goalId: string }
  | { type: 'judge'; kind: JudgmentKind; goalId: string; taskId?: string }
  | { type: 'dispatch'; taskId: string; goalId: string }
  | { type: 'create_review_task'; taskId: string; goalId: string }
  | { type: 'rework'; taskId: string; goalId: string }
  | {
      type: 'escalate';
      goalId: string;
      reason: EscalationReason;
      question: string;
      taskId?: string;
    }
  | { type: 'achieve'; goalId: string }
  | { type: 'fail'; goalId: string; reason: string };

const ACTIVE: ReadonlySet<Goal['state']> = new Set([
  'planning',
  'plan_review',
  'running',
  'blocked',
]);

export function planCycle(state: CycleState): CycleAction[] {
  if (state.mode === 'off') return [];
  const actions: CycleAction[] = [];
  let judgmentsLeft = Math.max(0, state.policy.maxJudgmentsPerHour - state.judgmentsInWindow);
  const judge = (action: Extract<CycleAction, { type: 'judge' }>): boolean => {
    if (judgmentsLeft <= 0) return false;
    judgmentsLeft -= 1;
    actions.push(action);
    return true;
  };

  const tasksOf = (goal: Goal): Task[] =>
    goal.taskIds
      .map((id) => state.tasks.find((task) => task.id === id))
      .filter((task): task is Task => task !== undefined);
  const inFlightCount = state.tasks.filter((task) => isInFlightTaskState(task.state)).length;
  let dispatchSlots = Math.max(0, state.policy.maxInFlight - inFlightCount);

  const activeGoals = state.goals.filter((goal) => ACTIVE.has(goal.state));
  const proposed = [...state.goals]
    .filter((goal) => goal.state === 'proposed')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (activeGoals.length < state.policy.maxConcurrentGoals && proposed[0] !== undefined) {
    actions.push({ type: 'start_goal', goalId: proposed[0].id });
  }

  for (const goal of state.goals) {
    if (isTerminalGoalState(goal.state)) {
      if (goal.retrospective === undefined)
        judge({ type: 'judge', kind: 'summarize', goalId: goal.id });
      continue;
    }
    if (goal.state === 'plan_review' || goal.state === 'blocked' || goal.state === 'proposed')
      continue;

    const startedAt =
      goal.usage.startedAt === undefined ? undefined : Date.parse(goal.usage.startedAt);
    if (startedAt !== undefined && state.nowMs - startedAt > goal.budget.maxWallClockMs) {
      actions.push({
        type: 'escalate',
        goalId: goal.id,
        reason: 'budget_exhausted',
        question: `The goal has run for longer than its wall-clock budget (${String(Math.round(goal.budget.maxWallClockMs / 60_000))} min). Answer to extend it with guidance, or abandon it.`,
      });
      continue;
    }

    if (goal.state === 'planning') {
      judge({ type: 'judge', kind: 'plan', goalId: goal.id });
      continue;
    }

    // running
    const tasks = tasksOf(goal);
    if (goal.answer !== undefined) {
      judge({ type: 'judge', kind: 'replan', goalId: goal.id });
      continue;
    }

    const escalatedTask = tasks.find((task) => task.verification?.verdict === 'escalate');
    if (escalatedTask !== undefined) {
      actions.push({
        type: 'escalate',
        goalId: goal.id,
        reason: 'review_escalated',
        taskId: escalatedTask.id,
        question: `Task "${escalatedTask.title}" needs a decision: ${escalatedTask.verification?.feedback ?? 'the review asked for a human.'}`,
      });
      continue;
    }

    const reworkTask = tasks.find(
      (task) =>
        task.verification?.verdict === 'rework' &&
        !state.tasks.some((other) => other.reworkOf === task.id),
    );
    if (reworkTask !== undefined) {
      if (reworkTask.reworkCount >= goal.budget.maxReworksPerTask) {
        actions.push({
          type: 'escalate',
          goalId: goal.id,
          reason: 'rework_limit',
          taskId: reworkTask.id,
          question: `Task "${reworkTask.title}" was reworked ${String(reworkTask.reworkCount)} time(s) and still needs work: ${reworkTask.verification?.feedback ?? ''}. Answer with guidance, or abandon the goal.`,
        });
      } else {
        actions.push({ type: 'rework', taskId: reworkTask.id, goalId: goal.id });
      }
      continue;
    }

    const needsVerdict = tasks.find(
      (task) =>
        task.state === 'done' &&
        task.verification !== undefined &&
        task.verification.verdict === undefined,
    );
    if (needsVerdict !== undefined) {
      const reviewTaskId = needsVerdict.verification?.reviewTaskId;
      if (
        reviewTaskId === undefined &&
        needsVerdict.kind === 'work' &&
        state.policy.reviewerAgentId !== undefined &&
        state.policy.reviewerAgentId !== needsVerdict.agentId
      ) {
        actions.push({ type: 'create_review_task', taskId: needsVerdict.id, goalId: goal.id });
        continue;
      }
      const reviewTask =
        reviewTaskId === undefined
          ? undefined
          : state.tasks.find((task) => task.id === reviewTaskId);
      if (reviewTask !== undefined && !isTerminalTaskState(reviewTask.state)) {
        // A review dispatch that keeps being denied because the reviewer has no
        // online session would loop every tick and stall the goal on verify
        // silently (measured live: a reviewer out of credits). Park it for the
        // operator instead — answering once the reviewer is back retries.
        if (
          (reviewTask.state === 'ready' || reviewTask.state === 'approved') &&
          reviewTask.lastDenial?.reason === 'worker_unavailable'
        ) {
          actions.push({
            type: 'escalate',
            goalId: goal.id,
            reason: 'worker_unavailable',
            taskId: needsVerdict.id,
            question: `The reviewer (${state.policy.reviewerAgentId ?? 'unassigned'}) is unavailable to verify task "${needsVerdict.title}": ${reviewTask.lastDenial.detail}. Answer once it is back to retry, or abandon the goal.`,
          });
          continue;
        }
        // The reviewer is still working; dispatch it if it has not gone out yet.
        if (
          (reviewTask.state === 'ready' || reviewTask.state === 'approved') &&
          dispatchSlots > 0
        ) {
          dispatchSlots -= 1;
          actions.push({ type: 'dispatch', taskId: reviewTask.id, goalId: goal.id });
        }
        continue;
      }
      judge({ type: 'judge', kind: 'review', goalId: goal.id, taskId: needsVerdict.id });
      continue;
    }

    const broken = tasks.find((task) => task.state === 'failed' || task.state === 'rejected');
    if (broken !== undefined) {
      if (goal.usage.replans >= goal.budget.maxReplans) {
        actions.push({
          type: 'escalate',
          goalId: goal.id,
          reason: 'budget_exhausted',
          taskId: broken.id,
          question: `Task "${broken.title}" ${broken.state} and the replan budget (${String(goal.budget.maxReplans)}) is spent: ${broken.outcome?.answer ?? ''}. Answer with guidance to allow one more replan, or abandon the goal.`,
        });
      } else {
        judge({ type: 'judge', kind: 'replan', goalId: goal.id });
      }
      continue;
    }

    if (tasks.length > 0 && tasks.every((task) => isTerminalTaskState(task.state))) {
      const accepted = tasks.filter(
        (task) => task.state === 'done' && task.verification?.verdict === 'accept',
      );
      if (
        accepted.length > 0 &&
        tasks.every((task) => task.state === 'cancelled' || task.verification?.verdict === 'accept')
      ) {
        actions.push({ type: 'achieve', goalId: goal.id });
      } else {
        actions.push({
          type: 'fail',
          goalId: goal.id,
          reason: 'Every task in the plan is over and none was accepted.',
        });
      }
      continue;
    }

    for (const task of tasks) {
      if (dispatchSlots <= 0) break;
      if (task.state !== 'ready' && task.state !== 'approved') continue;
      const ready = task.dependsOn.every((id) => {
        const dependency = state.tasks.find((candidate) => candidate.id === id);
        return dependency?.state === 'done' && dependency.verification?.verdict === 'accept';
      });
      if (!ready) continue;
      dispatchSlots -= 1;
      actions.push({ type: 'dispatch', taskId: task.id, goalId: goal.id });
    }
  }
  return actions;
}
