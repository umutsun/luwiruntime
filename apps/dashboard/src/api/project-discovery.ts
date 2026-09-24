import { projectDiscoveryResponseSchema, publicErrorResponseSchema } from '@luwi/protocol/browser';
import type { z } from 'zod';

/**
 * One directory level under a root, read from the daemon — the "Scan a
 * folder" flow. A GET, so it lives outside the write allowlist; registering a
 * ticked folder goes through `api/project-mutations.ts` like any other
 * registration.
 *
 * The daemon's own refusal (a root that is not absolute, or cannot be read) is
 * returned in its words rather than folded into "unavailable": the reader
 * typed that root and needs to know what was wrong with it.
 */
export type ProjectDiscovery = z.infer<typeof projectDiscoveryResponseSchema>;

export type ProjectDiscoveryResult =
  { state: 'ready'; data: ProjectDiscovery } | { state: 'failed'; message: string };

export async function loadProjectDiscovery(
  root: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<ProjectDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`/api/v1/projects/discover?root=${encodeURIComponent(root)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { state: 'failed', message: 'The daemon could not be reached.' };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { state: 'failed', message: 'The daemon returned an invalid response.' };
  }
  if (!response.ok) {
    const error = publicErrorResponseSchema.safeParse(value);
    return {
      state: 'failed',
      message: error.success
        ? error.data.error.message
        : `The daemon answered ${String(response.status)}.`,
    };
  }
  const parsed = projectDiscoveryResponseSchema.safeParse(value);
  return parsed.success
    ? { state: 'ready', data: parsed.data }
    : { state: 'failed', message: 'The daemon returned an invalid discovery response.' };
}
