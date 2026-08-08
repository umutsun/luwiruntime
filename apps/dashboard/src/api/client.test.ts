import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createDaemonClient } from './client.js';

describe('daemon API client', () => {
  it('validates successful responses', async () => {
    const client = createDaemonClient(
      async () =>
        new Response(JSON.stringify({ value: 7 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(client.get('/value', z.object({ value: z.number() }))).resolves.toMatchObject({
      state: 'ready',
      data: { value: 7 },
    });
  });

  it('keeps a validated degraded health body from a non-2xx response', async () => {
    const client = createDaemonClient(
      async () =>
        new Response(JSON.stringify({ status: 'degraded' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await expect(
      client.get('/health', z.object({ status: z.literal('degraded') }), {
        acceptValidatedErrorBody: true,
      }),
    ).resolves.toMatchObject({ state: 'ready', data: { status: 'degraded' }, httpStatus: 503 });
  });

  it('distinguishes transport, HTTP, and validation failures', async () => {
    const transport = createDaemonClient(async () => {
      throw new TypeError('network down');
    });
    const http = createDaemonClient(async () => new Response('{}', { status: 500 }));
    const invalid = createDaemonClient(
      async () => new Response(JSON.stringify({ value: 'wrong' }), { status: 200 }),
    );

    await expect(transport.get('/value', z.object({ value: z.number() }))).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'transport',
    });
    await expect(http.get('/value', z.object({ value: z.number() }))).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'http',
      httpStatus: 500,
    });
    await expect(invalid.get('/value', z.object({ value: z.number() }))).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'invalid',
    });
  });

  it('passes an AbortSignal to fetch so obsolete resource reads can be cancelled', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ value: 7 })));
    const client = createDaemonClient(fetchImpl);
    const controller = new AbortController();

    await client.get('/value', z.object({ value: z.number() }), { signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledWith(
      '/value',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
