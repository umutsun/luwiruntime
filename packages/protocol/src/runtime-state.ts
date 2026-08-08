import { z } from 'zod';

export const runtimeStateSchema = z.enum([
  'starting',
  'ready',
  'degraded',
  'recovering',
  'draining',
  'stopped',
]);

export type RuntimeStateName = z.infer<typeof runtimeStateSchema>;
