import { coordinatorSchema, publicErrorResponseSchema } from '@luwi/protocol/browser';
import type { z } from 'zod';

/**
 * The dashboard's fourth write surface (ADR 0035): assigning the per-project
 * coordinator role to a session, and releasing it. Both go to the daemon's own
 * `/api/v1/projects/:projectId/coordinator` endpoints with the same bounded
 * shape the HTTP contract defines; the holder is the named session, never input
 * beyond it.
 *
 * Kept in its own module for the same reason the other three are:
 * `product-independence.test.ts` allowlists exactly the modules that may issue a
 * non-GET request, so a write anywhere else is a test failure.
 *
 * A claim is single-holder: the daemon refuses a second live holder with
 * `409 COORDINATOR_CONFLICT` naming it — surfaced here as a `failed/http` result
 * the caller shows, not a thrown fault.
 */
export type Coordinator = z.infer<typeof coordinatorSchema>;

export type CoordinatorMutationResult<T> =
  | { state: 'ok'; data: T; httpStatus: number }
  | { state: 'failed'; reason: 'http'; code: string; message: string; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number };

function idsValid(projectId: string, sessionId: string): boolean {
  return projectId.trim() !== '' && sessionId.trim() !== '';
}

export function createCoordinatorMutations(fetchImpl: typeof fetch = fetch) {
  const coordinatorPath = (projectId: string): string =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/coordinator`;

  const failure = async (response: Response): Promise<CoordinatorMutationResult<never>> => {
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
    async claim(
      projectId: string,
      sessionId: string,
    ): Promise<CoordinatorMutationResult<Coordinator>> {
      if (!idsValid(projectId, sessionId)) {
        return {
          state: 'failed',
          reason: 'http',
          httpStatus: 400,
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'A coordinator claim needs a project and a session.',
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(coordinatorPath(projectId), {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
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
      const parsed = coordinatorSchema.safeParse(value);
      return parsed.success
        ? { state: 'ok', httpStatus: response.status, data: parsed.data }
        : { state: 'failed', reason: 'invalid', httpStatus: response.status };
    },

    async release(projectId: string, sessionId: string): Promise<CoordinatorMutationResult<null>> {
      if (!idsValid(projectId, sessionId)) {
        return {
          state: 'failed',
          reason: 'http',
          httpStatus: 400,
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'A coordinator release needs a project and a session.',
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(coordinatorPath(projectId), {
          method: 'DELETE',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
      } catch {
        return { state: 'failed', reason: 'transport' };
      }
      // Release answers 204 with no body; anything else is a named refusal.
      if (response.status === 204) return { state: 'ok', httpStatus: 204, data: null };
      return failure(response);
    },
  };
}

export type CoordinatorMutations = ReturnType<typeof createCoordinatorMutations>;
