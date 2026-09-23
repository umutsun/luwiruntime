import { createHash, randomUUID } from 'node:crypto';

import {
  AUTOPILOT_DISPATCH_WINDOW_MS,
  autopilotPolicySchema,
  createRuntimeEvent,
  normalizeLeasePath,
  type AgentMessage,
  type AutopilotKickResponse,
  type AutopilotMode,
  type AutopilotModeResponse,
  type AutopilotPolicy,
  type AutopilotPolicyInput,
  type AutopilotRecord,
  type Goal,
  type GoalCreateRequest,
  type GoalPlanRequest,
  type GoalTransitionRequest,
  type InboxNoticeKind,
  type PlannedTask,
  type Project,
  type RuntimeEvent,
  type RuntimeEventType,
  type SessionView,
  type Task,
  type TaskDispatchDenialReason,
  type TaskDispatchResponse,
  type TaskVerdictRequest,
  type WorkLease,
} from '@luwi/protocol';
import type { ActiveTaskEntry, AutopilotRepository } from '@luwi/redis';
import {
  ApplicationError,
  applyGoalTransition,
  applyTaskTransition,
  effectiveWorkers,
  evaluateDispatch,
  evaluateModeChange,
  isCoordinatorSession,
  isOperatorProxySession,
  outcomeFromMessage,
  rankAgentSessions,
  taskMatchPaths,
  validatePlannedTasks,
  verifyTaskOutcome,
  type GoalTransition,
  type TaskTransition,
} from '@luwi/runtime';

import type { MessageService } from './message-service.js';
import type { SessionService } from './session-service.js';

/**
 * The orchestration substrate (ADR 0035): the per-project autopilot record,
 * the goals and tasks the coordinator writes, the two-step dispatch, the
 * completion seam, the operator's gates and the coordinator's wake-ups.
 *
 * Policy lives in `@luwi/runtime` — this service gathers inputs, applies the
 * pure answers through compare-and-set writes, and names every refusal.
 */

export type AutopilotActor =
  { kind: 'operator'; via?: string } | { kind: 'session'; session: SessionView };

export type AutopilotService = {
  get(projectId: string): Promise<AutopilotRecord | null>;
  list(): Promise<AutopilotRecord[]>;
  coordinatorSessions(projectId: string): Promise<SessionView[]>;
  putPolicy(
    projectId: string,
    policy: AutopilotPolicyInput,
    options?: { source: 'operator' | 'manifest' },
  ): Promise<AutopilotRecord>;
  setMode(projectId: string, mode: AutopilotMode): Promise<AutopilotModeResponse>;
  kick(projectId: string): Promise<AutopilotKickResponse>;
  /** Projects every manifest-declared policy at start; a broken manifest is reported, not fatal. */
  reconcileManifests(
    projects: readonly Project[],
  ): Promise<{ projected: number; failed: string[] }>;

  createGoal(projectId: string, request: GoalCreateRequest): Promise<Goal>;
  getGoal(goalId: string): Promise<Goal>;
  listGoals(projectId: string, query: { state?: Goal['state']; limit: number }): Promise<Goal[]>;
  submitPlan(goalId: string, request: GoalPlanRequest): Promise<Goal>;
  approvePlan(goalId: string, actorSessionId: string | undefined, note?: string): Promise<Goal>;
  rejectPlan(goalId: string, actorSessionId: string | undefined, note?: string): Promise<Goal>;
  answerGoal(goalId: string, actorSessionId: string | undefined, text: string): Promise<Goal>;
  abandonGoal(goalId: string, actorSessionId: string | undefined, reason?: string): Promise<Goal>;
  transitionGoal(goalId: string, request: GoalTransitionRequest): Promise<Goal>;

  getTask(taskId: string): Promise<Task>;
  listTasks(
    projectId: string,
    query: { goalId?: string; state?: Task['state']; limit: number },
  ): Promise<Task[]>;
  dispatchTask(taskId: string, sessionId: string): Promise<TaskDispatchResponse>;
  recordVerdict(taskId: string, request: TaskVerdictRequest): Promise<Task>;
  createReviewTask(taskId: string, sessionId: string): Promise<Task>;
  createReworkTask(taskId: string, sessionId: string): Promise<Task>;
  cancelTask(taskId: string, actorSessionId: string | undefined, reason?: string): Promise<Task>;
  /** The single-task gate `approvePlan`'s bulk approval does not cover (a review or rework task
   * gated after plan approval). Operator-only; wakes the coordinator the same way `kick` does. */
  approveTask(taskId: string, actorSessionId: string | undefined, note?: string): Promise<Task>;
  rejectTask(taskId: string, actorSessionId: string | undefined, note?: string): Promise<Task>;
  /** The message-terminal seam: completes the task a message dispatched, if any. */
  completeFromMessage(message: AgentMessage): Promise<Task | null>;
  /** Repairs a dispatch interrupted between its steps and closes tasks whose message ended unseen. */
  reconcileOnce(): Promise<{ repaired: number; completed: number }>;
};

export type AutopilotServiceOptions = {
  repository: AutopilotRepository;
  sessions: Pick<SessionService, 'get' | 'list'>;
  projects: { get(projectId: string): Promise<Project | null> };
  messages: Pick<MessageService, 'askForTask' | 'get' | 'findByIdempotencyKey'>;
  bindings: {
    listProjectAgentBindings(projectId: string): Promise<{ agentId: string; enabled: boolean }[]>;
  };
  leases: { list(query: { projectId?: string; limit: number }): Promise<WorkLease[]> };
  commits: { listGitCommits(projectId: string, limit?: number): Promise<{ sha: string }[]> };
  /**
   * A lane worktree commits on `lane/<role>` branches of the same repository,
   * which the observed log (`commits.listGitCommits`, the project's root HEAD
   * history) never reaches. Asked only for a cited sha the observed log does
   * not already know, so `commit_evidence` accepts it without the recent-commits
   * UI filling with worktree branches. Absent, or an answer of `false`, leaves
   * today's behavior unchanged.
   */
  commitExists?: (projectId: string, sha: string) => Promise<boolean>;
  /**
   * Refresh the project's Git observation before a commit is verified. The
   * worker commits before it responds, so a scan here makes the just-made
   * commit visible to the commit_evidence check instead of racing the periodic
   * scan interval. Best-effort: a failure falls back to the current observation.
   */
  refreshGitObservation?: (projectId: string) => Promise<void>;
  manifest: {
    readProjectAutopilotPolicy(projectRoot: string): Promise<unknown | undefined>;
    writeProjectAutopilotPolicy(project: Project, policy: AutopilotPolicy): Promise<void>;
  };
  workspaceId: string;
  now?: () => Date;
  createId?: () => string;
  report?: (line: Record<string, unknown>) => void;
};

const ANSWER_CLIP = 1500;

function policyHash(policy: AutopilotPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

export function createAutopilotService(options: AutopilotServiceOptions): AutopilotService {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const nowIso = () => now().toISOString();

  const event = (
    type: RuntimeEventType,
    scope: { projectId: string; sessionId?: string; agentId?: string; correlationId?: string },
    payload: Record<string, unknown>,
  ): RuntimeEvent =>
    createRuntimeEvent({
      type,
      workspaceId: options.workspaceId,
      projectId: scope.projectId,
      ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
      ...(scope.agentId === undefined ? {} : { agentId: scope.agentId }),
      ...(scope.correlationId === undefined ? {} : { correlationId: scope.correlationId }),
      payload,
    });

  const requireProject = async (projectId: string): Promise<Project> => {
    const project = await options.projects.get(projectId);
    if (project === null) {
      throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
    }
    return project;
  };
  const requireConfigured = async (
    projectId: string,
  ): Promise<{ record: AutopilotRecord; policy: AutopilotPolicy }> => {
    const record = await options.repository.getAutopilot(projectId);
    if (record === null || record.policy === null) {
      throw new ApplicationError(
        'AUTOPILOT_NOT_CONFIGURED',
        'This project has no autopilot policy.',
        409,
      );
    }
    return { record, policy: record.policy };
  };
  const requireGoal = async (goalId: string): Promise<Goal> => {
    const goal = await options.repository.getGoal(goalId);
    if (goal === null) throw new ApplicationError('GOAL_NOT_FOUND', 'The goal was not found.', 404);
    return goal;
  };
  const requireTask = async (taskId: string): Promise<Task> => {
    const task = await options.repository.getTask(taskId);
    if (task === null) throw new ApplicationError('TASK_NOT_FOUND', 'The task was not found.', 404);
    return task;
  };
  const requireCoordinator = async (
    policy: AutopilotPolicy,
    projectId: string,
    sessionId: string,
  ): Promise<SessionView> => {
    const session = await options.sessions.get(sessionId);
    if (session === null || !isCoordinatorSession(policy, session, projectId)) {
      throw new ApplicationError(
        'AUTOPILOT_NOT_COORDINATOR',
        `Only a live session of the coordinator agent ${policy.coordinatorAgentId} may do this.`,
        403,
      );
    }
    return session;
  };
  /** The operator surface itself, or a session the policy names as the operator's proxy. */
  const requireOperator = async (
    policy: AutopilotPolicy,
    projectId: string,
    sessionId: string | undefined,
  ): Promise<string> => {
    if (sessionId === undefined) return 'operator';
    const session = await options.sessions.get(sessionId);
    if (session === null || !isOperatorProxySession(policy, session, projectId)) {
      throw new ApplicationError(
        'AUTOPILOT_NOT_OPERATOR',
        'Only the operator, or a session the policy names as an operator proxy, may do this.',
        403,
      );
    }
    return `session:${session.agentId}:${session.id}`;
  };

  const coordinatorSessions = async (projectId: string): Promise<SessionView[]> => {
    const record = await options.repository.getAutopilot(projectId);
    if (record === null || record.policy === null) return [];
    return rankAgentSessions({
      sessions: await options.sessions.list(projectId),
      projectId,
      agentId: record.policy.coordinatorAgentId,
    });
  };

  const notify = async (
    projectId: string,
    kind: InboxNoticeKind,
    extra: { goalId?: string; taskId?: string; correlationId?: string; mode?: AutopilotMode } = {},
  ): Promise<{ notified: boolean; sessionId?: string }> => {
    const [target] = await coordinatorSessions(projectId);
    if (target === undefined) return { notified: false };
    const result = await options.repository.queueNotice({
      sessionId: target.id,
      projectId,
      notice: {
        itemKind: 'notice',
        targetSessionId: target.id,
        createdAt: nowIso(),
        payload: { kind, projectId, ...extra },
      },
      event: event(
        'autopilot.notice.queued',
        { projectId, sessionId: target.id, agentId: target.agentId },
        { noticeKind: kind, ...extra },
      ),
    });
    return result.status === 'queued'
      ? { notified: true, sessionId: target.id }
      : { notified: false };
  };

  const writeGoal = async (
    goal: Goal,
    expectedVersion: number,
    goalEvent: RuntimeEvent | null,
  ): Promise<Goal> => {
    const result = await options.repository.writeGoal({ goal, event: goalEvent, expectedVersion });
    if (result.status === 'version_conflict') {
      throw new ApplicationError(
        'GOAL_VERSION_CONFLICT',
        'The goal changed underneath this request.',
        409,
      );
    }
    return result.record;
  };
  const writeTask = async (
    task: Task,
    expectedVersion: number,
    taskEvent: RuntimeEvent | null,
    active: ActiveTaskEntry | null,
  ): Promise<Task> => {
    const result = await options.repository.writeTask({
      task,
      event: taskEvent,
      expectedVersion,
      active,
    });
    if (result.status === 'version_conflict') {
      throw new ApplicationError(
        'TASK_VERSION_CONFLICT',
        'The task changed underneath this request.',
        409,
      );
    }
    return result.record;
  };
  const goalMove = (goal: Goal, transition: GoalTransition): Goal => {
    const result = applyGoalTransition(goal, transition, nowIso());
    if (result.status === 'invalid') {
      throw new ApplicationError(
        'GOAL_STATE_INVALID',
        `A ${result.from} goal cannot ${result.transition}: ${result.reason}.`,
        409,
      );
    }
    return result.goal;
  };
  const taskMove = (task: Task, transition: TaskTransition): Task => {
    const result = applyTaskTransition(task, transition, nowIso());
    if (result.status === 'invalid') {
      throw new ApplicationError(
        'TASK_STATE_INVALID',
        `A ${result.from} task cannot ${result.transition}: ${result.reason}.`,
        409,
      );
    }
    return result.task;
  };
  const activeEntry = (task: Task, state: 'dispatching' | 'dispatched'): ActiveTaskEntry => ({
    taskId: task.id,
    goalId: task.goalId,
    agentId: task.agentId ?? 'unknown',
    state,
    matchPaths: task.matchPaths,
    ...(task.correlationId === undefined ? {} : { correlationId: task.correlationId }),
  });

  const materializeTasks = async (
    goal: Goal,
    policy: AutopilotPolicy,
    planned: readonly PlannedTask[],
    sessionId: string,
  ): Promise<Task[]> => {
    const created: Task[] = [];
    const ids = planned.map(() => createId());
    for (const [index, item] of planned.entries()) {
      let paths: string[];
      try {
        paths = item.paths.map((path) => normalizeLeasePath(path).path);
      } catch {
        throw new ApplicationError(
          'TASK_PATH_INVALID',
          'A planned task path is not project-relative.',
          400,
        );
      }
      const stamp = nowIso();
      const task: Task = {
        id: ids[index] as string,
        projectId: goal.projectId,
        goalId: goal.id,
        title: item.title,
        brief: item.brief,
        agentId: item.agentId,
        paths,
        matchPaths: taskMatchPaths(paths.map((path) => normalizeLeasePath(path).matchPath)),
        dependsOn: item.dependsOn.map((dependency) => ids[dependency] as string),
        evidenceRequirements: item.evidenceRequirements,
        timeoutMs: policy.defaultTaskTimeoutMs,
        ...(item.doneCriteria === undefined ? {} : { doneCriteria: item.doneCriteria }),
        kind: 'work',
        reworkCount: 0,
        state: 'ready',
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      created.push(
        await writeTask(
          task,
          0,
          event(
            'task.created',
            { projectId: goal.projectId, sessionId, agentId: item.agentId },
            { taskId: task.id, goalId: goal.id, title: task.title, agentId: item.agentId, paths },
          ),
          null,
        ),
      );
    }
    return created;
  };

  const projectContent = (task: Task): string =>
    [
      task.brief,
      task.doneCriteria === undefined ? '' : `Done means: ${task.doneCriteria}`,
      task.paths.length === 0
        ? 'Declared scope: the whole project. Claim leases before editing.'
        : `Declared scope (claim leases before editing): ${task.paths.join(', ')}`,
    ]
      .filter((part) => part !== '')
      .join('\n\n');

  const denyDispatch = async (
    task: Task,
    reason: TaskDispatchDenialReason,
    detail: string,
    sessionId: string,
  ): Promise<TaskDispatchResponse> => {
    const denied: Task = {
      ...task,
      lastDenial: { reason, detail, at: nowIso() },
      version: task.version + 1,
      updatedAt: nowIso(),
    };
    const stored = await writeTask(
      denied,
      task.version,
      event(
        'task.dispatch.denied',
        {
          projectId: task.projectId,
          sessionId,
          ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
        },
        { taskId: task.id, goalId: task.goalId, reason, detail },
      ),
      null,
    );
    return { outcome: 'denied', task: stored, reason, detail };
  };

  const finishDispatch = async (task: Task, sessionId: string): Promise<TaskDispatchResponse> => {
    // Step 2: the ordinary message path, keyed so a repeat returns the same message.
    let correlationId: string;
    let targetSessionId: string;
    try {
      const result = await options.messages.askForTask(
        {
          sourceSessionId: sessionId,
          targetAgentId: task.agentId as string,
          kind: 'instruction',
          subject: `task ${task.id}: ${task.title}`.slice(0, 500),
          content: projectContent(task),
          evidenceRequirements: task.evidenceRequirements,
          timeoutMs: task.timeoutMs,
        },
        `task:${task.id}`,
      );
      correlationId = result.message.correlationId;
      targetSessionId = result.message.targetSessionId;
    } catch (error) {
      const reason =
        error instanceof ApplicationError
          ? `${error.code}: ${error.message}`
          : 'The dispatch message could not be created.';
      const failed = taskMove(task, { kind: 'dispatch_failed', reason });
      const stored = await writeTask(
        failed,
        task.version,
        event(
          'task.completed',
          {
            projectId: task.projectId,
            sessionId,
            ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
          },
          { taskId: task.id, goalId: task.goalId, state: 'failed', reason },
        ),
        null,
      );
      return { outcome: 'denied', task: stored, reason: 'worker_unavailable', detail: reason };
    }
    // Step 3: record the message on the task.
    const dispatched = taskMove(task, { kind: 'dispatched', correlationId, targetSessionId });
    const stored = await writeTask(
      dispatched,
      task.version,
      event(
        'task.dispatched',
        {
          projectId: task.projectId,
          sessionId,
          agentId: dispatched.agentId as string,
          correlationId,
        },
        {
          taskId: task.id,
          goalId: task.goalId,
          correlationId,
          targetSessionId,
          agentId: dispatched.agentId,
        },
      ),
      activeEntry(dispatched, 'dispatched'),
    );
    return { outcome: 'dispatched', task: stored, correlationId };
  };

  const complete = async (task: Task, message: AgentMessage): Promise<Task> => {
    let commitKnown: ((sha: string) => boolean) | undefined;
    if ((message.response?.evidence ?? []).some((item) => item.type === 'git_commit')) {
      // Refresh the observation first so a just-made commit is verified against
      // fresh Git state, not a window the periodic scan has not reached yet.
      // Best-effort: on failure we fall back to the current observation, which
      // only ever makes commit_evidence fail more cautiously.
      if (options.refreshGitObservation !== undefined) {
        try {
          await options.refreshGitObservation(task.projectId);
        } catch {
          /* fall back to the current observation */
        }
      }
      const known = new Set(
        (await options.commits.listGitCommits(task.projectId, 500)).map((commit) => commit.sha),
      );
      if (options.commitExists !== undefined) {
        const cited = new Set(
          (message.response?.evidence ?? [])
            .filter((item) => item.type === 'git_commit')
            .map((item) => item.gitHead ?? item.reference)
            .filter((sha): sha is string => sha !== undefined && !known.has(sha)),
        );
        for (const sha of cited) {
          if (await options.commitExists(task.projectId, sha)) known.add(sha);
        }
      }
      commitKnown = (sha) => known.has(sha);
    }
    const outcome = outcomeFromMessage(message);
    const checks = verifyTaskOutcome({
      task,
      message,
      ...(commitKnown === undefined ? {} : { commitKnown }),
    });
    const done = taskMove(task, { kind: 'complete', outcome, checks });
    const stored = await writeTask(
      done,
      task.version,
      event(
        'task.completed',
        {
          projectId: task.projectId,
          ...(task.targetSessionId === undefined ? {} : { sessionId: task.targetSessionId }),
          ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
          correlationId: message.correlationId,
        },
        {
          taskId: task.id,
          goalId: task.goalId,
          state: done.state,
          messageState: outcome.messageState,
          ...(outcome.status === undefined ? {} : { outcomeStatus: outcome.status }),
          checksPassed: checks.filter((check) => check.passed).length,
          checksTotal: checks.length,
        },
      ),
      null,
    );
    await notify(task.projectId, 'task_completed', {
      goalId: task.goalId,
      taskId: task.id,
      correlationId: message.correlationId,
    });
    return stored;
  };

  return {
    get: (projectId) => options.repository.getAutopilot(projectId),
    list: () => options.repository.listAutopilot(),
    coordinatorSessions,

    async putPolicy(projectId, input, putOptions = { source: 'operator' }) {
      const project = await requireProject(projectId);
      const parsed = autopilotPolicySchema.safeParse(input);
      if (!parsed.success) {
        throw new ApplicationError(
          'AUTOPILOT_POLICY_INVALID',
          `The autopilot policy is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
          400,
        );
      }
      const policy = parsed.data;
      const bindings = await options.bindings.listProjectAgentBindings(projectId);
      const enabled = new Set(
        bindings.filter((binding) => binding.enabled).map((binding) => binding.agentId),
      );
      const named = [
        policy.coordinatorAgentId,
        ...policy.workerAgentIds,
        ...policy.operatorProxyAgentIds,
        ...(policy.reviewerAgentId === undefined ? [] : [policy.reviewerAgentId]),
      ];
      const unknown = named.filter((agentId) => !enabled.has(agentId));
      if (unknown.length > 0) {
        throw new ApplicationError(
          'AUTOPILOT_POLICY_INVALID',
          `These agents are not enabled bindings of the project: ${[...new Set(unknown)].join(', ')}.`,
          400,
        );
      }
      const current = await options.repository.getAutopilot(projectId);
      const hash = policyHash(policy);
      if (current !== null && current.policyHash === hash) return current;
      if (putOptions.source === 'operator') {
        await options.manifest.writeProjectAutopilotPolicy(project, policy);
      }
      const record: AutopilotRecord = {
        projectId,
        mode: current?.mode ?? 'off',
        policy,
        policyHash: hash,
        version: (current?.version ?? 0) + 1,
        changedAt: nowIso(),
      };
      const result = await options.repository.putAutopilot({
        record,
        event: event(
          'autopilot.policy.updated',
          { projectId, agentId: policy.coordinatorAgentId },
          {
            policyHash: hash,
            coordinatorAgentId: policy.coordinatorAgentId,
            workerCount: policy.workerAgentIds.length,
            source: putOptions.source,
          },
        ),
        expectedVersion: current?.version ?? 0,
      });
      if (result.status === 'version_conflict') {
        throw new ApplicationError(
          'AUTOPILOT_VERSION_CONFLICT',
          'The autopilot record changed underneath this request.',
          409,
        );
      }
      return result.record;
    },

    async setMode(projectId, mode) {
      await requireProject(projectId);
      const current = await options.repository.getAutopilot(projectId);
      const evaluation = evaluateModeChange(current, mode);
      if (evaluation.status === 'not_configured') {
        throw new ApplicationError(
          'AUTOPILOT_NOT_CONFIGURED',
          'Declare an autopilot policy before enabling a mode.',
          409,
        );
      }
      if (evaluation.status === 'unchanged') {
        return { record: current as AutopilotRecord, changed: false, coordinatorNotified: false };
      }
      const record: AutopilotRecord = {
        projectId,
        mode,
        policy: current?.policy ?? null,
        ...(current?.policyHash === undefined ? {} : { policyHash: current.policyHash }),
        version: (current?.version ?? 0) + 1,
        changedAt: nowIso(),
      };
      const result = await options.repository.putAutopilot({
        record,
        event: event(
          'autopilot.mode.changed',
          { projectId },
          { from: evaluation.from, to: evaluation.to, actor: 'operator' },
        ),
        expectedVersion: current?.version ?? 0,
      });
      if (result.status === 'version_conflict') {
        throw new ApplicationError(
          'AUTOPILOT_VERSION_CONFLICT',
          'The autopilot record changed underneath this request.',
          409,
        );
      }
      const notice = await notify(projectId, 'mode_changed', { mode });
      return { record: result.record, changed: true, coordinatorNotified: notice.notified };
    },

    async kick(projectId) {
      await requireConfigured(projectId);
      const notice = await notify(projectId, 'kick');
      return {
        coordinatorNotified: notice.notified,
        ...(notice.sessionId === undefined ? {} : { coordinatorSessionId: notice.sessionId }),
      };
    },

    async reconcileManifests(projects) {
      let projected = 0;
      const failed: string[] = [];
      for (const project of projects) {
        try {
          const declared = await options.manifest.readProjectAutopilotPolicy(project.canonicalPath);
          if (declared === undefined) continue;
          await this.putPolicy(project.id, declared as AutopilotPolicyInput, {
            source: 'manifest',
          });
          projected += 1;
        } catch (error) {
          failed.push(project.id);
          options.report?.({
            projectId: project.id,
            reason: 'autopilot manifest refused',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { projected, failed };
    },

    async createGoal(projectId, request) {
      await requireProject(projectId);
      const { policy } = await requireConfigured(projectId);
      let createdBy: Goal['createdBy'] = { kind: 'operator' };
      if (request.sessionId !== undefined) {
        const session = await options.sessions.get(request.sessionId);
        if (session === null || session.projectId !== projectId) {
          throw new ApplicationError(
            'SOURCE_SESSION_INVALID',
            'The creating session is not in this project.',
            409,
          );
        }
        createdBy = { kind: 'session', sessionId: session.id, agentId: session.agentId };
      }
      const budget = { ...policy.goalDefaults };
      if (request.budget !== undefined) {
        // A session may lower a budget, never raise it; the operator may do either.
        for (const key of Object.keys(request.budget) as (keyof typeof budget)[]) {
          const value = request.budget[key];
          if (value === undefined) continue;
          if (createdBy.kind === 'operator' || value <= budget[key]) budget[key] = value;
        }
      }
      const stamp = nowIso();
      const goal: Goal = {
        id: createId(),
        projectId,
        title: request.title,
        objective: request.objective,
        acceptanceCriteria: request.acceptanceCriteria,
        createdBy,
        budget,
        state: 'proposed',
        planVersion: 0,
        taskIds: [],
        usage: { tasks: 0, reworks: 0, replans: 0, judgments: 0, invalidJudgments: 0 },
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const stored = await writeGoal(
        goal,
        0,
        event(
          'goal.created',
          {
            projectId,
            ...(createdBy.kind === 'session'
              ? { sessionId: createdBy.sessionId, agentId: createdBy.agentId }
              : {}),
          },
          { goalId: goal.id, title: goal.title, createdBy: createdBy.kind },
        ),
      );
      await notify(projectId, 'goal_created', { goalId: goal.id });
      return stored;
    },

    getGoal: requireGoal,

    async listGoals(projectId, query) {
      const goals = await options.repository.listProjectGoals(
        projectId,
        query.state === undefined ? query.limit : 1000,
      );
      const filtered =
        query.state === undefined ? goals : goals.filter((goal) => goal.state === query.state);
      return filtered.slice(0, query.limit);
    },

    async submitPlan(goalId, request) {
      const goal = await requireGoal(goalId);
      const { record, policy } = await requireConfigured(goal.projectId);
      const session = await requireCoordinator(policy, goal.projectId, request.sessionId);
      const workers = effectiveWorkers(
        policy,
        await options.bindings.listProjectAgentBindings(goal.projectId),
      );
      const current = await options.repository.listGoalTasks(goal.id);
      const kept = new Set(request.keep ?? []);
      const keepable = current.filter(
        (task) =>
          goal.taskIds.includes(task.id) &&
          (task.state === 'ready' ||
            task.state === 'approved' ||
            task.state === 'awaiting_approval' ||
            task.state === 'dispatching' ||
            task.state === 'dispatched'),
      );
      if (goal.state === 'planning' && request.tasks.length === 0) {
        throw new ApplicationError('GOAL_PLAN_INVALID', 'A plan needs at least one task.', 400);
      }
      const errors = validatePlannedTasks(request.tasks, {
        workers,
        maxTasks: goal.budget.maxTasks,
        alreadyPlanned:
          goal.state === 'planning'
            ? goal.usage.tasks
            : goal.usage.tasks -
              (goal.taskIds.length - keepable.filter((task) => kept.has(task.id)).length),
      });
      for (const id of kept) {
        if (!keepable.some((task) => task.id === id))
          errors.push(`keep names ${id}, which is not a live task of this goal.`);
      }
      if (errors.length > 0) {
        throw new ApplicationError('GOAL_PLAN_INVALID', errors.join(' '), 400, {
          refusals: errors.length,
        });
      }
      const needsReview = record.mode === 'supervised';
      if (goal.state === 'planning') {
        const created = await materializeTasks(goal, policy, request.tasks, session.id);
        const next = goalMove(goal, {
          kind: 'plan',
          taskIds: created.map((task) => task.id),
          ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
          needsReview,
        });
        return writeGoal(
          next,
          goal.version,
          event(
            'goal.planned',
            { projectId: goal.projectId, sessionId: session.id, agentId: session.agentId },
            {
              goalId: goal.id,
              planVersion: next.planVersion,
              taskCount: created.length,
              needsReview,
              ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
            },
          ),
        );
      }
      // A replan: cancel what is not kept, add what is new.
      for (const task of keepable) {
        if (kept.has(task.id) || task.state === 'dispatching' || task.state === 'dispatched')
          continue;
        const cancelled = taskMove(task, { kind: 'cancel' });
        await writeTask(
          cancelled,
          task.version,
          event(
            'task.cancelled',
            { projectId: goal.projectId, sessionId: session.id },
            { taskId: task.id, goalId: goal.id, by: 'replan' },
          ),
          null,
        );
      }
      const created = await materializeTasks(goal, policy, request.tasks, session.id);
      const survivors = keepable
        .filter(
          (task) =>
            kept.has(task.id) || task.state === 'dispatching' || task.state === 'dispatched',
        )
        .map((task) => task.id);
      const acceptedIds = current
        .filter(
          (task) =>
            goal.taskIds.includes(task.id) &&
            task.state === 'done' &&
            task.verification?.verdict === 'accept',
        )
        .map((task) => task.id);
      const next = goalMove(goal, {
        kind: 'replan',
        taskIds: [...acceptedIds, ...survivors, ...created.map((task) => task.id)],
        ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
        needsReview,
      });
      return writeGoal(
        next,
        goal.version,
        event(
          'goal.replanned',
          { projectId: goal.projectId, sessionId: session.id, agentId: session.agentId },
          {
            goalId: goal.id,
            planVersion: next.planVersion,
            kept: survivors.length,
            added: created.length,
            needsReview,
          },
        ),
      );
    },

    async approvePlan(goalId, actorSessionId, note) {
      const goal = await requireGoal(goalId);
      const { policy } = await requireConfigured(goal.projectId);
      const by = await requireOperator(policy, goal.projectId, actorSessionId);
      const next = goalMove(goal, { kind: 'plan_approved' });
      // Approving a plan approves its tasks in one gesture (bulk approval).
      for (const task of await options.repository.listGoalTasks(goal.id)) {
        if (
          !goal.taskIds.includes(task.id) ||
          (task.state !== 'ready' && task.state !== 'awaiting_approval')
        )
          continue;
        const approved = taskMove(task, {
          kind: 'approve',
          by,
          ...(note === undefined ? {} : { note }),
        });
        await writeTask(
          approved,
          task.version,
          event(
            'task.approved',
            { projectId: goal.projectId },
            { taskId: task.id, goalId: goal.id, by },
          ),
          null,
        );
      }
      const stored = await writeGoal(
        next,
        goal.version,
        event(
          'goal.plan.approved',
          { projectId: goal.projectId },
          {
            goalId: goal.id,
            planVersion: goal.planVersion,
            by,
            ...(note === undefined ? {} : { note }),
          },
        ),
      );
      await notify(goal.projectId, 'plan_approved', { goalId: goal.id });
      return stored;
    },

    async rejectPlan(goalId, actorSessionId, note) {
      const goal = await requireGoal(goalId);
      const { policy } = await requireConfigured(goal.projectId);
      const by = await requireOperator(policy, goal.projectId, actorSessionId);
      for (const task of await options.repository.listGoalTasks(goal.id)) {
        if (
          !goal.taskIds.includes(task.id) ||
          (task.state !== 'ready' &&
            task.state !== 'awaiting_approval' &&
            task.state !== 'approved')
        )
          continue;
        const cancelled = taskMove(task, { kind: 'cancel' });
        await writeTask(
          cancelled,
          task.version,
          event(
            'task.cancelled',
            { projectId: goal.projectId },
            { taskId: task.id, goalId: goal.id, by: 'plan_rejected' },
          ),
          null,
        );
      }
      const next = goalMove(goal, {
        kind: 'plan_rejected',
        by,
        ...(note === undefined ? {} : { note }),
      });
      const stored = await writeGoal(
        next,
        goal.version,
        event(
          'goal.plan.rejected',
          { projectId: goal.projectId },
          {
            goalId: goal.id,
            planVersion: goal.planVersion,
            by,
            ...(note === undefined ? {} : { note }),
          },
        ),
      );
      await notify(goal.projectId, 'plan_rejected', { goalId: goal.id });
      return stored;
    },

    async answerGoal(goalId, actorSessionId, text) {
      const goal = await requireGoal(goalId);
      const { policy } = await requireConfigured(goal.projectId);
      const by = await requireOperator(policy, goal.projectId, actorSessionId);
      const next = goalMove(goal, { kind: 'answer', text, by });
      const stored = await writeGoal(
        next,
        goal.version,
        event(
          'goal.answered',
          { projectId: goal.projectId },
          { goalId: goal.id, by, reason: goal.escalation?.reason },
        ),
      );
      await notify(goal.projectId, 'goal_answered', { goalId: goal.id });
      return stored;
    },

    async abandonGoal(goalId, actorSessionId, reason) {
      const goal = await requireGoal(goalId);
      const { policy } = await requireConfigured(goal.projectId);
      const by = await requireOperator(policy, goal.projectId, actorSessionId);
      for (const task of await options.repository.listGoalTasks(goal.id)) {
        if (
          task.state !== 'ready' &&
          task.state !== 'awaiting_approval' &&
          task.state !== 'approved'
        )
          continue;
        const cancelled = taskMove(task, { kind: 'cancel' });
        await writeTask(
          cancelled,
          task.version,
          event(
            'task.cancelled',
            { projectId: goal.projectId },
            { taskId: task.id, goalId: goal.id, by: 'abandoned' },
          ),
          null,
        );
      }
      const next = goalMove(goal, { kind: 'abandon', ...(reason === undefined ? {} : { reason }) });
      const stored = await writeGoal(
        next,
        goal.version,
        event(
          'goal.abandoned',
          { projectId: goal.projectId },
          { goalId: goal.id, by, ...(reason === undefined ? {} : { reason }) },
        ),
      );
      await notify(goal.projectId, 'goal_abandoned', { goalId: goal.id });
      return stored;
    },

    async transitionGoal(goalId, request) {
      const goal = await requireGoal(goalId);
      const { policy } = await requireConfigured(goal.projectId);
      const session = await requireCoordinator(policy, goal.projectId, request.sessionId);
      const scope = { projectId: goal.projectId, sessionId: session.id, agentId: session.agentId };
      switch (request.transition) {
        case 'start': {
          const next = goalMove(goal, { kind: 'start' });
          return writeGoal(next, goal.version, event('goal.started', scope, { goalId: goal.id }));
        }
        case 'escalate': {
          const next = goalMove(goal, { kind: 'escalate', escalation: request.escalation });
          return writeGoal(
            next,
            goal.version,
            event('goal.escalated', scope, {
              goalId: goal.id,
              reason: request.escalation.reason,
              question: request.escalation.question.slice(0, 500),
              ...(request.escalation.taskId === undefined
                ? {}
                : { taskId: request.escalation.taskId }),
            }),
          );
        }
        case 'achieve': {
          const next = goalMove(goal, { kind: 'achieve' });
          return writeGoal(
            next,
            goal.version,
            event('goal.achieved', scope, {
              goalId: goal.id,
              tasks: goal.usage.tasks,
              reworks: goal.usage.reworks,
              replans: goal.usage.replans,
              judgments: goal.usage.judgments,
            }),
          );
        }
        case 'fail': {
          const next = goalMove(goal, { kind: 'fail', reason: request.reason });
          return writeGoal(
            next,
            goal.version,
            event('goal.failed', scope, { goalId: goal.id, reason: request.reason }),
          );
        }
        case 'retrospective': {
          const next = goalMove(goal, {
            kind: 'retrospective',
            retrospective: request.retrospective,
          });
          return writeGoal(
            next,
            goal.version,
            event('goal.retrospective.written', scope, {
              goalId: goal.id,
              summaryChars: request.retrospective.summary.length,
            }),
          );
        }
        case 'count_judgment': {
          const next = goalMove(goal, { kind: 'count_judgment', invalid: request.invalid });
          return writeGoal(
            next,
            goal.version,
            event('orchestrator.judgment.decided', scope, {
              goalId: goal.id,
              kind: request.kind,
              invalid: request.invalid,
              ...(request.brain === undefined ? {} : { brain: request.brain }),
              ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
              ...(request.summary === undefined ? {} : { summary: request.summary }),
              ...(request.promptSha256 === undefined ? {} : { promptSha256: request.promptSha256 }),
              ...(request.ms === undefined ? {} : { ms: request.ms }),
            }),
          );
        }
        default:
          throw new ApplicationError('GOAL_STATE_INVALID', 'Unknown goal transition.', 400);
      }
    },

    getTask: requireTask,

    async listTasks(projectId, query) {
      const tasks =
        query.goalId === undefined
          ? await options.repository.listProjectTasks(
              projectId,
              query.state === undefined ? query.limit : 1000,
            )
          : await options.repository.listGoalTasks(query.goalId);
      const filtered = tasks.filter(
        (task) =>
          task.projectId === projectId && (query.state === undefined || task.state === query.state),
      );
      return filtered.slice(0, query.limit);
    },

    async dispatchTask(taskId, sessionId) {
      const task = await requireTask(taskId);
      const goal = await requireGoal(task.goalId);
      const { record, policy } = await requireConfigured(task.projectId);
      const session = await requireCoordinator(policy, task.projectId, sessionId);
      if (goal.state !== 'running') {
        return denyDispatch(
          task,
          'task_state',
          `The goal is ${goal.state}, not running.`,
          session.id,
        );
      }
      const workers = effectiveWorkers(
        policy,
        await options.bindings.listProjectAgentBindings(task.projectId),
      );
      const active = await options.repository.listActiveTasks(task.projectId);
      const nowMs = now().getTime();
      const dependencies = await Promise.all(
        task.dependsOn.map((id) => options.repository.getTask(id)),
      );
      const evaluation = evaluateDispatch({
        mode: record.mode,
        policy,
        task,
        workers,
        inFlight: active.map((entry) => ({
          id: entry.taskId,
          matchPaths: entry.matchPaths,
          agentId: entry.agentId,
          state: entry.state,
        })),
        recentDispatchesMs: await options.repository.recentDispatchesMs(
          task.projectId,
          nowMs - AUTOPILOT_DISPATCH_WINDOW_MS,
        ),
        dependencies: dependencies.filter((dependency): dependency is Task => dependency !== null),
        leases: await options.leases.list({ projectId: task.projectId, limit: 100 }),
        sessions: await options.sessions.list(),
        nowMs,
      });
      if (evaluation.decision === 'deny') {
        return denyDispatch(task, evaluation.reason, evaluation.detail, session.id);
      }
      if (evaluation.decision === 'gate') {
        const gated = taskMove(task, { kind: 'gate', gate: evaluation.gate });
        const stored = await writeTask(
          gated,
          task.version,
          event(
            'task.gated',
            { projectId: task.projectId, sessionId: session.id },
            { taskId: task.id, goalId: task.goalId, gate: evaluation.gate },
          ),
          null,
        );
        return { outcome: 'gated', task: stored, gate: evaluation.gate };
      }
      // Step 1: the atomic slot.
      const dispatching = taskMove(task, { kind: 'dispatching', sourceSessionId: session.id });
      const slot = await options.repository.dispatchTask({
        task: dispatching,
        expectedVersion: task.version,
        nowMs,
        windowMs: AUTOPILOT_DISPATCH_WINDOW_MS,
        maxInFlight: policy.maxInFlight,
        maxPerHour: policy.maxDispatchesPerHour,
        active: activeEntry(dispatching, 'dispatching'),
      });
      if (slot.status === 'denied') {
        return denyDispatch(task, slot.reason, slot.detail, session.id);
      }
      if (slot.status === 'version_conflict') {
        throw new ApplicationError(
          'TASK_VERSION_CONFLICT',
          'The task changed underneath this dispatch.',
          409,
        );
      }
      return finishDispatch(slot.task, session.id);
    },

    async recordVerdict(taskId, request) {
      const task = await requireTask(taskId);
      const { policy } = await requireConfigured(task.projectId);
      const session = await requireCoordinator(policy, task.projectId, request.sessionId);
      const judged = taskMove(task, {
        kind: 'verdict',
        verdict: request.verdict,
        ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
        ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
      });
      return writeTask(
        judged,
        task.version,
        event(
          'task.verified',
          { projectId: task.projectId, sessionId: session.id, agentId: session.agentId },
          {
            taskId: task.id,
            goalId: task.goalId,
            verdict: request.verdict,
            ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
          },
        ),
        null,
      );
    },

    async createReviewTask(taskId, sessionId) {
      const task = await requireTask(taskId);
      const goal = await requireGoal(task.goalId);
      const { policy } = await requireConfigured(task.projectId);
      const session = await requireCoordinator(policy, task.projectId, sessionId);
      if (policy.reviewerAgentId === undefined || policy.reviewerAgentId === task.agentId) {
        throw new ApplicationError(
          'AUTOPILOT_POLICY_INVALID',
          'The policy names no reviewer distinct from the author.',
          409,
        );
      }
      const stamp = nowIso();
      const review: Task = {
        id: createId(),
        projectId: task.projectId,
        goalId: task.goalId,
        title: `Review: ${task.title}`.slice(0, 200),
        brief: [
          `Review the work another agent reported for the task "${task.title}". Read only; change nothing.`,
          'The work is committed in another worktree of the same repository. Check out the commit the worker cited as a detached HEAD in your own working directory before running any check.',
          'If the worker cited no commit, or you cannot check it out, inspect the work read-only instead: `git worktree list` to find its worktree, then `git -C <that path> diff` for uncommitted changes, or `git show <sha>` for a commit.',
          `Original brief:\n${task.brief}`,
          task.doneCriteria === undefined ? '' : `Done means: ${task.doneCriteria}`,
          `Goal acceptance criteria: ${goal.acceptanceCriteria.join('; ') || 'none stated'}`,
          `The worker answered (${task.outcome?.status ?? 'unknown'}): ${(task.outcome?.answer ?? '').slice(0, ANSWER_CLIP)}`,
          'Answer with: whether the work meets the brief and the criteria, what is missing or wrong, and cite files or commits you checked.',
        ]
          .filter((part) => part !== '')
          .join('\n\n'),
        agentId: policy.reviewerAgentId,
        paths: task.paths,
        matchPaths: task.matchPaths,
        dependsOn: [],
        evidenceRequirements: [],
        timeoutMs: policy.defaultTaskTimeoutMs,
        kind: 'review',
        reviewOf: task.id,
        reworkCount: 0,
        state: 'ready',
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      await writeTask(
        review,
        0,
        event(
          'task.created',
          { projectId: task.projectId, sessionId: session.id, agentId: policy.reviewerAgentId },
          {
            taskId: review.id,
            goalId: goal.id,
            title: review.title,
            agentId: policy.reviewerAgentId,
            kind: 'review',
            reviewOf: task.id,
          },
        ),
        null,
      );
      const linked = taskMove(task, { kind: 'review_task', reviewTaskId: review.id });
      await writeTask(linked, task.version, null, null);
      await writeGoal(goalMove(goal, { kind: 'count_task' }), goal.version, null);
      return review;
    },

    async createReworkTask(taskId, sessionId) {
      const task = await requireTask(taskId);
      const goal = await requireGoal(task.goalId);
      const { policy } = await requireConfigured(task.projectId);
      const session = await requireCoordinator(policy, task.projectId, sessionId);
      if (task.verification?.verdict !== 'rework') {
        throw new ApplicationError(
          'TASK_STATE_INVALID',
          'Only a task whose verdict is rework can be reworked.',
          409,
        );
      }
      if (task.reworkCount >= goal.budget.maxReworksPerTask) {
        throw new ApplicationError(
          'TASK_STATE_INVALID',
          'The rework budget for this task is spent.',
          409,
        );
      }
      const stamp = nowIso();
      const rework: Task = {
        id: createId(),
        projectId: task.projectId,
        goalId: task.goalId,
        title: `${task.title} (rework ${String(task.reworkCount + 1)})`.slice(0, 200),
        brief: [
          task.brief,
          `Rework feedback from review: ${task.verification.feedback ?? 'the previous attempt was not accepted.'}`,
          `Previous attempt answered: ${(task.outcome?.answer ?? '').slice(0, ANSWER_CLIP)}`,
        ].join('\n\n'),
        ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
        paths: task.paths,
        matchPaths: task.matchPaths,
        dependsOn: task.dependsOn,
        evidenceRequirements: task.evidenceRequirements,
        timeoutMs: task.timeoutMs,
        ...(task.doneCriteria === undefined ? {} : { doneCriteria: task.doneCriteria }),
        kind: 'work',
        reworkOf: task.id,
        reworkCount: task.reworkCount + 1,
        state: 'ready',
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      await writeTask(
        rework,
        0,
        event(
          'task.rework.created',
          {
            projectId: task.projectId,
            sessionId: session.id,
            ...(task.agentId === undefined ? {} : { agentId: task.agentId }),
          },
          {
            taskId: rework.id,
            goalId: goal.id,
            reworkOf: task.id,
            reworkCount: rework.reworkCount,
          },
        ),
        null,
      );
      const counted = goalMove(goal, { kind: 'count_task', reworks: 1 });
      await writeGoal({ ...counted, taskIds: [...counted.taskIds, rework.id] }, goal.version, null);
      return rework;
    },

    async cancelTask(taskId, actorSessionId, reason) {
      const task = await requireTask(taskId);
      const { policy } = await requireConfigured(task.projectId);
      let by = 'operator';
      if (actorSessionId !== undefined) {
        const session = await options.sessions.get(actorSessionId);
        if (session !== null && isCoordinatorSession(policy, session, task.projectId))
          by = `coordinator:${session.id}`;
        else by = await requireOperator(policy, task.projectId, actorSessionId);
      }
      const cancelled = taskMove(task, { kind: 'cancel' });
      return writeTask(
        cancelled,
        task.version,
        event(
          'task.cancelled',
          { projectId: task.projectId },
          { taskId: task.id, goalId: task.goalId, by, ...(reason === undefined ? {} : { reason }) },
        ),
        null,
      );
    },

    async approveTask(taskId, actorSessionId, note) {
      const task = await requireTask(taskId);
      const { policy } = await requireConfigured(task.projectId);
      const by = await requireOperator(policy, task.projectId, actorSessionId);
      const approved = taskMove(task, {
        kind: 'approve',
        by,
        ...(note === undefined ? {} : { note }),
      });
      const stored = await writeTask(
        approved,
        task.version,
        event(
          'task.approved',
          { projectId: task.projectId },
          { taskId: task.id, goalId: task.goalId, by, ...(note === undefined ? {} : { note }) },
        ),
        null,
      );
      await notify(task.projectId, 'kick', { goalId: task.goalId, taskId: task.id });
      return stored;
    },

    async rejectTask(taskId, actorSessionId, note) {
      const task = await requireTask(taskId);
      const { policy } = await requireConfigured(task.projectId);
      const by = await requireOperator(policy, task.projectId, actorSessionId);
      const rejected = taskMove(task, {
        kind: 'reject',
        by,
        ...(note === undefined ? {} : { note }),
      });
      const stored = await writeTask(
        rejected,
        task.version,
        event(
          'task.rejected',
          { projectId: task.projectId },
          { taskId: task.id, goalId: task.goalId, by, ...(note === undefined ? {} : { note }) },
        ),
        null,
      );
      await notify(task.projectId, 'kick', { goalId: task.goalId, taskId: task.id });
      return stored;
    },

    async completeFromMessage(message) {
      if (
        message.state !== 'responded' &&
        message.state !== 'rejected' &&
        message.state !== 'failed' &&
        message.state !== 'timed_out'
      )
        return null;
      const entry = (await options.repository.listActiveTasks(message.projectId)).find(
        (candidate) => candidate.correlationId === message.correlationId,
      );
      if (entry === undefined) return null;
      const task = await options.repository.getTask(entry.taskId);
      if (task === null || task.state !== 'dispatched') return null;
      return complete(task, message);
    },

    async reconcileOnce() {
      let repaired = 0;
      let completed = 0;
      for (const record of await options.repository.listAutopilot()) {
        for (const entry of await options.repository.listActiveTasks(record.projectId)) {
          const task = await options.repository.getTask(entry.taskId);
          if (task === null) continue;
          if (task.state === 'dispatching' && task.dispatchSourceSessionId !== undefined) {
            // The issuing session's idempotency index first; a re-issue only when it holds nothing.
            const existing = await options.messages.findByIdempotencyKey(
              task.dispatchSourceSessionId,
              `task:${task.id}`,
            );
            if (existing !== null) {
              const dispatched = taskMove(task, {
                kind: 'dispatched',
                correlationId: existing.correlationId,
                targetSessionId: existing.targetSessionId,
              });
              await writeTask(
                dispatched,
                task.version,
                event(
                  'task.dispatched',
                  {
                    projectId: task.projectId,
                    sessionId: task.dispatchSourceSessionId,
                    correlationId: existing.correlationId,
                  },
                  {
                    taskId: task.id,
                    goalId: task.goalId,
                    correlationId: existing.correlationId,
                    targetSessionId: existing.targetSessionId,
                    repaired: true,
                  },
                ),
                activeEntry(dispatched, 'dispatched'),
              );
              repaired += 1;
              continue;
            }
            const source = await options.sessions.get(task.dispatchSourceSessionId);
            if (
              source !== null &&
              source.presence === 'online' &&
              source.status !== 'completed' &&
              source.status !== 'disconnected'
            ) {
              await finishDispatch(task, source.id);
            } else {
              const failed = taskMove(task, {
                kind: 'dispatch_failed',
                reason: 'The coordinator session ended before the dispatch message was created.',
              });
              await writeTask(
                failed,
                task.version,
                event(
                  'task.completed',
                  { projectId: task.projectId },
                  { taskId: task.id, goalId: task.goalId, state: 'failed', repaired: true },
                ),
                null,
              );
            }
            repaired += 1;
            continue;
          }
          if (task.state === 'dispatched' && task.correlationId !== undefined) {
            let message: AgentMessage;
            try {
              message = await options.messages.get(task.correlationId);
            } catch {
              continue;
            }
            if (
              message.state === 'responded' ||
              message.state === 'rejected' ||
              message.state === 'failed' ||
              message.state === 'timed_out'
            ) {
              await complete(task, message);
              completed += 1;
            }
          }
        }
      }
      return { repaired, completed };
    },
  };
}
