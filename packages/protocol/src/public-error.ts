import { z } from 'zod';

/**
 * The daemon's public error body.
 *
 * This lives in its own leaf module rather than in `runtime-api.ts` for the
 * same reason `stream-id.ts` does: `runtime-api.ts` imports `realtime.ts`,
 * which imports `runtime-event.ts`, which imports `node:crypto`. Re-exporting
 * this schema through `browser.ts` from there would pull a Node builtin into
 * the browser bundle, which `apps/dashboard/vite.config.test.ts` catches and
 * which AGENTS.md section 5 exists to protect. Nothing about the schema itself
 * changed when it moved.
 */

const safeErrorDetailSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);

export const publicErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
    details: z.record(z.string(), safeErrorDetailSchema).optional(),
  }),
});

export type PublicErrorResponse = z.infer<typeof publicErrorResponseSchema>;
