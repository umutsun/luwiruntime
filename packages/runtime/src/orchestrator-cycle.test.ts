import type { AutopilotPolicy, Goal, Task } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { planCycle, type CycleState } from './orchestrator-cycle.js';

const nowMs = Date.parse('2026-09-17T10:00:00.000Z');
const nowIso = new Date(nowMs).toISOString();

const policy: AutopilotPolicy = {
  coordinatorAgentId: 'luwibot',
  workerAgentIds: ['claude-code', 'codex'],
  reviewerAgentId: 'codex',
  operatorProxyAgentIds: [],
  protectedPaths: [],
  maxInFlight: 2,
  maxDispatchesPerHour: 20,
  defaultTaskTimeoutMs: 600_000,
  maxJudgmentsPerHour: 30,
  maxConcurrentGoals: 1,
  goalDefaults: {
    maxTasks: 12,
    maxReworksPerTask: 1,
    maxReplans: 2,
    maxWallClockMs: 14_400_000,
    minConfidence: 0.6,
  },
  retrospectives: 5,
};

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    projectId: 'project-1',
    title: 'Ship the thing',
    objective: 'Ship it.',
    acceptanceCriteria: [],
    createdBy: { kind: 'operator' },
    budget: policy.goalDefaults,
    state: 'running',
    planVersion: 1,
    taskIds: ['t1', 't2'],
    usage: {
      tasks: 2,
      reworks: 0,
      replans: 0,
      judgments: 1,
      invalidJudgments: 0,
      startedAt: nowIso,
    },
    version: 3,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
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
    state: 'ready',
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

const accepted = (id: string, overrides: Partial<Task> = {}): Task =>
  task(id, { state: 'done', verification: { checks: [], verdict: 'accept' }, ...overrides });

function state(overrides: Partial<CycleState> = {}): CycleState {
  return {
    nowMs,
    mode: 'autopilot',
    policy,
    goals: [goal()],
    tasks: [task('t1'), task('t2')],
    judgmentsInWindow: 0,
    ...overrides,
  };
}

describe('planCycle', () => {
  it('does nothing while autopilot is off', () => {
    expect(planCycle(state({ mode: 'off' }))).toEqual([]);
  });

  it('starts the oldest proposed goal only while the concurrency budget allows it', () => {
    const older = goal({
      id: 'g-old',
      state: 'proposed',
      taskIds: [],
      createdAt: '2026-09-17T09:00:00.000Z',
    });
    const newer = goal({
      id: 'g-new',
      state: 'proposed',
      taskIds: [],
      createdAt: '2026-09-17T09:30:00.000Z',
    });
    expect(planCycle(state({ goals: [newer, older], tasks: [] }))).toEqual([
      { type: 'start_goal', goalId: 'g-old' },
    ]);
    expect(planCycle(state({ goals: [goal(), older], tasks: [] }))).not.toContainEqual({
      type: 'start_goal',
      goalId: 'g-old',
    });
  });

  it('asks for a plan when a goal is planning, and never more than one judgment per goal per cycle', () => {
    const actions = planCycle(
      state({ goals: [goal({ state: 'planning', taskIds: [] })], tasks: [] }),
    );
    expect(actions).toEqual([{ type: 'judge', kind: 'plan', goalId: 'goal-1' }]);
  });

  it('dispatches ready tasks in plan order within the in-flight limit and dependency order', () => {
    const tasks = [task('t1'), task('t2', { dependsOn: ['t1'] }), task('t3')];
    const actions = planCycle(state({ goals: [goal({ taskIds: ['t1', 't2', 't3'] })], tasks }));
    expect(actions).toEqual([
      { type: 'dispatch', taskId: 't1', goalId: 'goal-1' },
      { type: 'dispatch', taskId: 't3', goalId: 'goal-1' },
    ]);
  });

  it('creates a review task for a completed work task when a reviewer is configured, then judges', () => {
    const done = task('t1', { state: 'done', verification: { checks: [] } });
    expect(planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [done] }))).toEqual([
      { type: 'create_review_task', taskId: 't1', goalId: 'goal-1' },
    ]);
    const reviewing = { ...done, verification: { checks: [], reviewTaskId: 'r1' } };
    const review = task('r1', { kind: 'review', reviewOf: 't1', agentId: 'codex', state: 'ready' });
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [reviewing, review] })),
    ).toEqual([{ type: 'dispatch', taskId: 'r1', goalId: 'goal-1' }]);
    const reviewed = task('r1', {
      kind: 'review',
      reviewOf: 't1',
      agentId: 'codex',
      state: 'done',
      verification: { checks: [] },
    });
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [reviewing, reviewed] })),
    ).toEqual([{ type: 'judge', kind: 'review', goalId: 'goal-1', taskId: 't1' }]);
  });

  it('escalates instead of re-dispatching forever when the reviewer is unavailable', () => {
    const reviewing = task('t1', {
      state: 'done',
      verification: { checks: [], reviewTaskId: 'r1' },
    });
    const review = task('r1', {
      kind: 'review',
      reviewOf: 't1',
      agentId: 'codex',
      state: 'ready',
      lastDenial: {
        reason: 'worker_unavailable',
        detail: 'No online, ready session of codex in this project.',
        at: nowIso,
      },
    });
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [reviewing, review] })),
    ).toMatchObject([
      { type: 'escalate', goalId: 'goal-1', reason: 'worker_unavailable', taskId: 't1' },
    ]);
  });

  it('escalates instead of judging when the reviewer itself is out of usage', () => {
    const reviewing = task('t1', {
      state: 'done',
      verification: { checks: [], reviewTaskId: 'r1' },
    });
    const review = task('r1', {
      kind: 'review',
      reviewOf: 't1',
      agentId: 'codex',
      state: 'failed',
      outcome: {
        messageState: 'failed',
        status: 'failed',
        answer:
          'AGENT_USAGE_LIMIT: codex is out of usage until Sep 27th, 2026 11:48 AM — ERROR: usage limit hit.',
        evidenceCount: 0,
        evidenceTypes: [],
      },
    });
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [reviewing, review] })),
    ).toMatchObject([
      { type: 'escalate', goalId: 'goal-1', reason: 'worker_unavailable', taskId: 't1' },
    ]);
  });

  it('still judges a review task that failed for an unrelated reason', () => {
    const reviewing = task('t1', {
      state: 'done',
      verification: { checks: [], reviewTaskId: 'r1' },
    });
    const review = task('r1', {
      kind: 'review',
      reviewOf: 't1',
      agentId: 'codex',
      state: 'failed',
      outcome: {
        messageState: 'failed',
        evidenceCount: 0,
        evidenceTypes: [],
        answer: 'The reviewer crashed on an unrelated error.',
      },
    });
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [reviewing, review] })),
    ).toEqual([{ type: 'judge', kind: 'review', goalId: 'goal-1', taskId: 't1' }]);
  });

  it('judges directly when no reviewer is configured', () => {
    const done = task('t1', { state: 'done', verification: { checks: [] } });
    expect(
      planCycle(
        state({
          policy: { ...policy, reviewerAgentId: undefined },
          goals: [goal({ taskIds: ['t1'] })],
          tasks: [done],
        }),
      ),
    ).toEqual([{ type: 'judge', kind: 'review', goalId: 'goal-1', taskId: 't1' }]);
  });

  it('reworks once, then escalates on the rework limit', () => {
    const rework = task('t1', {
      state: 'done',
      verification: { checks: [], verdict: 'rework', feedback: 'tests' },
    });
    expect(planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [rework] }))).toEqual([
      { type: 'rework', taskId: 't1', goalId: 'goal-1' },
    ]);
    const exhausted = { ...rework, reworkCount: 1 };
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [exhausted] })),
    ).toMatchObject([{ type: 'escalate', goalId: 'goal-1', reason: 'rework_limit', taskId: 't1' }]);
    const followUp = task('t1b', { reworkOf: 't1' });
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1', 't1b'] })], tasks: [rework, followUp] })),
    ).toEqual([{ type: 'dispatch', taskId: 't1b', goalId: 'goal-1' }]);
  });

  it('escalates a review that asked for a human, and never accepts it automatically', () => {
    const escalated = task('t1', {
      state: 'done',
      verification: { checks: [], verdict: 'escalate', feedback: 'scope?' },
    });
    expect(
      planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [escalated] })),
    ).toMatchObject([{ type: 'escalate', reason: 'review_escalated', taskId: 't1' }]);
  });

  it('replans after a failed task while the replan budget lasts, then escalates', () => {
    const failed = task('t1', { state: 'failed' });
    expect(planCycle(state({ goals: [goal({ taskIds: ['t1'] })], tasks: [failed] }))).toEqual([
      { type: 'judge', kind: 'replan', goalId: 'goal-1' },
    ]);
    const spent = goal({
      taskIds: ['t1'],
      usage: {
        tasks: 1,
        reworks: 0,
        replans: 2,
        judgments: 3,
        invalidJudgments: 0,
        startedAt: nowIso,
      },
    });
    expect(planCycle(state({ goals: [spent], tasks: [failed] }))).toMatchObject([
      { type: 'escalate', reason: 'budget_exhausted', taskId: 't1' },
    ]);
  });

  it('replans when the operator answered', () => {
    const answered = goal({ answer: { text: 'use the other module', at: nowIso, by: 'operator' } });
    expect(planCycle(state({ goals: [answered] }))).toEqual([
      { type: 'judge', kind: 'replan', goalId: 'goal-1' },
    ]);
  });

  it('achieves when every task is accepted or cancelled, fails when all are over and none accepted', () => {
    expect(
      planCycle(state({ tasks: [accepted('t1'), task('t2', { state: 'cancelled' })] })),
    ).toEqual([{ type: 'achieve', goalId: 'goal-1' }]);
    expect(
      planCycle(
        state({ tasks: [task('t1', { state: 'cancelled' }), task('t2', { state: 'cancelled' })] }),
      ),
    ).toMatchObject([{ type: 'fail', goalId: 'goal-1' }]);
  });

  it('escalates when the wall-clock budget is spent', () => {
    const old = goal({
      usage: {
        tasks: 2,
        reworks: 0,
        replans: 0,
        judgments: 1,
        invalidJudgments: 0,
        startedAt: '2026-09-16T10:00:00.000Z',
      },
    });
    expect(planCycle(state({ goals: [old] }))).toMatchObject([
      { type: 'escalate', reason: 'budget_exhausted' },
    ]);
  });

  it('summarizes an ended goal without a retrospective, and respects the hourly judgment cap', () => {
    const ended = goal({ state: 'achieved', terminalAt: nowIso });
    expect(planCycle(state({ goals: [ended], tasks: [] }))).toEqual([
      { type: 'judge', kind: 'summarize', goalId: 'goal-1' },
    ]);
    expect(planCycle(state({ goals: [ended], tasks: [], judgmentsInWindow: 30 }))).toEqual([]);
  });

  it('waits in plan_review and blocked without acting', () => {
    expect(planCycle(state({ goals: [goal({ state: 'plan_review' })] }))).toEqual([]);
    expect(planCycle(state({ goals: [goal({ state: 'blocked' })] }))).toEqual([]);
  });
});
