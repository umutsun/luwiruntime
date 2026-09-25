import type { AutopilotPolicy, SessionView, Task } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import {
  evaluateDispatch,
  taskMatchPaths,
  type EvaluateDispatchInput,
} from './task-dispatch-policy.js';

const nowMs = Date.parse('2026-09-17T10:00:00.000Z');
const nowIso = new Date(nowMs).toISOString();

const policy: AutopilotPolicy = {
  coordinatorAgentId: 'luwibot',
  workerAgentIds: ['claude-code', 'codex'],
  operatorProxyAgentIds: [],
  protectedPaths: ['AGENTS.md', 'packages/redis'],
  maxInFlight: 2,
  maxDispatchesPerHour: 3,
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
    metadata: { bridge: 'native-headless' },
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  const paths = overrides.paths ?? ['apps/daemon/src/app.ts'];
  return {
    id: 'task-1',
    projectId: 'project-1',
    goalId: 'goal-1',
    title: 'Add the route',
    brief: 'Add it.',
    agentId: 'claude-code',
    paths,
    matchPaths: taskMatchPaths(paths.map((path) => `${path.toLowerCase()}/`)),
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

function input(overrides: Partial<EvaluateDispatchInput> = {}): EvaluateDispatchInput {
  return {
    mode: 'autopilot',
    policy,
    task: task(),
    workers: ['claude-code', 'codex'],
    inFlight: [],
    recentDispatchesMs: [],
    dependencies: [],
    leases: [],
    sessions: [session('worker-1', 'claude-code')],
    nowMs,
    ...overrides,
  };
}

describe('evaluateDispatch', () => {
  it('dispatches to the best-ranked worker session when nothing stands in the way', () => {
    expect(evaluateDispatch(input())).toMatchObject({
      decision: 'dispatch',
      targetSession: { id: 'worker-1' },
    });
  });

  it.each([
    ['mode_off', input({ mode: 'off' })],
    ['task_state', input({ task: task({ state: 'dispatched' }) })],
    ['worker_not_allowed', input({ task: task({ agentId: 'gemini-cli' }) })],
    ['worker_not_allowed', input({ task: task({ agentId: 'luwibot' }), workers: ['luwibot'] })],
    ['dependency_unmet', input({ task: task({ dependsOn: ['task-0'] }), dependencies: [] })],
    [
      'in_flight_limit',
      input({ inFlight: [task({ id: 'a', paths: ['x'] }), task({ id: 'b', paths: ['y'] })] }),
    ],
    ['rate_limit', input({ recentDispatchesMs: [nowMs - 1000, nowMs - 2000, nowMs - 3000] })],
    [
      'path_overlap',
      input({ inFlight: [task({ id: 'a', state: 'dispatched', paths: ['apps/daemon'] })] }),
    ],
    [
      'lease_overlap',
      input({
        leases: [
          { matchPath: 'apps/daemon/', sessionId: 'someone', agentId: 'codex', state: 'held' },
        ],
      }),
    ],
    [
      'worker_unavailable',
      input({ sessions: [session('worker-1', 'claude-code', { status: 'starting' })] }),
    ],
  ] as const)('denies with %s', (reason, evaluation) => {
    expect(evaluateDispatch(evaluation)).toMatchObject({ decision: 'deny', reason });
  });

  it('dispatches a review task to the reviewer even though the reviewer is not a worker', () => {
    const reviewerPolicy: AutopilotPolicy = { ...policy, reviewerAgentId: 'gemini-cli' };
    expect(
      evaluateDispatch(
        input({
          policy: reviewerPolicy,
          task: task({ kind: 'review', agentId: 'gemini-cli' }),
          sessions: [session('reviewer-1', 'gemini-cli')],
        }),
      ),
    ).toMatchObject({ decision: 'dispatch', targetSession: { id: 'reviewer-1' } });
  });

  it('dispatches a read-only review over a leased or in-flight path, and still denies work there', () => {
    const lease = {
      matchPath: 'apps/daemon/',
      sessionId: 'someone',
      agentId: 'claude-code',
      state: 'held',
    } as const;
    const inFlight = [task({ id: 'a', state: 'dispatched', paths: ['apps/daemon'] })];
    const review = input({
      policy: { ...policy, reviewerAgentId: 'gemini-cli' },
      task: task({ kind: 'review', agentId: 'gemini-cli' }),
      sessions: [session('reviewer-1', 'gemini-cli')],
    });
    const dispatched = { decision: 'dispatch', targetSession: { id: 'reviewer-1' } };
    expect(evaluateDispatch({ ...review, leases: [lease] })).toMatchObject(dispatched);
    expect(evaluateDispatch({ ...review, inFlight })).toMatchObject(dispatched);
    expect(evaluateDispatch(input({ leases: [lease] }))).toMatchObject({
      decision: 'deny',
      reason: 'lease_overlap',
    });
    expect(evaluateDispatch(input({ inFlight }))).toMatchObject({
      decision: 'deny',
      reason: 'path_overlap',
    });
  });

  it('denies a review task whose agent is not the configured reviewer', () => {
    const reviewerPolicy: AutopilotPolicy = { ...policy, reviewerAgentId: 'gemini-cli' };
    expect(
      evaluateDispatch(
        input({ policy: reviewerPolicy, task: task({ kind: 'review', agentId: 'claude-code' }) }),
      ),
    ).toMatchObject({ decision: 'deny', reason: 'worker_not_allowed' });
  });

  it('ignores a dispatch outside the hour window and a lease held by the worker itself', () => {
    expect(
      evaluateDispatch(
        input({
          recentDispatchesMs: [nowMs - 3_600_001, nowMs - 3_600_002, nowMs - 3_600_003],
          leases: [
            {
              matchPath: 'apps/daemon/',
              sessionId: 'worker-1',
              agentId: 'claude-code',
              state: 'held',
            },
          ],
        }),
      ),
    ).toMatchObject({ decision: 'dispatch' });
  });

  it('gates every unapproved task in supervised mode, and only protected paths in autopilot', () => {
    expect(evaluateDispatch(input({ mode: 'supervised' }))).toEqual({
      decision: 'gate',
      gate: 'supervised',
    });
    expect(
      evaluateDispatch(input({ mode: 'supervised', task: task({ state: 'approved' }) })),
    ).toMatchObject({
      decision: 'dispatch',
    });
    expect(
      evaluateDispatch(input({ task: task({ paths: ['packages/redis/src/keys.ts'] }) })),
    ).toEqual({
      decision: 'gate',
      gate: 'protected_path',
    });
    expect(
      evaluateDispatch(
        input({ task: task({ paths: ['packages/redis/src/keys.ts'], state: 'approved' }) }),
      ),
    ).toMatchObject({ decision: 'dispatch' });
  });

  it('treats a task with no paths as the whole project: it gates on any protected path and overlaps everything', () => {
    expect(taskMatchPaths([])).toEqual(['']);
    expect(evaluateDispatch(input({ task: task({ paths: [], matchPaths: [''] }) }))).toEqual({
      decision: 'gate',
      gate: 'protected_path',
    });
    expect(
      evaluateDispatch(
        input({
          policy: { ...policy, protectedPaths: [] },
          task: task({ paths: [], matchPaths: [''] }),
          inFlight: [task({ id: 'a', state: 'dispatched', paths: ['docs/x.md'] })],
        }),
      ),
    ).toMatchObject({ decision: 'deny', reason: 'path_overlap' });
  });

  it('requires a dependency to be done and accepted, not merely done', () => {
    const dependency = task({ id: 'task-0', state: 'done', verification: { checks: [] } });
    expect(
      evaluateDispatch(
        input({ task: task({ dependsOn: ['task-0'] }), dependencies: [dependency] }),
      ),
    ).toMatchObject({ decision: 'deny', reason: 'dependency_unmet' });
    expect(
      evaluateDispatch(
        input({
          task: task({ dependsOn: ['task-0'] }),
          dependencies: [{ ...dependency, verification: { checks: [], verdict: 'accept' } }],
        }),
      ),
    ).toMatchObject({ decision: 'dispatch' });
  });
});
