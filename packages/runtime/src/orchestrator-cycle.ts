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

/** Review tasks a work task may burn through before a failed review is the operator's call. */
const REVIEW_ATTEMPTS = 2;

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

    // The wall clock runs from the start or the operator's last act on the goal (an answer, a
    // plan decision — goal-state resets startedAt — or a task approval or rejection), and stops
    // while a task the current plan can still use — one in taskIds, or a review of one — awaits
    // the operator's gate. A gated review of work a replan dropped serves no plan and stops nothing.
    // ponytail: while one task waits at the gate, parallel work of the same goal is unchecked
    // until the operator acts, bounded only by each task's own timeout.
    const goalTasks = state.tasks.filter((task) => task.goalId === goal.id);
    const inPlan = (id: string | undefined): boolean =>
      id !== undefined && goal.taskIds.includes(id);
    const clockStartMs =
      goal.usage.startedAt === undefined
        ? undefined
        : Math.max(
            Date.parse(goal.usage.startedAt),
            ...goalTasks.map((task) =>
              task.approval === undefined ? 0 : Date.parse(task.approval.at),
            ),
          );
    if (
      clockStartMs !== undefined &&
      !goalTasks.some(
        (task) => task.state === 'awaiting_approval' && (inPlan(task.id) || inPlan(task.reviewOf)),
      ) &&
      state.nowMs - clockStartMs > goal.budget.maxWallClockMs
    ) {
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
      const reviewable =
        needsVerdict.kind === 'work' &&
        state.policy.reviewerAgentId !== undefined &&
        state.policy.reviewerAgentId !== needsVerdict.agentId;
      if (reviewTaskId === undefined && reviewable) {
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
      // A failed review is not a verdict on the work — judging it would let the brain accept the
      // goal on deterministic checks alone, with the second pair of eyes silently gone (measured
      // live: a codex reviewer out of usage, and one that exited in 2 s on "unexpected argument"
      // before a goal whose code did not compile was accepted). Retry it once with a fresh review
      // task, then park it for the operator. An answer cannot retry: it replans, and a replan
      // keeps no done-but-unverdicted task, so the question says so. A usage limit parks at once.
      if (reviewTask !== undefined && reviewTask.state === 'failed') {
        const answer = reviewTask.outcome?.answer ?? '';
        const usageLimit = answer.startsWith('AGENT_USAGE_LIMIT:');
        const failedReviews = state.tasks.filter(
          (task) =>
            task.kind === 'review' && task.reviewOf === needsVerdict.id && task.state === 'failed',
        ).length;
        if (!usageLimit && reviewable && failedReviews < REVIEW_ATTEMPTS) {
          actions.push({ type: 'create_review_task', taskId: needsVerdict.id, goalId: goal.id });
          continue;
        }
        // A bridge-failed answer leads with a generic "exited (code N)" line; the real cause is
        // the first line of the native output tail. No marker: indexOf's -1 + 1 reads from line 0.
        const lines = answer.split('\n').map((line) => line.trim());
        const from = usageLimit ? 0 : lines.indexOf('[native output tail]') + 1;
        const cause = (lines.slice(from).find((line) => line !== '') ?? 'no reason given').slice(
          0,
          300,
        );
        const reviewer = reviewTask.agentId ?? state.policy.reviewerAgentId ?? 'unassigned';
        const failure = usageLimit
          ? `is out of usage and cannot verify task "${needsVerdict.title}"`
          : `failed to verify task "${needsVerdict.title}" ${String(failedReviews)} time(s)`;
        actions.push({
          type: 'escalate',
          goalId: goal.id,
          reason: 'worker_unavailable',
          taskId: needsVerdict.id,
          question: `The reviewer (${reviewer}) ${failure}: ${cause}. Answering replans the goal without this review; abandon the goal to stop.`,
        });
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
