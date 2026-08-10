import { z } from 'zod';

import { runtimeEventSchema } from './runtime-event.js';
import { redisStreamIdSchema } from './stream-id.js';

export { redisStreamIdSchema } from './stream-id.js';

export const realtimeEventMessageSchema = z.strictObject({
  streamId: redisStreamIdSchema,
  event: runtimeEventSchema,
});

export type RealtimeEventMessage = z.infer<typeof realtimeEventMessageSchema>;
