import type { Task } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { applyTaskTransition } from './task-state.js';

const now = '2026-09-17T10:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    goalId: 'goal-1',
    title: 'Add the route',
    brief: 'Add the route and a test.',
    agentId: 'claude-code',
    paths: ['apps/daemon/src/app.ts'],
    matchPaths: ['apps/daemon/src/app.ts/'],
    dependsOn: [],
    evidenceRequirements: [],
    timeoutMs: 600_000,
    kind: 'work',
    reworkCount: 0,
    state: 'ready',
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('applyTaskTransition', () => {
  it('walks the happy path ready → dispatching → dispatched → done and bumps the version each step', () => {
    const dispatching = applyTaskTransition(
      task(),
      { kind: 'dispatching', sourceSessionId: 'coord' },
      now,
    );
    expect(dispatching.status).toBe('ok');
    const dispatched = applyTaskTransition(
      (dispatching as { task: Task }).task,
      { kind: 'dispatched', correlationId: 'corr-1', targetSessionId: 'worker-1' },
      now,
    );
    expect(dispatched.status).toBe('ok');
    const done = applyTaskTransition(
      (dispatched as { task: Task }).task,
      {
        kind: 'complete',
        outcome: {
          messageState: 'responded',
          status: 'answered',
          evidenceCount: 0,
          evidenceTypes: [],
        },
        checks: [],
      },
      now,
    );
    expect(done.status).toBe('ok');
    const final = (done as { task: Task }).task;
    expect(final).toMatchObject({
      state: 'done',
      version: 4,
      correlationId: 'corr-1',
      dispatchSourceSessionId: 'coord',
    });
  });

  it('completes as failed when the message ended in anything but responded', () => {
    const result = applyTaskTransition(
      task({ state: 'dispatched' }),
      {
        kind: 'complete',
        outcome: { messageState: 'timed_out', evidenceCount: 0, evidenceTypes: [] },
        checks: [],
      },
      now,
    );
    expect(result).toMatchObject({ status: 'ok', task: { state: 'failed' } });
  });

  it('gates a ready task and returns it to ready on an edit, because the operator approved a brief, not a slot', () => {
    const gated = applyTaskTransition(task(), { kind: 'gate', gate: 'supervised' }, now);
    expect(gated).toMatchObject({
      status: 'ok',
      task: { state: 'awaiting_approval', gate: 'supervised' },
    });
    const edited = applyTaskTransition(
      (gated as { task: Task }).task,
      { kind: 'update', fields: { brief: 'Something else.' } },
      now,
    );
    expect(edited).toMatchObject({
      status: 'ok',
      task: { state: 'ready', brief: 'Something else.' },
    });
    expect((edited as { task: Task }).task.gate).toBeUndefined();
  });

  it('refuses to cancel a dispatched task: the worker owns it until its deadline', () => {
    expect(
      applyTaskTransition(task({ state: 'dispatched' }), { kind: 'cancel' }, now),
    ).toMatchObject({
      status: 'invalid',
      from: 'dispatched',
    });
  });

  it('records one verdict only', () => {
    const done = task({ state: 'done', verification: { checks: [] } });
    const first = applyTaskTransition(
      done,
      { kind: 'verdict', verdict: 'rework', feedback: 'tests missing' },
      now,
    );
    expect(first).toMatchObject({
      status: 'ok',
      task: { verification: { verdict: 'rework', feedback: 'tests missing' } },
    });
    expect(
      applyTaskTransition(
        (first as { task: Task }).task,
        { kind: 'verdict', verdict: 'accept' },
        now,
      ),
    ).toMatchObject({ status: 'invalid' });
  });

  it('refuses every move out of a terminal state', () => {
    for (const state of ['done', 'failed', 'cancelled', 'rejected'] as const) {
      expect(
        applyTaskTransition(task({ state }), { kind: 'dispatching', sourceSessionId: 'c' }, now)
          .status,
      ).toBe('invalid');
      expect(applyTaskTransition(task({ state }), { kind: 'cancel' }, now).status).toBe('invalid');
    }
  });
});
