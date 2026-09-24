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

  it('requeues a dispatched task: dispatch fields cleared, count 1, lastRedispatch set', () => {
    const dispatched = task({
      state: 'dispatched',
      correlationId: 'corr-1',
      targetSessionId: 'worker-1',
      dispatchSourceSessionId: 'coord',
      dispatchedAt: now,
    });
    const result = applyTaskTransition(
      dispatched,
      { kind: 'requeue', reason: 'target_session_lost' },
      now,
    );
    expect(result).toMatchObject({
      status: 'ok',
      task: {
        state: 'ready',
        redispatchCount: 1,
        lastRedispatch: { at: now, reason: 'target_session_lost', correlationId: 'corr-1' },
      },
    });
    const requeued = (result as { task: Task }).task;
    expect(requeued.correlationId).toBeUndefined();
    expect(requeued.targetSessionId).toBeUndefined();
    expect(requeued.dispatchSourceSessionId).toBeUndefined();
    expect(requeued.dispatchedAt).toBeUndefined();
  });

  it('requeues an operator-approved task straight to approved, so the gate is not asked twice', () => {
    // Live 2026-09-24 (supervised): a requeued task went back to `ready` and was gated
    // `awaiting_approval` again, although the owner had approved its plan.
    const approved = task({
      state: 'dispatched',
      correlationId: 'corr-1',
      approval: { decision: 'approved', at: now, by: 'operator' },
    });
    expect(
      applyTaskTransition(approved, { kind: 'requeue', reason: 'target_session_lost' }, now),
    ).toMatchObject({ status: 'ok', task: { state: 'approved' } });
  });

  it('counts a second requeue as 2', () => {
    const firstRequeue = applyTaskTransition(
      task({
        state: 'dispatched',
        correlationId: 'corr-1',
        targetSessionId: 'worker-1',
        dispatchSourceSessionId: 'coord',
        dispatchedAt: now,
      }),
      { kind: 'requeue', reason: 'target_session_lost' },
      now,
    );
    const dispatching = applyTaskTransition(
      (firstRequeue as { task: Task }).task,
      { kind: 'dispatching', sourceSessionId: 'coord' },
      now,
    );
    const redispatched = applyTaskTransition(
      (dispatching as { task: Task }).task,
      { kind: 'dispatched', correlationId: 'corr-2', targetSessionId: 'worker-2' },
      now,
    );
    const secondRequeue = applyTaskTransition(
      (redispatched as { task: Task }).task,
      { kind: 'requeue', reason: 'target_session_lost' },
      now,
    );
    expect(secondRequeue).toMatchObject({ status: 'ok', task: { redispatchCount: 2 } });
  });

  it('requeues a dispatching task, omitting lastRedispatch.correlationId when it had none', () => {
    const result = applyTaskTransition(
      task({ state: 'dispatching', dispatchSourceSessionId: 'coord' }),
      { kind: 'requeue', reason: 'target_session_lost' },
      now,
    );
    expect(result).toMatchObject({
      status: 'ok',
      task: { state: 'ready', redispatchCount: 1 },
    });
    const requeued = (result as { task: Task }).task;
    expect(requeued.lastRedispatch).toEqual({ at: now, reason: 'target_session_lost' });
    expect(requeued.dispatchSourceSessionId).toBeUndefined();
  });

  it('refuses to requeue a task that is not dispatched or dispatching', () => {
    for (const state of ['ready', 'done', 'failed', 'awaiting_approval'] as const) {
      expect(
        applyTaskTransition(
          task({ state }),
          { kind: 'requeue', reason: 'target_session_lost' },
          now,
        ).status,
      ).toBe('invalid');
    }
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
