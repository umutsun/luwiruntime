import type { AutopilotPolicy, Goal, Task } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import {
  assembleJudgmentContext,
  frameJudgment,
  parseJudgment,
  validatePlannedTasks,
} from './judgment.js';

const nowIso = '2026-09-22T10:00:00.000Z';

const policy: AutopilotPolicy = {
  coordinatorAgentId: 'luwibot',
  workerAgentIds: ['claude-code', 'antigravity'],
  reviewerAgentId: 'codex',
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

const goal: Goal = {
  id: 'goal-1',
  projectId: 'project-1',
  title: 'Ship it',
  objective: 'Ship it.',
  acceptanceCriteria: [],
  createdBy: { kind: 'operator' },
  budget: policy.goalDefaults,
  state: 'planning',
  planVersion: 1,
  taskIds: [],
  usage: {
    tasks: 0,
    reworks: 0,
    replans: 0,
    judgments: 0,
    invalidJudgments: 0,
    startedAt: nowIso,
  },
  version: 1,
  createdAt: nowIso,
  updatedAt: nowIso,
};

const contextInput = {
  kind: 'plan' as const,
  goal,
  tasks: [],
  policy,
  workers: ['claude-code', 'antigravity'],
  sessions: [],
  retrospectives: [],
  leases: [],
  nowIso,
};

describe('parseJudgment', () => {
  it('accepts a bare decision object, a wrapped one, and a fenced one', () => {
    const bare = parseJudgment('review', '{"verdict":"accept","feedback":"fine","confidence":0.9}');
    expect(bare).toMatchObject({
      ok: true,
      decision: { kind: 'review', decision: { verdict: 'accept' } },
    });
    const wrapped = parseJudgment(
      'review',
      'Sure:\n```json\n{"kind":"review","decision":{"verdict":"rework","feedback":"add tests","confidence":0.7}}\n```',
    );
    expect(wrapped).toMatchObject({ ok: true, decision: { decision: { verdict: 'rework' } } });
  });

  it('reports the exact refusals for an invalid answer, and a kind mismatch', () => {
    expect(parseJudgment('plan', 'no json here')).toEqual({
      ok: false,
      errors: ['The answer contains no JSON object.'],
    });
    const invalid = parseJudgment('plan', '{"tasks":[],"confidence":2}');
    expect(invalid.ok).toBe(false);
    expect((invalid as { errors: string[] }).errors.length).toBeGreaterThan(0);
    expect(
      parseJudgment('plan', '{"kind":"review","decision":{"verdict":"accept","confidence":1}}'),
    ).toMatchObject({
      ok: false,
      errors: ['Expected a plan decision, got review.'],
    });
  });

  it('extracts the first balanced object even when braces appear inside strings', () => {
    const result = parseJudgment(
      'summarize',
      'Result: {"summary":"used } and { inside","workerNotes":{}} trailing',
    );
    expect(result).toMatchObject({
      ok: true,
      decision: { decision: { summary: 'used } and { inside' } },
    });
  });

  it('strips an unknown per-task key the brain hallucinates instead of rejecting the plan', () => {
    // Live: the brain kept adding a per-task `kind` field, tripping the strict
    // task schema and blocking every goal with `Unrecognized key: "kind"`.
    const result = parseJudgment(
      'plan',
      '{"kind":"plan","decision":{"tasks":[{"title":"t","brief":"b","agentId":"claude-code","kind":"work"}],"confidence":0.8}}',
    );
    expect(result.ok).toBe(true);
    const task = (
      result as { ok: true; decision: { decision: { tasks: Record<string, unknown>[] } } }
    ).decision.decision.tasks[0];
    expect(task).toMatchObject({ title: 't', brief: 'b', agentId: 'claude-code' });
    expect(task).not.toHaveProperty('kind');
  });

  it('still rejects a task missing a required field', () => {
    const result = parseJudgment(
      'plan',
      '{"kind":"plan","decision":{"tasks":[{"brief":"b","agentId":"claude-code"}],"confidence":0.8}}',
    );
    expect(result.ok).toBe(false);
  });

  it('defaults a missing confidence on a review judgment instead of blocking the goal', () => {
    // Live: the DeepSeek brain kept omitting `confidence`, blocking goals with
    // `brain_invalid`. A missing confidence should default, not fail — the
    // verdict is the decision that matters.
    const result = parseJudgment(
      'review',
      '{"kind":"review","decision":{"verdict":"accept","feedback":"ok"}}',
    );
    expect(result.ok).toBe(true);
    const d = (
      result as { ok: true; decision: { decision: { verdict: string; confidence: number } } }
    ).decision.decision;
    expect(d.verdict).toBe('accept');
    expect(typeof d.confidence).toBe('number');
  });

  it('defaults a missing confidence on a plan judgment', () => {
    const result = parseJudgment(
      'plan',
      '{"kind":"plan","decision":{"tasks":[{"title":"t","brief":"b","agentId":"claude-code"}]}}',
    );
    expect(result.ok).toBe(true);
  });
});

describe('validatePlannedTasks', () => {
  it('refuses unknown workers, forward dependencies and an over-budget plan', () => {
    const errors = validatePlannedTasks(
      [
        {
          title: 'a',
          brief: 'a',
          agentId: 'gemini-cli',
          paths: [],
          dependsOn: [1],
          evidenceRequirements: [],
        },
        {
          title: 'b',
          brief: 'b',
          agentId: 'codex',
          paths: [],
          dependsOn: [0],
          evidenceRequirements: [],
        },
      ],
      { workers: ['codex'], maxTasks: 1, alreadyPlanned: 0 },
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('budget');
    expect(errors[1]).toContain('gemini-cli');
    expect(errors[2]).toContain('not earlier');
  });
});

describe('frameJudgment', () => {
  it('keeps the framing fixed and puts the context last', () => {
    const text = frameJudgment('plan', { goal: { id: 'g' } });
    expect(text.startsWith('LUWI autopilot judgment: plan.')).toBe(true);
    expect(text).toContain('you do not act');
    expect(text.endsWith('CONTEXT:\n\n{"goal":{"id":"g"}}')).toBe(true);
  });

  it('instructs the brain to route each task by the worker lane, not default to one worker', () => {
    const text = frameJudgment('plan', {});
    expect(text).toContain('policy.workerRoles');
    expect(text).toContain('lane');
    expect(text).toContain('do not default every task to one worker');
  });
});

describe('assembleJudgmentContext workerRoles', () => {
  it('surfaces each worker lane so the brain can route by fit', () => {
    const context = assembleJudgmentContext({
      ...contextInput,
      workerRoles: {
        'claude-code': { role: 'backend/contracts/DB', flowRoles: ['implementer'] },
        antigravity: { role: 'mobile/Flutter' },
      },
    });
    expect(context['policy']).toMatchObject({
      workerRoles: {
        'claude-code': { role: 'backend/contracts/DB', flowRoles: ['implementer'] },
        antigravity: { role: 'mobile/Flutter' },
      },
    });
  });

  it('omits workerRoles entirely when no worker declares a lane', () => {
    const context = assembleJudgmentContext(contextInput);
    expect(context['policy']).not.toHaveProperty('workerRoles');
  });
});

describe('assembleJudgmentContext size budget', () => {
  // A native brain takes its prompt on the command line, which Windows caps at
  // 32 767 characters: a bigger context never starts the process at all
  // (measured: every summarize of an 8-task goal failed with AGENT_SPAWN_FAILED).
  const bigTask = (index: number): Task => ({
    id: `task-${String(index)}`,
    projectId: 'project-1',
    goalId: 'goal-1',
    title: `Task ${String(index)} `.padEnd(200, 'x'),
    brief: 'Do it.',
    agentId: 'claude-code',
    paths: Array.from(
      { length: 20 },
      (_, path) => `apps/area-${String(path)}/module-${String(index)}.ts`,
    ),
    matchPaths: [],
    dependsOn: [],
    evidenceRequirements: [],
    timeoutMs: 600_000,
    kind: 'work',
    reworkCount: 0,
    state: 'done',
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const tasks = Array.from({ length: 120 }, (_, index) => bigTask(index));

  it('keeps the context within the byte budget it is given', () => {
    const context = assembleJudgmentContext({
      ...contextInput,
      kind: 'summarize',
      tasks,
      maxBytes: 20_000,
    });
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(20_000);
  });

  it('says how many tasks it left out, and keeps the most recent ones', () => {
    const context = assembleJudgmentContext({
      ...contextInput,
      kind: 'summarize',
      tasks,
      maxBytes: 20_000,
    });
    const kept = context['tasks'] as { id: string }[];
    expect(context['tasksOmitted']).toBe(120 - kept.length);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)?.id).toBe('task-119');
  });

  it('leaves a context that already fits untouched', () => {
    const context = assembleJudgmentContext({ ...contextInput, maxBytes: 20_000 });
    expect(context).not.toHaveProperty('tasksOmitted');
  });
});
