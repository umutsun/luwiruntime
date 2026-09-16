import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { LUWI_PROTOCOL_VERSION } from './version.js';

export const runtimeEventTypeSchema = z.enum([
  'runtime.started',
  'runtime.stopping',
  'project.registered',
  'project.updated',
  'session.registered',
  'session.heartbeat',
  'session.status.changed',
  'session.completed',
  'session.disconnected',
  /**
   * A native session reference was bound to, or released from, a LUWI session.
   * Identifiers only: no transcript content, no path, no native payload.
   */
  'session.native.linked',
  'session.native.unlinked',
  'message.requested',
  'message.delivered',
  'message.acknowledged',
  'message.processing',
  'message.responded',
  'message.rejected',
  'message.failed',
  'message.timed_out',
  'lease.acquired',
  'lease.renewed',
  'lease.released',
  'lease.expired',
  /**
   * A refused acquire. It records no state change, and it is the only evidence
   * that a collision was prevented rather than merely not observed.
   */
  'lease.denied',
  /**
   * The single per-project coordinator role (ADR 0035) was claimed (a fresh
   * grant or a take-over from a terminal holder) or released. Identity only:
   * who coordinates, never any work state. A refused claim (a live holder
   * already held it) writes nothing, following the native-binding precedent.
   */
  'coordinator.claimed',
  'coordinator.released',
  'agent.definition.registered',
  'agent.definition.updated',
  'agent.definition.disabled',
  'project.agent.bound',
  'project.agent.updated',
  'project.agent.unbound',
  'capability.registered',
  'capability.updated',
  'capability.disabled',
  'capability.assigned',
  'capability.unassigned',
  'profile.registered',
  'profile.updated',
  'profile.assigned',
  'config.inspected',
  'config.import.planned',
  'config.plan.created',
  'config.plan.approved',
  'config.plan.superseded',
  'config.apply.started',
  'config.applied',
  'config.apply.failed',
  'config.rollback.started',
  'config.rolled_back',
  'config.drift.detected',
  'config.drift.resolved',
  'config.reconciled',
  'context.source.detected',
  'context.source.updated',
  'context.footprint.measured',
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
]);

export const runtimeEventSchema = z.object({
  id: z.string().min(1),
  version: z.literal(LUWI_PROTOCOL_VERSION),
  type: runtimeEventTypeSchema,
  occurredAt: z.iso.datetime({ offset: false }),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  causationId: z.string().min(1).optional(),
  payload: z.unknown(),
});

export type RuntimeEventType = z.infer<typeof runtimeEventTypeSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export type RuntimeEventInput = Omit<RuntimeEvent, 'id' | 'version' | 'occurredAt'>;

export type RuntimeEventDependencies = {
  createId: () => string;
  now: () => Date;
};

const defaultDependencies: RuntimeEventDependencies = {
  createId: randomUUID,
  now: () => new Date(),
};

export function createRuntimeEvent(
  input: RuntimeEventInput,
  dependencies: RuntimeEventDependencies = defaultDependencies,
): RuntimeEvent {
  return runtimeEventSchema.parse({
    ...input,
    id: dependencies.createId(),
    version: LUWI_PROTOCOL_VERSION,
    occurredAt: dependencies.now().toISOString(),
  });
}

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  return runtimeEventSchema.parse(value);
}
