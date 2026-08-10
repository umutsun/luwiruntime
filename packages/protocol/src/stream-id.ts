import { z } from 'zod';

/**
 * A Redis Stream entry id, `<millis>-<sequence>`.
 *
 * This lives in its own leaf module rather than in `realtime.ts` because
 * `message.ts` needs it and `realtime.ts` imports `runtime-event.ts`, which
 * imports `node:crypto`. Re-exporting any message schema through
 * `browser.ts` therefore pulled a Node builtin into the browser bundle — which
 * `apps/dashboard/vite.config.test.ts` catches, and which is the boundary
 * AGENTS.md section 5 exists to protect. Nothing else about the schema changed.
 */
export const redisStreamIdSchema = z.string().regex(/^\d+-\d+$/);
