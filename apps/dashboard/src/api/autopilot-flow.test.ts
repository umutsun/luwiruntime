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
            state: 'blocked',
            tasks: [],
            question: 'Which API?',
          },
          { id: 'g2', title: 'T', objective: 'O', state: 'running', tasks: [] },
        ],
        more: 0,
      },
    });
  });
});
