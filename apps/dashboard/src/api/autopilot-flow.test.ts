import { describe, expect, it, vi } from 'vitest';

import { createDaemonClient } from './client.js';
import { loadAutopilotFlow } from './autopilot-flow.js';

const AT = '2026-09-20T00:00:00.000Z';

// A minimal goal that satisfies `goalCollectionSchema` (budget is all-defaults, so `{}`).
const goal = (over: Record<string, unknown>) => ({
  id: 'g',
  projectId: 'p1',
  title: 'T',
  objective: 'O',
  acceptanceCriteria: [],
  createdBy: { kind: 'operator' },
  budget: {},
  state: 'running',
  planVersion: 1,
  taskIds: [],
  usage: { tasks: 0, reworks: 0, replans: 0, judgments: 0, invalidJudgments: 0 },
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A minimal task that satisfies `taskCollectionSchema`.
const task = (over: Record<string, unknown>) => ({
  id: 't',
  projectId: 'p1',
  goalId: 'g1',
  title: 'Task',
  brief: 'Do it.',
  agentId: 'claude-code',
  paths: [],
  matchPaths: [''],
  dependsOn: [],
  evidenceRequirements: [],
  timeoutMs: 600_000,
  kind: 'work',
  reworkCount: 0,
  state: 'done',
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

describe('loadAutopilotFlow tasks outside the plan', () => {
  it('lists a runtime-created review task after the plan, so its approval gate is visible', async () => {
    // Live 2026-09-24: the review task a supervised goal was waiting on was not in
    // `goal.taskIds`, so the cockpit never showed it and nobody could approve it.
    const goals = { goals: [goal({ id: 'g1', taskIds: ['w1'] })], truncated: false };
    const tasks = {
      tasks: [
        task({
          id: 'r1',
          kind: 'review',
          reviewOf: 'w1',
          title: 'Review: Task',
          agentId: 'albanoosh-claude-reviewer',
          state: 'awaiting_approval',
          gate: 'supervised',
          createdAt: '2026-09-20T00:05:00.000Z',
        }),
        task({ id: 'w1' }),
        task({ id: 'x1', goalId: 'other-goal' }),
      ],
      truncated: false,
    };
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(jsonResponse(String(url).includes('/tasks') ? tasks : goals)),
    );
    const result = await loadAutopilotFlow(
      createDaemonClient(fetchImpl as unknown as typeof fetch),
      'p1',
    );
    expect(result.state).toBe('ready');
    const flowTasks = result.state === 'ready' ? result.data.goals[0]?.tasks : [];
    expect(flowTasks?.map((t) => [t.id, t.state])).toEqual([
      ['w1', 'done'],
      ['r1', 'awaiting_approval'],
    ]);
  });
});

describe('loadAutopilotFlow', () => {
  it('surfaces the blocked question, omits it without escalation, and drops terminal goals', async () => {
    const goals = {
      goals: [
        goal({
          id: 'g1',
          state: 'blocked',
          escalation: { reason: 'plan_rejected', question: 'Which API?', askedAt: AT },
        }),
        goal({ id: 'g2', state: 'running' }),
        goal({ id: 'g3', state: 'achieved' }),
      ],
      truncated: false,
    };
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        jsonResponse(String(url).includes('/tasks') ? { tasks: [], truncated: false } : goals),
      ),
    );
    const client = createDaemonClient(fetchImpl as unknown as typeof fetch);

    const result = await loadAutopilotFlow(client, 'p1');

    expect(result).toEqual({
      state: 'ready',
      data: {
        goals: [
          {
            id: 'g1',
            title: 'T',
            objective: 'O',
            acceptanceCriteria: [],
            state: 'blocked',
            tasks: [],
            question: 'Which API?',
          },
          {
            id: 'g2',
            title: 'T',
            objective: 'O',
            acceptanceCriteria: [],
            state: 'running',
            tasks: [],
          },
        ],
        more: 0,
      },
    });
  });
});

describe('loadAutopilotFlow refused dispatch', () => {
  it('carries the last refused dispatch on the task, and nothing when there was none', async () => {
    // Live 2026-09-25: a review blocked 50 min on a lease overlap looked idle in the cockpit.
    const goals = { goals: [goal({ id: 'g1', taskIds: ['w1', 'w2'] })], truncated: false };
    const lastDenial = { reason: 'lease_overlap', detail: 'src/a.ts is held by s9', at: AT };
    const tasks = {
      tasks: [task({ id: 'w1', state: 'ready', lastDenial }), task({ id: 'w2', state: 'ready' })],
      truncated: false,
    };
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(jsonResponse(String(url).includes('/tasks') ? tasks : goals)),
    );
    const result = await loadAutopilotFlow(
      createDaemonClient(fetchImpl as unknown as typeof fetch),
      'p1',
    );
    const flowTasks = result.state === 'ready' ? result.data.goals[0]?.tasks : [];
    expect(flowTasks?.[0]?.lastDenial).toEqual({
      reason: 'lease_overlap',
      detail: 'src/a.ts is held by s9',
      at: AT,
    });
    expect(flowTasks?.[1]).not.toHaveProperty('lastDenial');
  });

  it('drops a refusal older than the task’s approval, dispatch or requeue, and keeps a newer one', async () => {
    // The daemon never clears `lastDenial`, so an old refusal read as the current reason.
    const LATER = '2026-09-20T00:05:00.000Z';
    const lastDenial = { reason: 'lease_overlap', detail: 'src/a.ts is held by s9', at: AT };
    const goals = {
      goals: [goal({ id: 'g1', taskIds: ['a1', 'd1', 'q1', 'n1'] })],
      truncated: false,
    };
    const tasks = {
      tasks: [
        task({
          id: 'a1',
          state: 'approved',
          lastDenial,
          approval: { decision: 'approved', at: LATER, by: 'operator' },
        }),
        task({ id: 'd1', state: 'ready', lastDenial, dispatchedAt: LATER }),
        task({
          id: 'q1',
          state: 'ready',
          lastDenial,
          lastRedispatch: { at: LATER, reason: 'target_session_lost' },
        }),
        task({
          id: 'n1',
          state: 'approved',
          lastDenial: { ...lastDenial, at: LATER },
          approval: { decision: 'approved', at: AT, by: 'operator' },
        }),
      ],
      truncated: false,
    };
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(jsonResponse(String(url).includes('/tasks') ? tasks : goals)),
    );
    const result = await loadAutopilotFlow(
      createDaemonClient(fetchImpl as unknown as typeof fetch),
      'p1',
    );
    const flowTasks = result.state === 'ready' ? (result.data.goals[0]?.tasks ?? []) : [];
    expect(flowTasks.map((flowTask) => [flowTask.id, flowTask.lastDenial?.at])).toEqual([
      ['a1', undefined],
      ['d1', undefined],
      ['q1', undefined],
      ['n1', LATER],
    ]);
  });
});
