import { createHash } from 'node:crypto';

import type {
  AutopilotStatusResponse,
  EscalationReason,
  Goal,
  GoalPlanRequest,
  GoalTransitionRequest,
  InboxClaimResponse,
  JudgmentKind,
  SessionStatusTarget,
  SessionView,
  Task,
  TaskDispatchResponse,
  TaskVerdictRequest,
  WorkLease,
} from '@luwi/protocol';
import {
  assembleJudgmentContext,
  effectiveWorkers,
  frameJudgment,
  parseJudgment,
  planCycle,
  validatePlannedTasks,
  type CycleAction,
  type JudgmentContextInput,
  type ParsedJudgment,
} from '@luwi/runtime';

import type { BrainAdapter } from './brain-adapter.js';

/**
 * The orchestrator (ADR 0035): a LUWI-owned loop around a pluggable brain.
 *
 * Every wake — an inbox item or the tick — runs one cycle: perceive the goals,
 * tasks and sessions of one project, compute the next actions with the pure
 * `planCycle`, apply them through the daemon's gated routes. The brain is asked
 * bounded questions and never acts. The loop keeps no private state, so a
 * restarted bridge resumes from the store.
 */

export interface OrchestratorDaemonClient {
  getAutopilot(projectId: string): Promise<AutopilotStatusResponse>;
  listProjectAgentBindings(projectId: string): Promise<{ agentId: string; enabled: boolean }[]>;
  listGoals(projectId: string): Promise<Goal[]>;
  listTasks(projectId: string): Promise<Task[]>;
  listSessions(projectId: string): Promise<SessionView[]>;
  listLeases(projectId: string): Promise<WorkLease[]>;
  transitionGoal(goalId: string, request: GoalTransitionRequest): Promise<Goal>;
  submitPlan(goalId: string, request: GoalPlanRequest): Promise<Goal>;
  dispatchTask(taskId: string, sessionId: string): Promise<TaskDispatchResponse>;
  recordVerdict(taskId: string, request: TaskVerdictRequest): Promise<Task>;
  createReviewTask(taskId: string, sessionId: string): Promise<Task>;
  createReworkTask(taskId: string, sessionId: string): Promise<Task>;
  claimInbox(
    sessionId: string,
    request: { bridgeInstanceId: string; limit: number; blockMs: number; minIdleMs: number },
  ): Promise<InboxClaimResponse>;
  setSessionStatus(sessionId: string, status: SessionStatusTarget): Promise<void>;
}

export type OrchestratorBridgeOptions = {
  daemon: OrchestratorDaemonClient;
  brain: BrainAdapter;
  projectId: string;
  currentSessionId: () => string | undefined;
  bridgeInstanceId: string;
  claimBlockMs: number;
  tickMs: number;
  judgmentTimeoutMs: number;
  now?: () => number;
  report?: (line: Record<string, unknown>) => void;
};

export interface OrchestratorBridge {
  /** Claims the inbox once; runs a cycle when something arrived or the tick elapsed. Returns actions taken. */
  pollOnce(): Promise<number>;
  cycleOnce(): Promise<CycleAction[]>;
  stop(): Promise<void>;
}

const BRAIN_FAILURES_BEFORE_ESCALATION = 3;

export function createOrchestratorBridge(options: OrchestratorBridgeOptions): OrchestratorBridge {
  const now = options.now ?? Date.now;
  const seenSessions = new Set<string>();
  const judgmentsAt: number[] = [];
  const brainFailures = new Map<string, number>();
  let lastCycleAt = 0;
  let stopping = false;

  const report = (line: Record<string, unknown>): void => {
    options.report?.(line);
  };

  const session = (): string => {
    const id = options.currentSessionId();
    if (id === undefined) throw new Error('The orchestrator has no bound session.');
    return id;
  };

  const countJudgment = async (
    goal: Goal,
    kind: JudgmentKind,
    detail: {
      invalid: boolean;
      confidence?: number;
      summary?: string;
      promptSha256: string;
      ms: number;
    },
  ): Promise<void> => {
    judgmentsAt.push(now());
    await options.daemon.transitionGoal(goal.id, {
      transition: 'count_judgment',
      sessionId: session(),
      kind,
      invalid: detail.invalid,
      brain: options.brain.name,
      ...(detail.confidence === undefined ? {} : { confidence: detail.confidence }),
      ...(detail.summary === undefined ? {} : { summary: detail.summary.slice(0, 500) }),
      promptSha256: detail.promptSha256,
      ms: detail.ms,
    });
  };

  const escalate = async (
    goal: Goal,
    reason: EscalationReason,
    question: string,
    taskId?: string,
  ): Promise<void> => {
    await options.daemon.transitionGoal(goal.id, {
      transition: 'escalate',
      sessionId: session(),
      escalation: {
        reason,
        question: question.slice(0, 4000),
        ...(taskId === undefined ? {} : { taskId }),
      },
    });
    report({ goalId: goal.id, action: 'escalate', reason });
  };

  /**
   * One judgment with the one-repair-round rule: an invalid answer goes back
   * once with the exact refusals; a second failure escalates `brain_invalid`.
   * A brain that cannot be reached is retried on later wakes, then escalated.
   */
  const judge = async (
    kind: JudgmentKind,
    goal: Goal,
    context: Omit<JudgmentContextInput, 'kind' | 'repairErrors' | 'nowIso'>,
    policyCheck: (parsed: ParsedJudgment & { ok: true }) => string[],
  ): Promise<(ParsedJudgment & { ok: true }) | undefined> => {
    let repairErrors: string[] | undefined;
    for (let round = 0; round < 2; round += 1) {
      const assembled = assembleJudgmentContext({
        ...context,
        kind,
        ...(repairErrors === undefined ? {} : { repairErrors }),
        nowIso: new Date(now()).toISOString(),
      });
      const prompt = frameJudgment(kind, assembled);
      const promptSha256 = createHash('sha256').update(prompt).digest('hex');
      let answer: { text: string; ms: number };
      try {
        answer = await options.brain.judge(prompt, { timeoutMs: options.judgmentTimeoutMs });
      } catch (error) {
        const failures = (brainFailures.get(goal.id) ?? 0) + 1;
        brainFailures.set(goal.id, failures);
        report({
          goalId: goal.id,
          action: 'judge',
          kind,
          brain: options.brain.name,
          error: error instanceof Error ? error.message : String(error),
          failures,
        });
        if (failures >= BRAIN_FAILURES_BEFORE_ESCALATION) {
          brainFailures.delete(goal.id);
          await escalate(
            goal,
            'brain_unavailable',
            `The brain (${options.brain.name}) failed ${String(failures)} times in a row: ${error instanceof Error ? error.message : String(error)}. Answer to retry, or abandon the goal.`,
          );
        }
        return undefined;
      }
      brainFailures.delete(goal.id);
      const parsed = parseJudgment(kind, answer.text);
      const errors = parsed.ok ? policyCheck(parsed) : parsed.errors;
      if (parsed.ok && errors.length === 0) {
        const confidence =
          'confidence' in parsed.decision.decision
            ? parsed.decision.decision.confidence
            : undefined;
        await countJudgment(goal, kind, {
          invalid: false,
          ...(confidence === undefined ? {} : { confidence }),
          promptSha256,
          ms: answer.ms,
        });
        report({
          goalId: goal.id,
          action: 'judge',
          kind,
          brain: options.brain.name,
          ms: answer.ms,
          ...(confidence === undefined ? {} : { confidence }),
        });
        return parsed;
      }
      await countJudgment(goal, kind, {
        invalid: true,
        summary: errors.join(' | '),
        promptSha256,
        ms: answer.ms,
      });
      report({
        goalId: goal.id,
        action: 'judge',
        kind,
        brain: options.brain.name,
        invalid: true,
        round: round + 1,
        errors: errors.slice(0, 5),
      });
      repairErrors = errors;
    }
    await escalate(
      goal,
      'brain_invalid',
      `The brain answered the ${kind} question invalidly twice: ${(repairErrors ?? []).slice(0, 3).join('; ')}. Answer with guidance, or abandon the goal.`,
    );
    return undefined;
  };

  const perceive = async () => {
    const [status, bindings, goals, tasks, sessions, leases] = await Promise.all([
      options.daemon.getAutopilot(options.projectId),
      options.daemon.listProjectAgentBindings(options.projectId),
      options.daemon.listGoals(options.projectId),
      options.daemon.listTasks(options.projectId),
      options.daemon.listSessions(options.projectId),
      options.daemon.listLeases(options.projectId),
    ]);
    return { status, bindings, goals, tasks, sessions, leases };
  };

  const execute = async (
    action: CycleAction,
    view: Awaited<ReturnType<typeof perceive>>,
    policy: NonNullable<NonNullable<AutopilotStatusResponse['record']>['policy']>,
  ): Promise<void> => {
    const goal = view.goals.find((candidate) => candidate.id === action.goalId);
    if (goal === undefined) return;
    const workers = effectiveWorkers(policy, view.bindings);
    const goalTasks = view.tasks.filter((task) => task.goalId === goal.id);
    const baseContext = {
      goal,
      tasks: goalTasks,
      policy,
      workers,
      sessions: view.sessions,
      retrospectives: view.goals
        .filter((candidate) => candidate.retrospective !== undefined)
        .map((candidate) => candidate.retrospective as NonNullable<Goal['retrospective']>)
        .slice(0, policy.retrospectives),
      leases: view.leases.map((lease) => ({
        path: lease.path,
        agentId: lease.agentId,
        sessionId: lease.sessionId,
      })),
    };
    switch (action.type) {
      case 'start_goal':
        await options.daemon.transitionGoal(goal.id, { transition: 'start', sessionId: session() });
        report({ goalId: goal.id, action: 'start' });
        return;
      case 'dispatch': {
        const result = await options.daemon.dispatchTask(action.taskId, session());
        report({
          goalId: goal.id,
          action: 'dispatch',
          taskId: action.taskId,
          outcome: result.outcome,
          ...(result.outcome === 'denied' ? { reason: result.reason } : {}),
          ...(result.outcome === 'gated' ? { gate: result.gate } : {}),
        });
        return;
      }
      case 'create_review_task': {
        const review = await options.daemon.createReviewTask(action.taskId, session());
        report({
          goalId: goal.id,
          action: 'review_task',
          taskId: action.taskId,
          reviewTaskId: review.id,
        });
        return;
      }
      case 'rework': {
        const rework = await options.daemon.createReworkTask(action.taskId, session());
        report({
          goalId: goal.id,
          action: 'rework',
          taskId: action.taskId,
          reworkTaskId: rework.id,
        });
        return;
      }
      case 'escalate':
        await escalate(goal, action.reason, action.question, action.taskId);
        return;
      case 'achieve':
        await options.daemon.transitionGoal(goal.id, {
          transition: 'achieve',
          sessionId: session(),
        });
        report({ goalId: goal.id, action: 'achieve' });
        return;
      case 'fail':
        await options.daemon.transitionGoal(goal.id, {
          transition: 'fail',
          sessionId: session(),
          reason: action.reason,
        });
        report({ goalId: goal.id, action: 'fail', reason: action.reason });
        return;
      case 'judge':
        break;
    }
    if (action.kind === 'plan') {
      const parsed = await judge('plan', goal, baseContext, (answer) =>
        answer.decision.kind === 'plan'
          ? validatePlannedTasks(answer.decision.decision.tasks, {
              workers,
              maxTasks: goal.budget.maxTasks,
              alreadyPlanned: goal.usage.tasks,
            })
          : ['Not a plan decision.'],
      );
      if (parsed === undefined || parsed.decision.kind !== 'plan') return;
      const decision = parsed.decision.decision;
      if (decision.confidence < goal.budget.minConfidence) {
        await escalate(
          goal,
          'low_confidence',
          `The plan's confidence (${decision.confidence.toFixed(2)}) is below the goal's ${goal.budget.minConfidence.toFixed(2)}: ${decision.rationale || 'no rationale given'}. Answer with guidance, or abandon the goal.`,
        );
        return;
      }
      await options.daemon.submitPlan(goal.id, {
        sessionId: session(),
        tasks: decision.tasks,
        rationale: decision.rationale,
        confidence: decision.confidence,
      });
      report({
        goalId: goal.id,
        action: 'plan',
        tasks: decision.tasks.length,
        confidence: decision.confidence,
      });
      return;
    }
    if (action.kind === 'replan') {
      const live = goalTasks.filter(
        (task) =>
          task.state === 'ready' ||
          task.state === 'approved' ||
          task.state === 'awaiting_approval' ||
          task.state === 'dispatching' ||
          task.state === 'dispatched',
      );
      const parsed = await judge('replan', goal, baseContext, (answer) => {
        if (answer.decision.kind !== 'replan') return ['Not a replan decision.'];
        const errors = validatePlannedTasks(answer.decision.decision.add, {
          workers,
          maxTasks: goal.budget.maxTasks,
          alreadyPlanned: goal.usage.tasks - (live.length - answer.decision.decision.keep.length),
        });
        for (const id of answer.decision.decision.keep) {
          if (!live.some((task) => task.id === id))
            errors.push(`keep names ${id}, which is not a live task of this goal.`);
        }
        return errors;
      });
      if (parsed === undefined || parsed.decision.kind !== 'replan') return;
      const decision = parsed.decision.decision;
      if (decision.giveUp !== undefined && decision.giveUp !== '') {
        await options.daemon.transitionGoal(goal.id, {
          transition: 'fail',
          sessionId: session(),
          reason: decision.giveUp.slice(0, 1000),
        });
        report({ goalId: goal.id, action: 'fail', reason: 'brain gave up' });
        return;
      }
      if (decision.confidence < goal.budget.minConfidence) {
        await escalate(
          goal,
          'low_confidence',
          `The replan's confidence (${decision.confidence.toFixed(2)}) is below the goal's ${goal.budget.minConfidence.toFixed(2)}: ${decision.rationale || 'no rationale given'}. Answer with guidance, or abandon the goal.`,
        );
        return;
      }
      if (goal.usage.replans >= goal.budget.maxReplans) {
        await escalate(
          goal,
          'budget_exhausted',
          `The replan budget (${String(goal.budget.maxReplans)}) is spent. Answer with guidance to allow one more, or abandon the goal.`,
        );
        return;
      }
      await options.daemon.submitPlan(goal.id, {
        sessionId: session(),
        tasks: decision.add,
        keep: decision.keep,
        rationale: decision.rationale,
        confidence: decision.confidence,
      });
      report({
        goalId: goal.id,
        action: 'replan',
        kept: decision.keep.length,
        added: decision.add.length,
      });
      return;
    }
    if (action.kind === 'review') {
      const task = goalTasks.find((candidate) => candidate.id === action.taskId);
      if (task === undefined) return;
      const reviewTask =
        task.verification?.reviewTaskId === undefined
          ? undefined
          : view.tasks.find((candidate) => candidate.id === task.verification?.reviewTaskId);
      const parsed = await judge(
        'review',
        goal,
        {
          ...baseContext,
          reviewTask: task,
          ...(reviewTask?.outcome === undefined
            ? {}
            : {
                reviewAnswer: {
                  ...(reviewTask.outcome.status === undefined
                    ? {}
                    : { status: reviewTask.outcome.status }),
                  ...(reviewTask.outcome.answer === undefined
                    ? {}
                    : { answer: reviewTask.outcome.answer }),
                },
              }),
        },
        (answer) => (answer.decision.kind === 'review' ? [] : ['Not a review decision.']),
      );
      if (parsed === undefined || parsed.decision.kind !== 'review') return;
      const decision = parsed.decision.decision;
      const verdict =
        decision.confidence < goal.budget.minConfidence ? 'escalate' : decision.verdict;
      await options.daemon.recordVerdict(task.id, {
        sessionId: session(),
        verdict,
        feedback:
          verdict === decision.verdict
            ? decision.feedback
            : `Low confidence (${decision.confidence.toFixed(2)}): ${decision.feedback}`,
        confidence: decision.confidence,
      });
      report({ goalId: goal.id, action: 'verdict', taskId: task.id, verdict });
      return;
    }
    if (action.kind === 'summarize') {
      const parsed = await judge('summarize', goal, baseContext, (answer) =>
        answer.decision.kind === 'summarize' ? [] : ['Not a summarize decision.'],
      );
      if (parsed === undefined || parsed.decision.kind !== 'summarize') return;
      const decision = parsed.decision.decision;
      await options.daemon.transitionGoal(goal.id, {
        transition: 'retrospective',
        sessionId: session(),
        retrospective: {
          summary: decision.summary.slice(0, 8192),
          workerNotes: decision.workerNotes,
        },
      });
      report({ goalId: goal.id, action: 'retrospective' });
    }
  };

  const cycleOnce = async (): Promise<CycleAction[]> => {
    lastCycleAt = now();
    const view = await perceive();
    const record = view.status.record;
    if (record === null || record.policy === null) {
      report({ action: 'idle', reason: 'no autopilot policy' });
      return [];
    }
    const windowStart = now() - 3_600_000;
    while (judgmentsAt.length > 0 && (judgmentsAt[0] as number) < windowStart) judgmentsAt.shift();
    const actions = planCycle({
      nowMs: now(),
      mode: record.mode,
      policy: record.policy,
      goals: view.goals,
      tasks: view.tasks,
      judgmentsInWindow: judgmentsAt.length,
    });
    for (const action of actions) {
      if (stopping) break;
      try {
        await execute(action, view, record.policy);
      } catch (error) {
        report({
          action: action.type,
          goalId: action.goalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return actions;
  };

  return {
    async pollOnce() {
      const current = options.currentSessionId();
      if (current === undefined) return 0;
      if (!seenSessions.has(current)) {
        await options.daemon.setSessionStatus(current, 'idle');
        seenSessions.add(current);
      }
      const claimed = await options.daemon.claimInbox(current, {
        bridgeInstanceId: options.bridgeInstanceId,
        limit: 10,
        blockMs: options.claimBlockMs,
        minIdleMs: 15_000,
      });
      for (const item of claimed.items) {
        report({
          wake: item.itemKind,
          ...(item.itemKind === 'notice' ? { notice: item.payload.kind } : {}),
        });
      }
      if (stopping) return 0;
      if (claimed.items.length === 0 && now() - lastCycleAt < options.tickMs) return 0;
      const actions = await cycleOnce();
      return actions.length;
    },
    cycleOnce,
    async stop() {
      stopping = true;
    },
  };
}
