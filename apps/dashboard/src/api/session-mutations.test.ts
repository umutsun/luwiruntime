import { describe, expect, it, vi } from 'vitest';

import { createSessionMutations } from './session-mutations.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('session mutations', () => {
  it('closes a session with a JSON body so an Origin-less POST is accepted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'session-a' }, 200));
    const mutations = createSessionMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.close('session-a');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/v1/sessions/session-a/close');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(result).toEqual({ state: 'ok', httpStatus: 200 });
  });

  it('encodes the session id into the path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 200));
    const mutations = createSessionMutations(fetchImpl as unknown as typeof fetch);

    await mutations.close('a/b?c');
    const [path] = fetchImpl.mock.calls[0] as [string];
    expect(path).toBe('/api/v1/sessions/a%2Fb%3Fc/close');
  });

  it('surfaces a daemon refusal as its public error code and message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: 'SESSION_NOT_FOUND', message: 'No session session-a.' } },
          404,
        ),
      );
    const mutations = createSessionMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.close('session-a')).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 404,
      code: 'SESSION_NOT_FOUND',
      message: 'No session session-a.',
    });
  });

  it('refuses a blank session id before any request', async () => {
    const fetchImpl = vi.fn();
    const mutations = createSessionMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.close('  ')).toMatchObject({ state: 'failed', reason: 'http' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a transport failure and an unparseable error body apart', async () => {
    const down = createSessionMutations(
      vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
    );
    expect(await down.close('session-a')).toEqual({ state: 'failed', reason: 'transport' });

    const garbage = createSessionMutations(
      vi.fn().mockResolvedValue(jsonResponse({ nope: true }, 500)) as unknown as typeof fetch,
    );
    expect(await garbage.close('session-a')).toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 500,
    });
  });
});
