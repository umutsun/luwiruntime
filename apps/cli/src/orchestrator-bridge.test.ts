import type {
  AutopilotPolicy,
  AutopilotStatusResponse,
  Goal,
  GoalPlanRequest,
  GoalTransitionRequest,
  SessionView,
  Task,
  TaskDispatchResponse,
  TaskVerdictRequest,
} from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BrainAdapter } from './brain-adapter.js';
import { createOrchestratorBridge, type OrchestratorDaemonClient } from './orchestrator-bridge.js';

const nowMs = Date.parse('2026-09-17T10:00:00.000Z');
const nowIso = new Date(nowMs).toISOString();

const policy: AutopilotPolicy = {
  coordinatorAgentId: 'luwibot',
  workerAgentIds: ['claude-code'],
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
    title: 'Ship',
    objective: 'Ship it.',
    acceptanceCriteria: ['tests pass'],
    createdBy: { kind: 'operator' },
    budget: policy.goalDefaults,
    state: 'planning',
    planVersion: 0,
    taskIds: [],
    usage: {
      tasks: 0,
      reworks: 0,
      replans: 0,
      judgments: 0,
      invalidJudgments: 0,
      startedAt: nowIso,
    },
    version: 2,
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

/** A scripted brain: answers in order, then repeats the last answer. */
function brain(answers: string[]): BrainAdapter & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: 'fake',
    prompts,
    judge: async (prompt) => {
      prompts.push(prompt);
      const text = answers.length > 1 ? (answers.shift() as string) : (answers[0] ?? '');
      if (text === 'THROW') throw new Error('brain down');
      return { text, ms: 5 };
    },
  };
}

function daemon(state: {
  goals: Goal[];
  tasks: Task[];
  mode?: 'off' | 'supervised' | 'autopilot';
}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const status: AutopilotStatusResponse = {
    record: {
      projectId: 'project-1',
      mode: state.mode ?? 'autopilot',
      policy,
      version: 1,
      changedAt: nowIso,
    },
    coordinatorOnline: true,
    coordinatorSessionIds: ['coord-1'],
  };
  const client: OrchestratorDaemonClient = {
    getAutopilot: async () => status,
    listProjectAgentBindings: async () => [
      { agentId: 'claude-code', enabled: true },
      { agentId: 'luwibot', enabled: true },
    ],
    listGoals: async () => state.goals,
    listTasks: async () => state.tasks,
    listSessions: async () => [] as SessionView[],
    listLeases: async () => [],
    transitionGoal: vi.fn(async (goalId: string, request: GoalTransitionRequest) => {
      record('transitionGoal', goalId, request);
      return state.goals.find((candidate) => candidate.id === goalId) as Goal;
    }),
    submitPlan: vi.fn(async (goalId: string, request: GoalPlanRequest) => {
      record('submitPlan', goalId, request);
      return state.goals.find((candidate) => candidate.id === goalId) as Goal;
    }),
    dispatchTask: vi.fn(
      async (taskId: string, sessionId: string): Promise<TaskDispatchResponse> => {
        record('dispatchTask', taskId, sessionId);
        return {
          outcome: 'dispatched',
          task: task(taskId, { state: 'dispatched' }),
          correlationId: `corr-${taskId}`,
        };
      },
    ),
    recordVerdict: vi.fn(async (taskId: string, request: TaskVerdictRequest) => {
      record('recordVerdict', taskId, request);
      return task(taskId);
    }),
    createReviewTask: vi.fn(async (taskId: string) => {
      record('createReviewTask', taskId);
      return task(`review-${taskId}`, { kind: 'review', reviewOf: taskId });
    }),
    createReworkTask: vi.fn(async (taskId: string) => {
      record('createReworkTask', taskId);
      return task(`${taskId}-rework`, { reworkOf: taskId, reworkCount: 1 });
    }),
    claimInbox: vi.fn(async () => ({ items: [] })),
    setSessionStatus: vi.fn(async () => undefined),
  };
  return { client, calls };
}

function bridge(
  client: OrchestratorDaemonClient,
  adapter: BrainAdapter,
  report: Record<string, unknown>[] = [],
) {
  return createOrchestratorBridge({
    daemon: client,
    brain: adapter,
    projectId: 'project-1',
    currentSessionId: () => 'coord-1',
    bridgeInstanceId: 'orchestrator',
    claimBlockMs: 0,
    tickMs: 60_000,
    judgmentTimeoutMs: 1_000,
    now: () => nowMs,
    report: (line) => report.push(line),
  });
}

describe('orchestrator bridge', () => {
  it('plans a planning goal through the brain and submits the validated plan with a counted judgment', async () => {
    const plan = JSON.stringify({
      kind: 'plan',
      decision: {
        tasks: [
          {
            title: 'route',
            brief: 'Add the route.',
            agentId: 'claude-code',
            paths: ['src/a.ts'],
            dependsOn: [],
            evidenceRequirements: [],
          },
        ],
        rationale: 'one step',
        confidence: 0.9,
      },
    });
    const { client, calls } = daemon({ goals: [goal()], tasks: [] });
    const adapter = brain([plan]);
    await bridge(client, adapter).cycleOnce();
    expect(adapter.prompts).toHaveLength(1);
    expect(adapter.prompts[0]).toContain('LUWI autopilot judgment: plan.');
    expect(calls.map((call) => call.method)).toEqual(['transitionGoal', 'submitPlan']);
    expect(calls[0]?.args[1]).toMatchObject({
      transition: 'count_judgment',
      kind: 'plan',
      invalid: false,
      confidence: 0.9,
      brain: 'fake',
    });
    expect(calls[1]?.args[1]).toMatchObject({
      sessionId: 'coord-1',
      tasks: [{ title: 'route' }],
      confidence: 0.9,
    });
  });

  it('bounds the judgment context by what the brain says it can take', async () => {
    // A native brain gets its prompt on the command line; an unbounded context
    // made every summarize of a large goal fail to start at all.
    const { client } = daemon({ goals: [goal({ objective: 'x'.repeat(10_000) })], tasks: [] });
    const adapter = { ...brain(['not json']), maxContextBytes: 4_000 };
    await bridge(client, adapter).cycleOnce();
    const context = adapter.prompts[0]?.split('CONTEXT:\n\n')[1] ?? '';
    expect(context.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(4_000);
  });

  it('sends an invalid answer back once with the refusals, then escalates brain_invalid', async () => {
    const { client, calls } = daemon({ goals: [goal()], tasks: [] });
    const adapter = brain([
      'not json at all',
      '{"tasks":[{"title":"x","brief":"x","agentId":"gemini-cli"}],"confidence":0.9}',
    ]);
    await bridge(client, adapter).cycleOnce();
    expect(adapter.prompts).toHaveLength(2);
    expect(adapter.prompts[1]).toContain('previousAnswerRefused');
    const transitions = calls
      .filter((call) => call.method === 'transitionGoal')
      .map((call) => call.args[1] as GoalTransitionRequest);
    expect(transitions.map((request) => request.transition)).toEqual([
      'count_judgment',
      'count_judgment',
      'escalate',
    ]);
    expect(transitions[2]).toMatchObject({
      transition: 'escalate',
      escalation: { reason: 'brain_invalid' },
    });
    expect(calls.some((call) => call.method === 'submitPlan')).toBe(false);
  });

  it("never applies a decision under the goal's confidence floor", async () => {
    const plan = JSON.stringify({
      tasks: [
        {
          title: 'r',
          brief: 'r',
          agentId: 'claude-code',
          paths: [],
          dependsOn: [],
          evidenceRequirements: [],
        },
      ],
      rationale: 'unsure',
      confidence: 0.3,
    });
    const { client, calls } = daemon({ goals: [goal()], tasks: [] });
    await bridge(client, brain([plan])).cycleOnce();
    expect(calls.map((call) => call.method)).toEqual(['transitionGoal', 'transitionGoal']);
    expect(calls[1]?.args[1]).toMatchObject({
      transition: 'escalate',
      escalation: { reason: 'low_confidence' },
    });
  });

  it('dispatches ready tasks of a running goal without asking the brain', async () => {
    const { client, calls } = daemon({
      goals: [goal({ state: 'running', taskIds: ['t1', 't2'] })],
      tasks: [task('t1'), task('t2')],
    });
    const adapter = brain(['{}']);
    await bridge(client, adapter).cycleOnce();
    expect(adapter.prompts).toHaveLength(0);
    expect(calls.map((call) => call.method)).toEqual(['dispatchTask', 'dispatchTask']);
  });

  it("reviews a completed task with the reviewer's answer in context and records the verdict", async () => {
    const done = task('t1', {
      state: 'done',
      verification: { checks: [], reviewTaskId: 'r1' },
      outcome: {
        messageState: 'responded',
        status: 'answered',
        answer: 'did it',
        evidenceCount: 0,
        evidenceTypes: [],
      },
    });
    const review = task('r1', {
      kind: 'review',
      reviewOf: 't1',
      state: 'done',
      verification: { checks: [] },
      outcome: {
        messageState: 'responded',
        status: 'answered',
        answer: 'looks right',
        evidenceCount: 0,
        evidenceTypes: [],
      },
    });
    const { client, calls } = daemon({
      goals: [goal({ state: 'running', taskIds: ['t1'] })],
      tasks: [done, review],
    });
    const adapter = brain(['{"verdict":"accept","feedback":"good","confidence":0.8}']);
    await bridge(client, adapter).cycleOnce();
    expect(adapter.prompts[0]).toContain('reviewerAnswer');
    expect(calls.map((call) => call.method)).toEqual(['transitionGoal', 'recordVerdict']);
    expect(calls[1]?.args[1]).toMatchObject({
      verdict: 'accept',
      feedback: 'good',
      confidence: 0.8,
    });
  });

  it('escalates brain_unavailable after three consecutive brain failures, not before', async () => {
    const { client, calls } = daemon({ goals: [goal()], tasks: [] });
    const orchestrator = bridge(client, brain(['THROW']));
    await orchestrator.cycleOnce();
    await orchestrator.cycleOnce();
    expect(calls).toHaveLength(0);
    await orchestrator.cycleOnce();
    expect(calls[0]?.args[1]).toMatchObject({
      transition: 'escalate',
      escalation: { reason: 'brain_unavailable' },
    });
  });

  it('lets the brain give up on a replan, and summarizes an ended goal', async () => {
    const failed = task('t1', { state: 'failed' });
    const { client, calls } = daemon({
      goals: [goal({ state: 'running', taskIds: ['t1'] })],
      tasks: [failed],
    });
    await bridge(
      client,
      brain(['{"keep":[],"add":[],"giveUp":"not achievable","rationale":"x","confidence":0.9}']),
    ).cycleOnce();
    expect(calls[1]?.args[1]).toMatchObject({ transition: 'fail', reason: 'not achievable' });

    const ended = daemon({ goals: [goal({ state: 'achieved', terminalAt: nowIso })], tasks: [] });
    await bridge(
      ended.client,
      brain(['{"summary":"went fine","workerNotes":{"claude-code":"reliable"}}']),
    ).cycleOnce();
    expect(ended.calls[1]?.args[1]).toMatchObject({
      transition: 'retrospective',
      retrospective: { summary: 'went fine' },
    });
  });

  it('idles while autopilot is off and sets its session idle on the first poll', async () => {
    const report: Record<string, unknown>[] = [];
    const { client, calls } = daemon({ goals: [goal()], tasks: [], mode: 'off' });
    const adapter = brain(['{}']);
    const orchestrator = bridge(client, adapter, report);
    expect(await orchestrator.pollOnce()).toBe(0);
    expect(client.setSessionStatus).toHaveBeenCalledWith('coord-1', 'idle');
    expect(adapter.prompts).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
