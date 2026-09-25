import { goalCollectionSchema, taskCollectionSchema } from '@luwi/protocol/browser';
import type { z } from 'zod';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

type Goal = z.infer<typeof goalCollectionSchema>['goals'][number];
type Task = z.infer<typeof taskCollectionSchema>['tasks'][number];

export type FlowTask = {
  id: string;
  kind: Task['kind'];
  title: string;
  brief: string;
  paths: string[];
  doneCriteria?: string;
  agentId: string | undefined;
  state: Task['state'];
  verdict: NonNullable<Task['verification']>['verdict'];
  /**
   * The last refused dispatch, so a task that waits says why rather than looking idle.
   * Absent when the task was approved, dispatched or requeued after it: the daemon
   * never clears the record, so an older refusal is history, not the current reason.
   */
  lastDenial?: { reason: string; detail: string; at: string };
};
export type FlowGoal = {
  id: string;
  title: string;
  /** What "done" means, for context under the title in the cockpit. */
  objective?: string;
  /** What the goal counts as achieved, so the cockpit can show it beside the objective. */
  acceptanceCriteria: string[];
  state: Goal['state'];
  tasks: FlowTask[];
  /** The blocked-goal escalation question, when the goal is awaiting an operator answer. */
  question?: string;
};
export type AutopilotFlow = { goals: FlowGoal[]; more: number };

const GOAL_TERMINAL = new Set<Goal['state']>(['achieved', 'failed', 'abandoned']);
const MAX_GOALS = 4;

/** The task's last refusal, unless a later approval, dispatch or requeue superseded it. */
function currentDenial(task: Task): FlowTask['lastDenial'] {
  const denial = task.lastDenial;
  if (denial === undefined) return undefined;
  const deniedMs = Date.parse(denial.at);
  const superseded = [task.approval?.at, task.dispatchedAt, task.lastRedispatch?.at].some(
    (at) => at !== undefined && Date.parse(at) > deniedMs,
  );
  return superseded ? undefined : { reason: denial.reason, detail: denial.detail, at: denial.at };
}

/**
 * One project's autopilot flow (ADR 0035): the active goals and, under each, its
 * tasks in plan order with their state and the brain's verdict. Read-only — the
 * operator still acts through the CLI/MCP; this only makes the loop visible, the
 * way the ticker shows `goal.*`/`task.*` but without the scroll.
 *
 * Both reads share the focus's abort signal and run together; a failure in
 * either is a single `unavailable`, mirroring `loadAutopilotStatus`. Terminal
 * goals are dropped so the panel shows what is in flight, and the plan's
 * `taskIds` order is kept so a plan reads top to bottom.
 */
export async function loadAutopilotFlow(
  client: DaemonClient,
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<AutopilotFlow>> {
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const [goalsResult, tasksResult] = await Promise.all([
    client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/goals`,
      goalCollectionSchema,
      signal,
    ),
    client.get(
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`,
      taskCollectionSchema,
      signal,
    ),
  ]);
  if (goalsResult.state !== 'ready' || tasksResult.state !== 'ready') {
    return { state: 'unavailable' };
  }

  const tasksById = new Map(tasksResult.data.tasks.map((task) => [task.id, task]));
  const active = goalsResult.data.goals.filter((goal) => !GOAL_TERMINAL.has(goal.state));
  // The plan in its own order, then any task the runtime created for this goal outside
  // `taskIds` (a review task is never added to the plan) oldest first — otherwise a
  // review gated for approval never reaches the cockpit and nobody can approve it.
  const goalTasks = (goal: Goal): Task[] => {
    const planned = goal.taskIds
      .map((id) => tasksById.get(id))
      .filter((task): task is Task => task !== undefined);
    const inPlan = new Set(goal.taskIds);
    const extra = tasksResult.data.tasks
      .filter((task) => task.goalId === goal.id && !inPlan.has(task.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return [...planned, ...extra];
  };
  const goals: FlowGoal[] = active.slice(0, MAX_GOALS).map((goal) => ({
    id: goal.id,
    title: goal.title,
    objective: goal.objective,
    acceptanceCriteria: goal.acceptanceCriteria,
    state: goal.state,
    ...(goal.escalation === undefined ? {} : { question: goal.escalation.question }),
    tasks: goalTasks(goal).map((task) => {
      const lastDenial = currentDenial(task);
      return {
        id: task.id,
        kind: task.kind,
        title: task.title,
        brief: task.brief,
        paths: task.paths,
        ...(task.doneCriteria === undefined ? {} : { doneCriteria: task.doneCriteria }),
        agentId: task.agentId,
        state: task.state,
        verdict: task.verification?.verdict,
        ...(lastDenial === undefined ? {} : { lastDenial }),
      };
    }),
  }));
  return { state: 'ready', data: { goals, more: Math.max(0, active.length - goals.length) } };
}
