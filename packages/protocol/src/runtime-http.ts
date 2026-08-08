import { z } from 'zod';

import { runtimeStateSchema } from './runtime-state.js';
import { LUWI_PROTOCOL_VERSION, LUWI_RUNTIME_VERSION } from './version.js';

export const redisConnectedSchema = z.object({
  connected: z.literal(true),
  status: z.literal('connected'),
  latencyMs: z.number().nonnegative(),
});

export const redisDisconnectedSchema = z.object({
  connected: z.literal(false),
  status: z.literal('disconnected'),
  error: z.object({
    code: z.literal('REDIS_UNAVAILABLE'),
    message: z.literal('Redis is unavailable'),
  }),
});

export const redisHealthSchema = z.discriminatedUnion('connected', [
  redisConnectedSchema,
  redisDisconnectedSchema,
]);

const healthBase = {
  runtimeState: runtimeStateSchema,
  version: z.literal(LUWI_RUNTIME_VERSION),
  uptimeMs: z.number().nonnegative(),
  timestamp: z.iso.datetime({ offset: false }),
};

export const healthResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    ...healthBase,
    redis: redisConnectedSchema,
  }),
  z.object({
    status: z.literal('degraded'),
    ...healthBase,
    redis: redisHealthSchema,
  }),
]);

export const runtimeInfoResponseSchema = z.object({
  version: z.literal(LUWI_RUNTIME_VERSION),
  protocolVersion: z.literal(LUWI_PROTOCOL_VERSION),
  runtimeState: runtimeStateSchema,
  runtimeInstanceId: z.string().min(1).max(128),
  workspaceId: z.string().min(1),
  startedAt: z.iso.datetime({ offset: false }),
  uptimeMs: z.number().nonnegative(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  redis: redisHealthSchema,
  endpoints: z.object({
    health: z.literal('/health'),
    runtime: z.literal('/api/v1/runtime'),
  }),
});

export type RedisConnected = z.infer<typeof redisConnectedSchema>;
export type RedisDisconnected = z.infer<typeof redisDisconnectedSchema>;
export type RedisHealthResponse = z.infer<typeof redisHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RuntimeInfoResponse = z.infer<typeof runtimeInfoResponseSchema>;
