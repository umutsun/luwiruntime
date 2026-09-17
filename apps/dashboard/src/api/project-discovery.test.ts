import { describe, expect, it, vi } from 'vitest';

import { loadProjectDiscovery } from './project-discovery.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetching = (answer: () => Promise<Response>): typeof fetch =>
  vi.fn(answer) as unknown as typeof fetch;

describe('loadProjectDiscovery', () => {
  it('reads the daemon list for the root it was given', async () => {
    const fetchImpl = fetching(async () =>
      json(200, {
        root: 'C:/w',
        candidates: [
          { directoryName: 'a', displayName: 'a', localPath: 'C:/w/a', canonicalPath: 'C:/w/a' },
        ],
        truncated: false,
      }),
    );
    const result = await loadProjectDiscovery('C:/w', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/projects/discover?root=C%3A%2Fw',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({
      state: 'ready',
      data: expect.objectContaining({ root: 'C:/w', truncated: false }),
    });
  });

  it("returns the daemon's refusal in its words", async () => {
    const fetchImpl = fetching(async () =>
      json(400, {
        error: {
          code: 'PROJECT_DISCOVERY_ROOT_INVALID',
          message: 'The project discovery root must be absolute.',
        },
      }),
    );
    expect(await loadProjectDiscovery('relative', { fetchImpl })).toEqual({
      state: 'failed',
      message: 'The project discovery root must be absolute.',
    });
  });

  it('fails plainly when the daemon cannot be reached or answers nonsense', async () => {
    expect(
      await loadProjectDiscovery('C:/w', {
        fetchImpl: fetching(async () => {
          throw new Error('down');
        }),
      }),
    ).toEqual({ state: 'failed', message: 'The daemon could not be reached.' });
    expect(
      await loadProjectDiscovery('C:/w', {
        fetchImpl: fetching(async () => json(200, { nope: 1 })),
      }),
    ).toEqual({ state: 'failed', message: 'The daemon returned an invalid discovery response.' });
  });
});
