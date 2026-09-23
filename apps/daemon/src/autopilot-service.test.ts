import type {
  AgentMessage,
  AutopilotPolicyInput,
  AutopilotRecord,
  Goal,
  Project,
  RuntimeEvent,
  SessionView,
  Task,
} from '@luwi/protocol';
import type { ActiveTaskEntry, AutopilotRepository } from '@luwi/redis';
import { ApplicationError } from '@luwi/runtime';
import { describe, expect, it, vi } from 'vitest';

import { createAutopilotService, type AutopilotService } from './autopilot-service.js';

const nowIso = '2026-09-17T10:00:00.000Z';
const project: Project = {
  id: 'project-1',
  name: 'Fixture',
  localPath: '/p',
  canonicalPath: '/p',
  createdAt: nowIso,
  updatedAt: nowIso,
};

function session(id: string, agentId: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    agentId,
    projectId: 'project-1',
    status: 'idle',
    presence: 'online',
    workingDirectory: '/p',
    startedAt: nowIso,
    lastHeartbeatAt: nowIso,
    metadata: {},
    ...overrides,
  };
}

/** An in-memory repository with the same compare-and-set rules the Functions enforce. */
function fakeRepository() {
  const records = new Map<string, AutopilotRecord>();
  const goals = new Map<string, Goal>();
  const tasks = new Map<string, Task>();
  const active = new Map<string, Map<string, ActiveTaskEntry>>();
  const dispatches = new Map<string, number[]>();
  const events: RuntimeEvent[] = [];
  const notices: { sessionId: string; kind: string }[] = [];
  const activeOf = (projectId: string) => {
    let entries = active.get(projectId);
    if (entries === undefined) {
      entries = new Map();
      active.set(projectId, entries);
    }
    return entries;
  };
  const cas = <Stored extends { version: number }>(
    store: Map<string, Stored>,
    id: string,
    record: Stored,
    expected: number,
  ) => {
    const current = store.get(id);
    if ((current?.version ?? 0) !== expected)
      return { status: 'version_conflict' as const, record: current ?? null };
    store.set(id, record);
    return { status: 'written' as const, record };
  };
  const repository: AutopilotRepository = {
    getAutopilot: async (projectId) => records.get(projectId) ?? null,
    listAutopilot: async () => [...records.values()],
    putAutopilot: async ({ record, event, expectedVersion }) => {
      const result = cas(records, record.projectId, record, expectedVersion);
      if (result.status === 'written') events.push(event);
      return result;
    },
    queueNotice: async ({ sessionId, notice, event }) => {
      notices.push({ sessionId, kind: notice.payload.kind });
      events.push(event);
      return { status: 'queued', streamId: '1-0' };
    },
    getGoal: async (goalId) => goals.get(goalId) ?? null,
    listProjectGoals: async (projectId) =>
      [...goals.values()].filter((goal) => goal.projectId === projectId),
    listRetrospectiveGoals: async (projectId) =>
      [...goals.values()].filter(
        (goal) => goal.projectId === projectId && goal.retrospective !== undefined,
      ),
    writeGoal: async ({ goal, event, expectedVersion }) => {
      const result = cas(goals, goal.id, goal, expectedVersion);
      if (result.status === 'written' && event !== null) events.push(event);
      return result;
    },
    getTask: async (taskId) => tasks.get(taskId) ?? null,
    listProjectTasks: async (projectId) =>
      [...tasks.values()].filter((task) => task.projectId === projectId),
    listGoalTasks: async (goalId) => [...tasks.values()].filter((task) => task.goalId === goalId),
    listActiveTasks: async (projectId) => [...activeOf(projectId).values()],
    recentDispatchesMs: async (projectId, sinceMs) =>
      (dispatches.get(projectId) ?? []).filter((at) => at >= sinceMs),
    writeTask: async ({ task, event, expectedVersion, active: entry }) => {
      const result = cas(tasks, task.id, task, expectedVersion);
      if (result.status === 'written') {
        if (event !== null) events.push(event);
        if (entry === null) activeOf(task.projectId).delete(task.id);
        else activeOf(task.projectId).set(task.id, entry);
      }
      return result;
    },
    dispatchTask: async ({
      task,
      expectedVersion,
      nowMs,
      maxInFlight,
      maxPerHour,
      active: entry,
    }) => {
      const current = tasks.get(task.id);
      if ((current?.version ?? 0) !== expectedVersion)
        return { status: 'version_conflict', task: current ?? null };
      const entries = activeOf(task.projectId);
      if (entries.size >= maxInFlight)
        return { status: 'denied', reason: 'in_flight_limit', detail: String(entries.size) };
      const recent = (dispatches.get(task.projectId) ?? []).filter(
        (at) => at > nowMs - 3_600_000,
      ).length;
      if (recent >= maxPerHour)
        return { status: 'denied', reason: 'rate_limit', detail: String(recent) };
      tasks.set(task.id, task);
      entries.set(task.id, entry);
      dispatches.set(task.projectId, [...(dispatches.get(task.projectId) ?? []), nowMs]);
      return { status: 'dispatching', task };
    },
  };
  return { repository, records, goals, tasks, events, notices, active, activeOf };
}

const policy: AutopilotPolicyInput = {
  coordinatorAgentId: 'luwibot',
  workerAgentIds: ['claude-code', 'codex'],
  reviewerAgentId: 'codex',
  operatorProxyAgentIds: ['luwibot-chat'],
  protectedPaths: ['AGENTS.md'],
  maxInFlight: 2,
  maxDispatchesPerHour: 20,
};

function harness(
  options: {
    sessions?: SessionView[];
    mode?: 'off' | 'supervised' | 'autopilot';
    commits?: { listGitCommits(projectId: string, limit?: number): Promise<{ sha: string }[]> };
    refreshGitObservation?: (projectId: string) => Promise<void>;
  } = {},
) {
  const fake = fakeRepository();
  const sessions = options.sessions ?? [
    session('coord-1', 'luwibot'),
    session('worker-1', 'claude-code', { metadata: { bridge: 'native-headless' } }),
    session('reviewer-1', 'codex', { metadata: { bridge: 'native-headless' } }),
    session('chat-1', 'luwibot-chat'),
  ];
  const askForTask = vi.fn(
    async (request: { sourceSessionId: string; targetAgentId?: string; subject?: string }) => ({
      message: {
        correlationId: `corr-${request.subject?.split(' ')[1]?.replace(':', '') ?? 'x'}`,
        targetSessionId: 'worker-1',
        sourceSessionId: request.sourceSessionId,
      } as AgentMessage,
      selectedTargetSessionId: 'worker-1',
      selectedTargetAgentId: request.targetAgentId ?? 'claude-code',
      selectionReason: 'test',
      idempotent: false,
    }),
  );
  const messages = {
    askForTask,
    get: vi.fn(async () => {
      throw new ApplicationError('MESSAGE_NOT_FOUND', 'no', 404);
    }),
    findByIdempotencyKey: vi.fn(async () => null),
  };
  const manifest = {
    readProjectAutopilotPolicy: vi.fn(async () => undefined),
    writeProjectAutopilotPolicy: vi.fn(async () => undefined),
  };
  const service: AutopilotService = createAutopilotService({
    repository: fake.repository,
    sessions: {
      get: async (id) => sessions.find((candidate) => candidate.id === id) ?? null,
      list: async () => sessions,
    },
    projects: { get: async (id) => (id === 'project-1' ? project : null) },
    messages: messages as never,
    bindings: {
      listProjectAgentBindings: async () =>
        ['luwibot', 'claude-code', 'codex', 'luwibot-chat'].map((agentId) => ({
          agentId,
          enabled: true,
        })),
    },
    leases: { list: async () => [] },
    commits: options.commits ?? { listGitCommits: async () => [{ sha: 'a'.repeat(40) }] },
    ...(options.refreshGitObservation === undefined
      ? {}
      : { refreshGitObservation: options.refreshGitObservation }),
    manifest,
    workspaceId: 'local',
    now: () => new Date(nowIso),
  });
  const configure = async (
    mode: 'off' | 'supervised' | 'autopilot' = options.mode ?? 'autopilot',
  ) => {
    await service.putPolicy('project-1', policy);
    if (mode !== 'off') await service.setMode('project-1', mode);
  };
  return { service, fake, messages, manifest, configure };
}

const eventTypes = (events: RuntimeEvent[]) => events.map((event) => event.type);

describe('autopilot policy and mode', () => {
  it('refuses a policy naming an agent that is not an enabled binding, and writes an accepted one to the manifest', async () => {
    const { service, manifest, fake } = harness();
    await expect(
      service.putPolicy('project-1', { ...policy, workerAgentIds: ['gemini-cli'] }),
    ).rejects.toMatchObject({
      code: 'AUTOPILOT_POLICY_INVALID',
    });
    const record = await service.putPolicy('project-1', policy);
    expect(record).toMatchObject({ mode: 'off', version: 1 });
    expect(manifest.writeProjectAutopilotPolicy).toHaveBeenCalledTimes(1);
    expect(eventTypes(fake.events)).toEqual(['autopilot.policy.updated']);
    // An unchanged policy is not rewritten.
    expect(await service.putPolicy('project-1', policy)).toMatchObject({ version: 1 });
  });

  it('refuses a mode without a policy, and wakes the coordinator when the mode changes', async () => {
    const { service, fake } = harness();
    await expect(service.setMode('project-1', 'autopilot')).rejects.toMatchObject({
      code: 'AUTOPILOT_NOT_CONFIGURED',
    });
    await service.putPolicy('project-1', policy);
    const changed = await service.setMode('project-1', 'supervised');
    expect(changed).toMatchObject({
      changed: true,
      coordinatorNotified: true,
      record: { mode: 'supervised', version: 2 },
    });
    expect(fake.notices).toEqual([{ sessionId: 'coord-1', kind: 'mode_changed' }]);
    expect(await service.setMode('project-1', 'supervised')).toMatchObject({
      changed: false,
      coordinatorNotified: false,
    });
  });

  it('reports no coordinator when none is online, and kick says so', async () => {
    const { service, fake } = harness({ sessions: [session('worker-1', 'claude-code')] });
    await service.putPolicy('project-1', policy);
    expect(await service.setMode('project-1', 'autopilot')).toMatchObject({
      coordinatorNotified: false,
    });
    expect(await service.kick('project-1')).toEqual({ coordinatorNotified: false });
    expect(fake.notices).toEqual([]);
  });
});

describe('goals, plans and dispatch', () => {
  it('creates a goal, takes a plan from the coordinator only, and gates it in supervised mode', async () => {
    const { service, fake, configure } = harness({ mode: 'supervised' });
    await configure();
    const goal = await service.createGoal('project-1', {
      title: 'Ship',
      objective: 'Ship it.',
      acceptanceCriteria: ['tests pass'],
    });
    expect(goal.state).toBe('proposed');
    expect(fake.notices.map((notice) => notice.kind)).toContain('goal_created');

    const started = await service.transitionGoal(goal.id, {
      transition: 'count_judgment',
      sessionId: 'coord-1',
      kind: 'plan',
      invalid: false,
    });
    expect(started.usage.judgments).toBe(1);
    const planning = {
      ...(await service.getGoal(goal.id)),
      state: 'planning' as const,
      version: 3,
    };
    fake.goals.set(goal.id, planning);

    await expect(
      service.submitPlan(goal.id, {
        sessionId: 'worker-1',
        tasks: [
          {
            title: 'a',
            brief: 'a',
            agentId: 'claude-code',
            paths: [],
            dependsOn: [],
            evidenceRequirements: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'AUTOPILOT_NOT_COORDINATOR' });
    await expect(
      service.submitPlan(goal.id, {
        sessionId: 'coord-1',
        tasks: [
          {
            title: 'a',
            brief: 'a',
            agentId: 'gemini-cli',
            paths: [],
            dependsOn: [],
            evidenceRequirements: [],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'GOAL_PLAN_INVALID' });

    const planned = await service.submitPlan(goal.id, {
      sessionId: 'coord-1',
      tasks: [
        {
          title: 'route',
          brief: 'Add the route.',
          agentId: 'claude-code',
          paths: ['apps/daemon/src/app.ts'],
          dependsOn: [],
          evidenceRequirements: ['git_commit'],
        },
        {
          title: 'test',
          brief: 'Test it.',
          agentId: 'codex',
          paths: ['apps/daemon/src/app.test.ts'],
          dependsOn: [0],
          evidenceRequirements: [],
        },
      ],
      rationale: 'two steps',
    });
    expect(planned).toMatchObject({ state: 'plan_review', planVersion: 1, usage: { tasks: 2 } });
    const [first, second] = planned.taskIds.map((id) => fake.tasks.get(id) as Task);
    expect(first).toMatchObject({
      state: 'ready',
      matchPaths: ['apps/daemon/src/app.ts/'],
      dependsOn: [],
    });
    expect(second?.dependsOn).toEqual([first?.id]);

    // In supervised mode a dispatch waits for the plan; approval approves every task at once.
    expect(await service.dispatchTask(first?.id as string, 'coord-1')).toMatchObject({
      outcome: 'denied',
      reason: 'task_state',
    });
    await expect(service.approvePlan(goal.id, 'worker-1')).rejects.toMatchObject({
      code: 'AUTOPILOT_NOT_OPERATOR',
    });
    const approved = await service.approvePlan(goal.id, 'chat-1', 'go');
    expect(approved.state).toBe('running');
    expect(fake.tasks.get(first?.id as string)).toMatchObject({
      state: 'approved',
      approval: { by: 'session:luwibot-chat:chat-1' },
    });
    expect(fake.notices.map((notice) => notice.kind)).toContain('plan_approved');
  });

  it('dispatches through the message path with an idempotency key, then completes from the terminal message', async () => {
    const { service, fake, messages, configure } = harness();
    await configure('autopilot');
    const goal = await service.createGoal('project-1', {
      title: 'Ship',
      objective: 'Ship it.',
      acceptanceCriteria: [],
    });
    fake.goals.set(goal.id, { ...goal, state: 'planning', version: 2 });
    const planned = await service.submitPlan(goal.id, {
      sessionId: 'coord-1',
      tasks: [
        {
          title: 'route',
          brief: 'Add the route.',
          agentId: 'claude-code',
          paths: ['src/a.ts'],
          dependsOn: [],
          evidenceRequirements: ['git_commit'],
        },
      ],
    });
    expect(planned.state).toBe('running');
    const taskId = planned.taskIds[0] as string;

    const dispatched = await service.dispatchTask(taskId, 'coord-1');
    expect(dispatched).toMatchObject({
      outcome: 'dispatched',
      task: { state: 'dispatched', dispatchSourceSessionId: 'coord-1' },
    });
    expect(messages.askForTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionId: 'coord-1',
        targetAgentId: 'claude-code',
        kind: 'instruction',
        evidenceRequirements: ['git_commit'],
      }),
      `task:${taskId}`,
    );
    expect([...(fake.active.get('project-1')?.values() ?? [])]).toMatchObject([
      { taskId, state: 'dispatched' },
    ]);
    expect(eventTypes(fake.events)).toContain('task.dispatched');

    const correlationId = (dispatched as { correlationId: string }).correlationId;
    const completed = await service.completeFromMessage({
      id: 'm1',
      correlationId,
      projectId: 'project-1',
      sourceSessionId: 'coord-1',
      sourceAgentId: 'luwibot',
      targetSessionId: 'worker-1',
      targetAgentId: 'claude-code',
      selectionReason: 'x',
      kind: 'instruction',
      content: 'x',
      state: 'responded',
      createdAt: nowIso,
      updatedAt: nowIso,
      deadlineAt: nowIso,
      response: {
        status: 'answered',
        answer: 'Added the route.',
        evidence: [{ type: 'git_commit', summary: 'commit', gitHead: 'a'.repeat(40) }],
        verifiedAt: nowIso,
      },
    });
    expect(completed).toMatchObject({
      state: 'done',
      outcome: { messageState: 'responded', status: 'answered', evidenceCount: 1 },
      verification: {
        checks: expect.arrayContaining([
          expect.objectContaining({ check: 'commit_evidence', passed: true }),
        ]),
      },
    });
    expect(fake.active.get('project-1')?.size).toBe(0);
    expect(fake.notices.map((notice) => notice.kind)).toContain('task_completed');

    // A review task goes to the reviewer, then the verdict lands on the original.
    const review = await service.createReviewTask(taskId, 'coord-1');
    expect(review).toMatchObject({
      kind: 'review',
      reviewOf: taskId,
      agentId: 'codex',
      state: 'ready',
    });
    expect(review.brief).toContain(
      'The work is committed in another worktree of the same repository. Check out the commit the worker cited as a detached HEAD in your own working directory before running any check.',
    );
    expect(review.brief).toContain(
      'If the worker cited no commit, or you cannot check it out, inspect the work read-only instead: `git worktree list` to find its worktree, then `git -C <that path> diff` for uncommitted changes, or `git show <sha>` for a commit.',
    );
    expect(fake.tasks.get(taskId)?.verification?.reviewTaskId).toBe(review.id);
    const judged = await service.recordVerdict(taskId, {
      sessionId: 'coord-1',
      verdict: 'rework',
      feedback: 'no test',
    });
    expect(judged.verification).toMatchObject({ verdict: 'rework', feedback: 'no test' });
    const rework = await service.createReworkTask(taskId, 'coord-1');
    expect(rework).toMatchObject({ reworkOf: taskId, reworkCount: 1, state: 'ready' });
    expect(fake.goals.get(goal.id)?.taskIds).toContain(rework.id);
    await expect(service.createReworkTask(taskId, 'coord-1')).resolves.toBeDefined();
  });

  it('refreshes the Git observation before verifying a commit, so a just-made commit is not missed', async () => {
    // The worker commits before it responds, but the periodic Git scan has not
    // caught up: the commit is invisible until a scan runs.
    let scanned = false;
    const refreshGitObservation = vi.fn(async () => {
      scanned = true;
    });
    const sha = 'b'.repeat(40);
    const { service, fake, configure } = harness({
      commits: { listGitCommits: async () => (scanned ? [{ sha }] : []) },
      refreshGitObservation,
    });
    await configure('autopilot');
    const goal = await service.createGoal('project-1', {
      title: 'Ship',
      objective: 'Ship it.',
      acceptanceCriteria: [],
    });
    fake.goals.set(goal.id, { ...goal, state: 'planning', version: 2 });
    const planned = await service.submitPlan(goal.id, {
      sessionId: 'coord-1',
      tasks: [
        {
          title: 'route',
          brief: 'Add the route.',
          agentId: 'claude-code',
          paths: ['src/a.ts'],
          dependsOn: [],
          evidenceRequirements: ['git_commit'],
        },
      ],
    });
    const taskId = planned.taskIds[0] as string;
    const dispatched = await service.dispatchTask(taskId, 'coord-1');
    const correlationId = (dispatched as { correlationId: string }).correlationId;
    const completed = await service.completeFromMessage({
      id: 'm1',
      correlationId,
      projectId: 'project-1',
      sourceSessionId: 'coord-1',
      sourceAgentId: 'luwibot',
      targetSessionId: 'worker-1',
      targetAgentId: 'claude-code',
      selectionReason: 'x',
      kind: 'instruction',
      content: 'x',
      state: 'responded',
      createdAt: nowIso,
      updatedAt: nowIso,
      deadlineAt: nowIso,
      response: {
        status: 'answered',
        answer: 'Committed.',
        evidence: [{ type: 'git_commit', summary: 'commit', gitHead: sha }],
        verifiedAt: nowIso,
      },
    });
    expect(refreshGitObservation).toHaveBeenCalledWith('project-1');
    expect(completed?.verification?.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'commit_evidence', passed: true })]),
    );
  });

  it('denies a dispatch with the evaluated reason and records the denial on the task', async () => {
    const { service, fake, configure } = harness({ sessions: [session('coord-1', 'luwibot')] });
    await configure('autopilot');
    const goal = await service.createGoal('project-1', {
      title: 'Ship',
      objective: 'Ship it.',
      acceptanceCriteria: [],
    });
    fake.goals.set(goal.id, { ...goal, state: 'planning', version: 2 });
    const planned = await service.submitPlan(goal.id, {
      sessionId: 'coord-1',
      tasks: [
        {
          title: 'route',
          brief: 'Add the route.',
          agentId: 'claude-code',
          paths: [],
          dependsOn: [],
          evidenceRequirements: [],
        },
      ],
    });
    const taskId = planned.taskIds[0] as string;
    // No path declared: the whole project, which overlaps the protected AGENTS.md → gated even in autopilot.
    expect(await service.dispatchTask(taskId, 'coord-1')).toMatchObject({
      outcome: 'gated',
      gate: 'protected_path',
    });
    const gated = fake.tasks.get(taskId) as Task;
    fake.tasks.set(taskId, { ...gated, state: 'approved', version: gated.version + 1 });
    // No worker session online → denied, with the reason on the record and in the event stream.
    expect(await service.dispatchTask(taskId, 'coord-1')).toMatchObject({
      outcome: 'denied',
      reason: 'worker_unavailable',
    });
    expect(fake.tasks.get(taskId)?.lastDenial).toMatchObject({ reason: 'worker_unavailable' });
    expect(eventTypes(fake.events)).toContain('task.dispatch.denied');
  });

  it('escalates, answers and abandons with the right actors, and repairs a dispatch through the idempotency index', async () => {
    const { service, fake, messages, configure } = harness();
    await configure('autopilot');
    const goal = await service.createGoal('project-1', {
      title: 'Ship',
      objective: 'Ship it.',
      acceptanceCriteria: [],
    });
    fake.goals.set(goal.id, { ...goal, state: 'running', version: 2, taskIds: ['t-x'] });
    const blocked = await service.transitionGoal(goal.id, {
      transition: 'escalate',
      sessionId: 'coord-1',
      escalation: { reason: 'low_confidence', question: 'Which module?' },
    });
    expect(blocked).toMatchObject({ state: 'blocked', escalation: { reason: 'low_confidence' } });
    await expect(service.answerGoal(goal.id, 'coord-1', 'the other one')).rejects.toMatchObject({
      code: 'AUTOPILOT_NOT_OPERATOR',
    });
    const answered = await service.answerGoal(goal.id, undefined, 'the other one');
    expect(answered).toMatchObject({
      state: 'running',
      answer: { text: 'the other one', by: 'operator' },
    });
    expect(fake.notices.map((notice) => notice.kind)).toContain('goal_answered');

    // A crash between the dispatch steps: the task is `dispatching`; the index holds the message.
    const stamp = nowIso;
    const task: Task = {
      id: 't-x',
      projectId: 'project-1',
      goalId: goal.id,
      title: 'x',
      brief: 'x',
      agentId: 'claude-code',
      paths: [],
      matchPaths: [''],
      dependsOn: [],
      evidenceRequirements: [],
      timeoutMs: 600_000,
      kind: 'work',
      reworkCount: 0,
      state: 'dispatching',
      dispatchSourceSessionId: 'coord-1',
      version: 2,
      createdAt: stamp,
      updatedAt: stamp,
    };
    fake.tasks.set(task.id, task);
    fake.activeOf('project-1').set(task.id, {
      taskId: task.id,
      goalId: goal.id,
      agentId: 'claude-code',
      state: 'dispatching',
      matchPaths: [''],
    });
    messages.findByIdempotencyKey.mockResolvedValueOnce({
      correlationId: 'corr-repaired',
      targetSessionId: 'worker-1',
    } as never);
    expect(await service.reconcileOnce()).toEqual({ repaired: 1, completed: 0 });
    expect(fake.tasks.get('t-x')).toMatchObject({
      state: 'dispatched',
      correlationId: 'corr-repaired',
    });

    const abandoned = await service.abandonGoal(goal.id, 'chat-1', 'enough');
    expect(abandoned).toMatchObject({ state: 'abandoned', failureReason: 'enough' });
  });
});
