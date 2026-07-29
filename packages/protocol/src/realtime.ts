import { z } from 'zod';

import { runtimeEventSchema } from './runtime-event.js';

export const redisStreamIdSchema = z.string().regex(/^\d+-\d+$/);

export const realtimeEventMessageSchema = z.strictObject({
  streamId: redisStreamIdSchema,
  event: runtimeEventSchema,
});

export type RealtimeEventMessage = z.infer<typeof realtimeEventMessageSchema>;
