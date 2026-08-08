import { z } from 'zod';

const identifier = z.string().trim().min(1).max(128);
const optionalIdentifier = identifier.optional();

export const dashboardEventMessageSchema = z.strictObject({
  streamId: z.string().regex(/^\d+-\d+$/),
  event: z.strictObject({
    id: identifier,
    version: z.literal(1),
    type: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    occurredAt: z.iso.datetime({ offset: false }),
    workspaceId: identifier,
    projectId: optionalIdentifier,
    agentId: optionalIdentifier,
    sessionId: optionalIdentifier,
    correlationId: optionalIdentifier,
    causationId: optionalIdentifier,
    payload: z.unknown(),
  }),
});

export type DashboardEvent = {
  streamId: string;
  id: string;
  version: 1;
  type: string;
  occurredAt: string;
  workspaceId: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
};

export type DashboardEventParseResult =
  { ok: true; event: DashboardEvent } | { ok: false; reason: 'invalid-envelope' };

type DashboardEventMessage = z.infer<typeof dashboardEventMessageSchema>;

const implementedEventPrefixes = [
  'runtime.',
  'project.',
  'session.',
  'message.',
  'agent.definition.',
  'capability.',
  'profile.',
  'config.',
  'context.',
  'usage.',
  'git.',
  'package.',
  'technology.',
  'attribution.',
  'graph.',
  'optimization.',
] as const;

export function isImplementedEventType(type: string): boolean {
  return implementedEventPrefixes.some((prefix) => type.startsWith(prefix));
}

export function toDashboardEvent(message: DashboardEventMessage): DashboardEvent {
  const { streamId, event } = message;
  return {
    streamId,
    id: event.id,
    version: event.version,
    type: event.type,
    occurredAt: event.occurredAt,
    workspaceId: event.workspaceId,
    ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
    ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    payload: event.payload,
  };
}

export function parseDashboardEvent(value: unknown): DashboardEventParseResult {
  const parsed = dashboardEventMessageSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'invalid-envelope' };
  return { ok: true, event: toDashboardEvent(parsed.data) };
}
