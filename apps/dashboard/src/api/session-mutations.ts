import { publicErrorResponseSchema } from '@luwi/protocol/browser';

/**
 * The dashboard's seventh write surface: ending a session the developer has
 * abandoned. When a chat's context fills up they open a new one, but the old
 * session lingers `idle`/online in the overview until a daemon sweeper catches
 * it. This closes it on demand through the daemon's own
 * `POST /api/v1/sessions/:sessionId/close` — which marks a live session
 * `completed`, clears its presence and heartbeat, so it drops from the overview
 * at once. The verb is idempotent (a no-op 200 on an already-terminal session),
 * so the button never has to reason about the row's exact status.
 *
 * Kept in its own module for the same reason the other six are:
 * `product-independence.test.ts` allowlists exactly the modules that may issue a
 * non-GET request, so a write anywhere else is a test failure. Closing is the
 * only per-session write; the daemon exposes no per-session delete, and this
 * carries none.
 */
export type SessionMutationResult =
  | { state: 'ok'; httpStatus: number }
  | { state: 'failed'; reason: 'http'; code: string; message: string; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number };

export function createSessionMutations(fetchImpl: typeof fetch = fetch) {
  const failure = async (response: Response): Promise<SessionMutationResult> => {
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
    async close(sessionId: string): Promise<SessionMutationResult> {
      if (sessionId.trim() === '') {
        return {
          state: 'failed',
          reason: 'http',
          httpStatus: 400,
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'Ending a session needs a session.',
        };
      }
      let response: Response;
      try {
        // The `{}` body is what makes an Origin-less POST carry a JSON
        // content-type, which the daemon requires (ADR 0021); the close route
        // reads no body.
        response = await fetchImpl(`/api/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch {
        return { state: 'failed', reason: 'transport' };
      }
      // The response body is the session view; the snapshot is re-read after a
      // close, so the outcome only needs 2xx, never the returned record.
      if (response.ok) return { state: 'ok', httpStatus: response.status };
      return failure(response);
    },
  };
}

export type SessionMutations = ReturnType<typeof createSessionMutations>;
