import type { Goal, GoalEscalation, Task } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { applyGoalTransition, type GoalTransition } from './goal-state.js';
import { planCycle } from './orchestrator-cycle.js';

const startedAt = '2026-09-17T06:00:00.000Z';
const now = '2026-09-17T10:30:00.000Z';
const later = (minutes: number): string =>
  new Date(Date.parse(now) + minutes * 60_000).toISOString();

function goalWith(overrides: Partial<Goal>, usage: Partial<Goal['usage']> = {}): Goal {
  return {
    id: 'goal-1',
    projectId: 'project-1',
    title: 'Ship the thing',
    objective: 'Ship it.',
    acceptanceCriteria: [],
    createdBy: { kind: 'operator' },
    budget: {
      maxTasks: 12,
      maxReworksPerTask: 1,
      maxReplans: 2,
      maxWallClockMs: 14_400_000,
      minConfidence: 0.6,
    },
    state: 'running',
    planVersion: 1,
    taskIds: ['t1'],
    usage: {
      tasks: 1,
      reworks: 0,
      replans: 0,
      judgments: 1,
      invalidJudgments: 0,
      startedAt,
      ...usage,
    },
    version: 5,
    createdAt: startedAt,
    updatedAt: now,
    ...overrides,
  };
}

function blocked(
  reason: GoalEscalation['reason'],
  overrides: { askedAt?: string; replans?: number; maxReplans?: number } = {},
): Goal {
  const goal = goalWith(
    {
      state: 'blocked',
      escalation: { reason, question: 'Extend or abandon?', askedAt: overrides.askedAt ?? now },
    },
    { replans: overrides.replans ?? 0 },
  );
  return { ...goal, budget: { ...goal.budget, maxReplans: overrides.maxReplans ?? 2 } };
}

function move(goal: Goal, transition: GoalTransition, at = now): Goal {
  const result = applyGoalTransition(goal, transition, at);
  if (result.status !== 'ok') throw new Error(`${transition.kind}: ${result.reason}`);
  return result.goal;
}

function cycle(goal: Goal, at: string, tasks: Task[] = []) {
  return planCycle({
    nowMs: Date.parse(at),
    mode: 'supervised',
    policy: {
      coordinatorAgentId: 'luwibot',
      workerAgentIds: ['claude-code'],
      reviewerAgentId: 'codex',
      operatorProxyAgentIds: [],
      protectedPaths: [],
      maxInFlight: 2,
      maxDispatchesPerHour: 20,
      defaultTaskTimeoutMs: 600_000,
      maxJudgmentsPerHour: 30,
      maxConcurrentGoals: 1,
      goalDefaults: goal.budget,
      retrospectives: 5,
    },
    goals: [goal],
    tasks,
    judgmentsInWindow: 0,
  });
}

function task(id: string, state: Task['state']): Task {
  return {
    id,
    projectId: 'project-1',
    goalId: 'goal-1',
    title: id,
    brief: 'Do it.',
    agentId: 'claude-code',
    paths: [id],
    matchPaths: [`${id}/`],
    dependsOn: [],
    evidenceRequirements: [],
    timeoutMs: 600_000,
    kind: 'work',
    reworkCount: 0,
    state,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const answer = { kind: 'answer', text: 'Extend.', by: 'operator' } as const;
const exhausted = expect.objectContaining({ reason: 'budget_exhausted' });

describe('answering a blocked goal', () => {
  it('restarts the wall clock when the block was the wall-clock budget, and changes nothing else', () => {
    const goal = blocked('budget_exhausted', { askedAt: '2026-09-17T10:05:00.000Z' });
    const result = applyGoalTransition(goal, answer, now);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.goal).toEqual({
      ...goal,
      state: 'running',
      escalation: undefined,
      answer: { text: 'Extend.', at: now, by: 'operator' },
      usage: { ...goal.usage, startedAt: now },
      version: 6,
      updatedAt: now,
    });
    // Without the restart the next cycle sees the same overrun and blocks the goal again at once.
    expect(cycle(result.goal, later(1))).not.toContainEqual(exhausted);
  });

  it('restarts the wall clock on any answer: the operator acted', () => {
    // 3 h 55 min of work, then a low-confidence block the operator answers 35 min later.
    const goal = move(blocked('low_confidence', { askedAt: '2026-09-17T09:55:00.000Z' }), answer);
    expect(goal.usage.startedAt).toBe(now);
    expect(goal.budget.maxReplans).toBe(2);
    expect(cycle(goal, later(6), [task('t1', 'dispatched')])).not.toContainEqual(exhausted);
  });

  it('allows one more replan when the block was the replan budget', () => {
    const goal = move(blocked('budget_exhausted', { replans: 2, maxReplans: 2 }), answer);
    expect(goal.budget.maxReplans).toBe(3);
    expect(goal.usage.replans).toBe(2);
  });

  it('leaves one replan when any answer to a running goal would otherwise re-block on the replan budget', () => {
    const result = applyGoalTransition(blocked('review_escalated', { replans: 2 }), answer, now);
    expect(result).toMatchObject({ status: 'ok', goal: { state: 'running' } });
    if (result.status !== 'ok') return;
    expect(result.goal.budget.maxReplans).toBe(3);
  });

  it('refuses the answer when the replan budget is at its ceiling', () => {
    for (const [replans, maxReplans] of [
      [8, 8],
      [8, 7], // a plan rejected over a budget of 7 would need 9
    ] as const) {
      expect(
        applyGoalTransition(blocked('budget_exhausted', { replans, maxReplans }), answer, now),
      ).toMatchObject({
        status: 'invalid',
        transition: 'answer',
        reason: expect.stringContaining('ceiling'),
      });
    }
  });
});

describe('a plan decision is an operator act', () => {
  it('restarts the wall clock when the plan is rejected after a long review', () => {
    // 4 h 06 min since the start, most of it the plan waiting on the operator.
    const review = goalWith({ state: 'plan_review' }, { startedAt: '2026-09-17T06:24:00.000Z' });
    const planning = move(review, { kind: 'plan_rejected', note: 'Smaller.', by: 'operator' });
    expect(planning.usage.startedAt).toBe(now);
    expect(cycle(planning, later(1))).toEqual([{ type: 'judge', kind: 'plan', goalId: 'goal-1' }]);
  });

  it('leaves one real replan after a rejection over the replan budget is answered', () => {
    const review = goalWith({ state: 'plan_review' }, { replans: 2 });
    const over = move(review, { kind: 'plan_rejected', by: 'operator' });
    expect(over).toMatchObject({ state: 'blocked', usage: { replans: 3, startedAt: now } });

    const planning = move(over, answer, later(1));
    expect(planning).toMatchObject({
      state: 'planning',
      budget: { maxReplans: 4 },
      usage: { startedAt: later(1) },
    });
    expect(cycle(planning, later(2))).toEqual([{ type: 'judge', kind: 'plan', goalId: 'goal-1' }]);

    // The plan judgment carried the answer, so the plan consumes it.
    const planned = move(planning, { kind: 'plan', taskIds: ['t2'], needsReview: true }, later(3));
    expect(planned.answer).toBeUndefined();
    const running = move(planned, { kind: 'plan_approved' }, later(4));
    expect(running.usage.startedAt).toBe(later(4));
    expect(cycle(running, later(5), [task('t2', 'approved')])).toEqual([
      { type: 'dispatch', taskId: 't2', goalId: 'goal-1' },
    ]);

    expect(cycle(running, later(6), [task('t2', 'failed')])).toEqual([
      { type: 'judge', kind: 'replan', goalId: 'goal-1' },
    ]);
    expect(
      move(running, { kind: 'replan', taskIds: ['t3'], needsReview: false }, later(7)).usage
        .replans,
    ).toBe(4);
  });
});
