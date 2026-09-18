import { goalCollectionSchema, taskCollectionSchema } from '@luwi/protocol/browser';
import type { z } from 'zod';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

type Goal = z.infer<typeof goalCollectionSchema>['goals'][number];
type Task = z.infer<typeof taskCollectionSchema>['tasks'][number];

export type FlowTask = {
  id: string;
  kind: Task['kind'];
  agentId: string | undefined;
  state: Task['state'];
  verdict: NonNullable<Task['verification']>['verdict'];
};
export type FlowGoal = {
  id: string;
  title: string;
  state: Goal['state'];
  tasks: FlowTask[];
};
export type AutopilotFlow = { goals: FlowGoal[]; more: number };

const GOAL_TERMINAL = new Set<Goal['state']>(['achieved', 'failed', 'abandoned']);
const MAX_GOALS = 4;

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
  const goals: FlowGoal[] = active.slice(0, MAX_GOALS).map((goal) => ({
    id: goal.id,
    title: goal.title,
    state: goal.state,
    tasks: goal.taskIds
      .map((id) => tasksById.get(id))
      .filter((task): task is Task => task !== undefined)
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        agentId: task.agentId,
        state: task.state,
        verdict: task.verification?.verdict,
      })),
  }));
  return { state: 'ready', data: { goals, more: Math.max(0, active.length - goals.length) } };
}
