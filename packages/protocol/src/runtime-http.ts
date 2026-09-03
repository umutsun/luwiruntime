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

const byteCountSchema = z.number().int().nonnegative();
const percentSchema = z.number().min(0).max(100);

/**
 * What the machine has and what this runtime costs on it
 * (`GET /api/v1/runtime/resources`).
 *
 * Every figure is a measurement the daemon took itself: the standard library,
 * its own process, the Redis `INFO memory` and `DBSIZE` replies, or one fixed
 * `nvidia-smi` query. A source that is absent leaves its field absent rather
 * than reporting a zero that was never measured.
 */
export const runtimeResourcesResponseSchema = z.object({
  observedAt: z.iso.datetime({ offset: false }),
  host: z.object({
    platform: z.string().min(1).max(32),
    cpu: z.object({
      model: z.string().min(1).max(256).optional(),
      cores: z.number().int().positive(),
      /** Busy share across every core since the previous read; absent on the first. */
      utilizationPercent: percentSchema.optional(),
    }),
    memory: z.object({ totalBytes: byteCountSchema, freeBytes: byteCountSchema }),
    /** The volume holding LUWI's own state. */
    disk: z
      .object({
        path: z.string().min(1).max(4096),
        totalBytes: byteCountSchema,
        freeBytes: byteCountSchema,
      })
      .optional(),
    /** Absent when no NVIDIA tool answers; an empty list is a tool that found no device. */
    gpus: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          memoryUsedBytes: byteCountSchema.optional(),
          memoryTotalBytes: byteCountSchema.optional(),
          utilizationPercent: percentSchema.optional(),
        }),
      )
      .max(16)
      .optional(),
  }),
  daemon: z.object({
    pid: z.number().int().positive(),
    rssBytes: byteCountSchema,
    heapUsedBytes: byteCountSchema,
    /** Share of the whole machine since the previous read; absent on the first. */
    cpuPercent: percentSchema.optional(),
  }),
  /** Absent while Redis is unreachable. */
  redis: z
    .object({
      usedMemoryBytes: byteCountSchema,
      /** Zero means Redis has no limit configured. */
      maxMemoryBytes: byteCountSchema,
      keyCount: byteCountSchema,
    })
    .optional(),
});

export const lifecycleStopResponseSchema = z.strictObject({
  status: z.literal('stopping'),
});

export type RedisConnected = z.infer<typeof redisConnectedSchema>;
export type RedisDisconnected = z.infer<typeof redisDisconnectedSchema>;
export type RedisHealthResponse = z.infer<typeof redisHealthSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RuntimeInfoResponse = z.infer<typeof runtimeInfoResponseSchema>;
export type RuntimeResourcesResponse = z.infer<typeof runtimeResourcesResponseSchema>;
export type LifecycleStopResponse = z.infer<typeof lifecycleStopResponseSchema>;
