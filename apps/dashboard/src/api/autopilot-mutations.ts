import {
  autopilotModeResponseSchema,
  publicErrorResponseSchema,
  type AutopilotMode,
} from '@luwi/protocol/browser';
import type { z } from 'zod';

/**
 * The dashboard's sixth write surface (ADR 0035): setting a project's autopilot
 * mode — off, supervised, or autopilot. It goes to the daemon's own
 * `/api/v1/projects/:projectId/autopilot/mode` endpoint with the bounded
 * `{ mode }` shape the HTTP contract defines; the operator is the request's
 * actor, never anything in the body beyond the mode.
 *
 * Kept in its own module for the same reason the other five are:
 * `product-independence.test.ts` allowlists exactly the modules that may issue a
 * non-GET request, so a write anywhere else is a test failure. The mode and the
 * policy are the operator's alone and are never reachable through MCP.
 */
export type AutopilotModeResponse = z.infer<typeof autopilotModeResponseSchema>;

export type AutopilotMutationResult<T> =
  | { state: 'ok'; data: T; httpStatus: number }
  | { state: 'failed'; reason: 'http'; code: string; message: string; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number };

export function createAutopilotMutations(fetchImpl: typeof fetch = fetch) {
  const modePath = (projectId: string): string =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/autopilot/mode`;

  const failure = async (response: Response): Promise<AutopilotMutationResult<never>> => {
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
    async setMode(
      projectId: string,
      mode: AutopilotMode,
    ): Promise<AutopilotMutationResult<AutopilotModeResponse>> {
      if (projectId.trim() === '') {
        return {
          state: 'failed',
          reason: 'http',
          httpStatus: 400,
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'An autopilot mode change needs a project.',
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(modePath(projectId), {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
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
      const parsed = autopilotModeResponseSchema.safeParse(value);
      return parsed.success
        ? { state: 'ok', httpStatus: response.status, data: parsed.data }
        : { state: 'failed', reason: 'invalid', httpStatus: response.status };
    },
  };
}

export type AutopilotMutations = ReturnType<typeof createAutopilotMutations>;
