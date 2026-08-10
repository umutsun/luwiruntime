import { z } from 'zod';

import { utf8ByteLength } from './utf8-bytes.js';

const identifierSchema = z.string().trim().min(1).max(128);
const pathSchema = z.string().trim().min(1).max(4096);
const timestampSchema = z.iso.datetime({ offset: false });

export const agentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const sessionStatusSchema = z.enum([
  'starting',
  'idle',
  'thinking',
  'tool_running',
  'waiting_for_input',
  'waiting_for_agent',
  'blocked',
  'completed',
  'disconnected',
]);

export const sessionStatusTargetSchema = z.enum([
  'idle',
  'thinking',
  'tool_running',
  'waiting_for_input',
  'waiting_for_agent',
  'blocked',
  'completed',
]);

const metadataSchema = z
  .record(z.string(), z.json())
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 16 * 1024, {
    message: 'Session metadata exceeds 16 KiB',
  });

export const sessionRegistrationRequestSchema = z.strictObject({
  projectId: identifierSchema,
  agentId: agentIdSchema,
  workingDirectory: pathSchema,
  taskSummary: z.string().trim().min(1).max(2000).optional(),
  branch: z.string().trim().min(1).max(512).optional(),
  worktreePath: pathSchema.optional(),
  metadata: metadataSchema.default({}),
});

export const heartbeatRequestSchema = z.strictObject({
  metadata: metadataSchema.optional(),
});

export const heartbeatResponseSchema = z.strictObject({
  status: z.literal('renewed'),
  eventEmitted: z.boolean(),
});

export const sessionStatusRequestSchema = z.strictObject({
  status: sessionStatusTargetSchema,
});

export const agentSessionSchema = z.strictObject({
  id: identifierSchema,
  agentId: agentIdSchema,
  projectId: identifierSchema,
  status: sessionStatusSchema,
  taskSummary: z.string().max(2000).optional(),
  workingDirectory: pathSchema,
  branch: z.string().max(512).optional(),
  worktreePath: pathSchema.optional(),
  startedAt: timestampSchema,
  lastHeartbeatAt: timestampSchema,
  metadata: metadataSchema,
});

export const sessionViewSchema = agentSessionSchema.extend({
  presence: z.enum(['online', 'offline']),
});

export const sessionResponseSchema = sessionViewSchema;
export const sessionCollectionResponseSchema = z.strictObject({
  sessions: z.array(sessionViewSchema),
});

export type AgentId = z.infer<typeof agentIdSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionStatusTarget = z.infer<typeof sessionStatusTargetSchema>;
export type SessionRegistrationRequest = z.infer<typeof sessionRegistrationRequestSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;
export type SessionStatusRequest = z.infer<typeof sessionStatusRequestSchema>;
export type AgentSession = z.infer<typeof agentSessionSchema>;
export type SessionView = z.infer<typeof sessionViewSchema>;
export type SessionCollectionResponse = z.infer<typeof sessionCollectionResponseSchema>;
