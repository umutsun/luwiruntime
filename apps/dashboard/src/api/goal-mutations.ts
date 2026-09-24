import { goalSchema, publicErrorResponseSchema } from '@luwi/protocol/browser';
import type { z } from 'zod';

/**
 * The dashboard's eighth write surface: creating an autopilot goal for a project,
 * so the operator can start (and continue) autopilot work from the dashboard
 * instead of the CLI. It posts the daemon's own
 * `POST /api/v1/projects/:projectId/goals`; the operator is the request's actor
 * (a session-less body), never anything else. A created goal starts `proposed`
 * and the CLI orchestrator's `planCycle` starts it on its own — the dashboard
 * only creates, it never dispatches.
 *
 * Kept in its own module for the same reason the other seven are:
 * `product-independence.test.ts` allowlists exactly the modules that may issue a
 * non-GET request, so a write anywhere else is a test failure.
 */
export type Goal = z.infer<typeof goalSchema>;

/** The create body the daemon validates (goalCreateRequestSchema); the dashboard
 * owns this shape locally rather than importing the request schema into the
 * browser bundle, since the daemon is the source of truth for validation. */
export type GoalCreateRequest = {
  title: string;
  objective: string;
  acceptanceCriteria?: string[];
};

export type GoalMutationResult<T> =
  | { state: 'ok'; data: T; httpStatus: number }
  | { state: 'failed'; reason: 'http'; code: string; message: string; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number };

export function createGoalMutations(fetchImpl: typeof fetch = fetch) {
  const goalsPath = (projectId: string): string =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/goals`;

  const failure = async (response: Response): Promise<GoalMutationResult<never>> => {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return { state: 'failed', reason: 'invalid', httpStatus: response.status };
    }
    const error = publicErrorResponseSchema.safeParse(value);
    return error.success
      ? {
          state: 'failed',
          reason: 'http',
          httpStatus: response.status,
          code: error.data.error.code,
          message: error.data.error.message,
        }
      : { state: 'failed', reason: 'invalid', httpStatus: response.status };
  };

  return {
    async create(projectId: string, request: GoalCreateRequest): Promise<GoalMutationResult<Goal>> {
      if (projectId.trim() === '') {
        return {
          state: 'failed',
          reason: 'http',
          httpStatus: 400,
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'A new goal needs a project.',
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(goalsPath(projectId), {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        return { state: 'failed', reason: 'transport' };
      }
      if (!response.ok) return failure(response);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return { state: 'failed', reason: 'invalid', httpStatus: response.status };
      }
      const parsed = goalSchema.safeParse(value);
      return parsed.success
        ? { state: 'ok', httpStatus: response.status, data: parsed.data }
        : { state: 'failed', reason: 'invalid', httpStatus: response.status };
    },
  };
}

export type GoalMutations = ReturnType<typeof createGoalMutations>;
