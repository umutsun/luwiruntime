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
  'message.requested',
  'message.responded',
  'message.timed_out',
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
