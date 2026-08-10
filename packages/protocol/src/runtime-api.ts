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

/**
 * Re-exported from a leaf module the browser bundle can reach. This file
 * imports `realtime.js`, which transitively imports `node:crypto`, so
 * `browser.ts` must take the schema from `public-error.js` and never from here.
 */
export { publicErrorResponseSchema } from './public-error.js';

export type { RuntimeStateName } from './runtime-state.js';
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export type EventListResponse = z.infer<typeof eventListResponseSchema>;
export type { PublicErrorResponse } from './public-error.js';
