import { z } from 'zod';

import { realtimeEventMessageSchema } from './realtime.js';
import { runtimeStateSchema } from './runtime-state.js';

export { runtimeStateSchema };

export const eventListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export const eventListResponseSchema = z.strictObject({
  events: z.array(realtimeEventMessageSchema),
});

const safeErrorDetailSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);

export const publicErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
    details: z.record(z.string(), safeErrorDetailSchema).optional(),
  }),
});

export type { RuntimeStateName } from './runtime-state.js';
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export type EventListResponse = z.infer<typeof eventListResponseSchema>;
export type PublicErrorResponse = z.infer<typeof publicErrorResponseSchema>;
