import {
  projectSubagentsResponseSchema,
  sessionSubagentsResponseSchema,
  type ProjectSubagentsResponse,
  type SessionSubagentsResponse,
} from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * The sub-agents a session runs inside itself (ADR 0038): read on demand from
 * its native transcript, never stored, and never LUWI sessions of their own.
 * GET only; the listing is handed back as validated, so the reader of it states
 * `unbound`/`unsupported` and truncation itself rather than this module guessing.
 */
export async function loadSessionSubagents(
  client: DaemonClient,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<SessionSubagentsResponse>> {
  const result = await client.get(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/subagents`,
    sessionSubagentsResponseSchema,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return result.state === 'ready'
    ? { state: 'ready', data: result.data }
    : { state: 'unavailable' };
}

/** Every live session of one project, each with its sub-agents (at most 20 sessions). */
export async function loadProjectSubagents(
  client: DaemonClient,
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<ProjectSubagentsResponse>> {
  const result = await client.get(
    `/api/v1/projects/${encodeURIComponent(projectId)}/subagents`,
    projectSubagentsResponseSchema,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return result.state === 'ready'
    ? { state: 'ready', data: result.data }
    : { state: 'unavailable' };
}
