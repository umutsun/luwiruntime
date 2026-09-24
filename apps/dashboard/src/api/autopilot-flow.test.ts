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
