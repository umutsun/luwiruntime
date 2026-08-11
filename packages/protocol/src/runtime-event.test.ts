import { describe, expect, it } from 'vitest';

import {
  createRuntimeEvent,
  parseRuntimeEvent,
  runtimeEventSchema,
  runtimeEventTypeSchema,
} from './index.js';

describe('runtime event envelope', () => {
  it('creates a versioned event with centrally supplied identity and time', () => {
    const event = createRuntimeEvent(
      {
        type: 'runtime.started',
        workspaceId: 'workspace-1',
        payload: { host: '127.0.0.1' },
      },
      {
        createId: () => 'event-1',
        now: () => new Date('2026-07-28T08:00:00.000Z'),
      },
    );

    expect(event).toEqual({
      id: 'event-1',
      version: 1,
      type: 'runtime.started',
      occurredAt: '2026-07-28T08:00:00.000Z',
      workspaceId: 'workspace-1',
      payload: { host: '127.0.0.1' },
    });
  });

  it('rejects unsupported event versions', () => {
    const result = runtimeEventSchema.safeParse({
      id: 'event-1',
      version: 2,
      type: 'runtime.started',
      occurredAt: '2026-07-28T08:00:00.000Z',
      workspaceId: 'workspace-1',
      payload: {},
    });

    expect(result.success).toBe(false);
  });

  it('rejects timestamps that are not UTC ISO 8601 values', () => {
    expect(() =>
      parseRuntimeEvent({
        id: 'event-1',
        version: 1,
        type: 'runtime.started',
        occurredAt: '2026-07-28 08:00:00',
        workspaceId: 'workspace-1',
        payload: {},
      }),
    ).toThrow();
  });

  it('rejects speculative event types outside the initial protocol', () => {
    expect(() =>
      parseRuntimeEvent({
        id: 'event-1',
        version: 1,
        type: 'agent.teleported',
        occurredAt: '2026-07-28T08:00:00.000Z',
        workspaceId: 'workspace-1',
        payload: {},
      }),
    ).toThrow();
  });

  it('accepts the dedicated graceful completion event', () => {
    expect(
      parseRuntimeEvent({
        id: 'event-1',
        version: 1,
        type: 'session.completed',
        occurredAt: '2026-07-28T08:00:00.000Z',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        agentId: 'codex-sim',
        sessionId: 'session-1',
        payload: {},
      }).type,
    ).toBe('session.completed');
  });

  it('defines every Phase 2 message lifecycle event', () => {
    for (const type of [
      'message.requested',
      'message.delivered',
      'message.acknowledged',
      'message.processing',
      'message.responded',
      'message.rejected',
      'message.failed',
      'message.timed_out',
    ]) {
      expect(runtimeEventTypeSchema.parse(type)).toBe(type);
    }
  });

  it('defines the bounded Phase 4 intelligence event taxonomy', () => {
    for (const type of [
      'usage.reported',
      'usage.estimated',
      'usage.rejected',
      'context.contribution.observed',
      'context.capability.loaded',
      'context.capability.invoked',
      'context.mcp.tool.called',
      'git.observed',
      'git.head.changed',
      'git.commit.detected',
      'git.worktree.detected',
      'git.working-tree.changed',
      'package.inventory.updated',
      'technology.detected',
      'attribution.recorded',
      'attribution.updated',
      'graph.node.projected',
      'graph.edge.projected',
      'graph.rebuild.started',
      'graph.rebuild.completed',
      'graph.rebuild.failed',
      'optimization.analysis.completed',
      'optimization.finding.detected',
      'optimization.proposal.created',
      'optimization.proposal.accepted',
      'optimization.proposal.rejected',
      'optimization.plan.created',
      'optimization.applied',
      'optimization.evaluation.started',
      'optimization.evaluation.completed',
    ]) {
      expect(runtimeEventTypeSchema.parse(type)).toBe(type);
    }
  });
});

describe('native session event types', () => {
  /**
   * `runtimeEventTypeSchema` is a closed enum. A type missing from it is written
   * to the Stream and then rejected by the repository parser and the realtime
   * relay, so the write succeeds and the notification never arrives.
   */
  it('accepts the two native binding event types', () => {
    for (const type of ['session.native.linked', 'session.native.unlinked']) {
      expect(runtimeEventTypeSchema.safeParse(type).success, type).toBe(true);
    }
  });
});
