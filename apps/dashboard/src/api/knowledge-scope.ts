import { knowledgeGraphResponseSchema } from '@luwi/protocol/browser';
import type { z } from 'zod';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

export type KnowledgeGraph = z.infer<typeof knowledgeGraphResponseSchema>;

/**
 * The per-project graphify knowledge graph, read-only, loaded only while
 * `#/knowledge/<projectId>` is open — the overview never pays for it.
 */
export async function loadKnowledgeScope(
  client: DaemonClient,
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<KnowledgeGraph>> {
  const get = options.signal === undefined ? {} : { signal: options.signal };
  return client.get(
    `/api/v1/projects/${encodeURIComponent(projectId)}/knowledge-graph`,
    knowledgeGraphResponseSchema,
    get,
  );
}
