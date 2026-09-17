import { messageCollectionResponseSchema } from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * Inter-agent messaging, read-only.
 *
 * The daemon has served this record set since Phase 2 and eight `message.*`
 * event types have been reaching Activity the whole time, so a user could see
 * that a request happened and never who asked whom, what was asked, or how it
 * ended. This is the read that closes that gap.
 *
 * Loaded only while `#/messages` is open, matching the rule the intelligence
 * scope already follows: the overview never pays for a route it is not showing.
 */

const PAGE_SIZE = 100;

export type MessageState =
  | 'queued'
  | 'delivered'
  | 'acknowledged'
  | 'processing'
  | 'responded'
  | 'rejected'
  | 'timed_out'
  | 'failed';

export type MessageResponseSummary = {
  status: 'answered' | 'partially_answered' | 'rejected' | 'failed';
  answer: string;
  confidence?: number;
  evidenceCount: number;
  /** The distinct evidence types attached, in the order first attached (`test_result`, …). */
  evidenceTypes: string[];
  verifiedAt: string;
};

export type AgentMessage = {
  id: string;
  correlationId: string;
  projectId: string;
  sourceSessionId: string;
  sourceAgentId: string;
  targetSessionId: string;
  targetAgentId: string;
  selectionReason: string;
  kind: 'question' | 'status_request' | 'instruction';
  subject?: string;
  content: string;
  evidenceRequirements: string[];
  /** The exchange this one re-asks, when the caller declared a re-dispatch. */
  retryOf?: string;
  state: MessageState;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  acknowledgedAt?: string;
  respondedAt?: string;
  /**
   * Present only once the exchange reached a terminal state that carries one.
   * A message still in flight has no answer, and rendering an empty string
   * would claim it answered with nothing.
   */
  response?: MessageResponseSummary;
};

export type Bounded<T> = { items: T[]; truncated: boolean };

export type MessageResources = {
  messages: ResourceState<Bounded<AgentMessage>>;
};

export type MessageResourceKey = keyof MessageResources;

export const messageResourceKeys: readonly MessageResourceKey[] = ['messages'];

/** Maps a runtime event type to the message panels it invalidates. */
export function messageResourcesForEvent(eventType: string): MessageResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...messageResourceKeys];
  // Every `message.*` type is a state transition of a record this list renders,
  // including the ones that end it, so none of them is filtered out here.
  if (eventType.startsWith('message.')) return ['messages'];
  return [];
}

export async function loadMessageScope(
  client: DaemonClient,
  keys: readonly MessageResourceKey[],
  options: { signal?: AbortSignal } = {},
): Promise<Partial<MessageResources>> {
  if (!keys.includes('messages')) return {};
  const get = options.signal === undefined ? {} : { signal: options.signal };

  /**
   * One more than the page is requested on purpose.
   *
   * `messageCollectionResponseSchema` carries no `truncated` flag, unlike every
   * other bounded collection the dashboard reads, so asking for `PAGE_SIZE + 1`
   * is the only way to know whether more exist. Without it the view would have
   * to either stay silent about the bound or assert a completeness it cannot
   * prove.
   */
  const result = await client.get(
    `/api/v1/messages?limit=${String(PAGE_SIZE + 1)}`,
    messageCollectionResponseSchema,
    get,
  );

  if (result.state !== 'ready') return { messages: { state: 'unavailable' } };

  const truncated = result.data.messages.length > PAGE_SIZE;
  const items: AgentMessage[] = result.data.messages.slice(0, PAGE_SIZE).map((message) => ({
    id: message.id,
    correlationId: message.correlationId,
    projectId: message.projectId,
    sourceSessionId: message.sourceSessionId,
    sourceAgentId: message.sourceAgentId,
    targetSessionId: message.targetSessionId,
    targetAgentId: message.targetAgentId,
    selectionReason: message.selectionReason,
    kind: message.kind,
    ...(message.subject === undefined ? {} : { subject: message.subject }),
    content: message.content,
    evidenceRequirements: [...(message.evidenceRequirements ?? [])],
    ...(message.retryOf === undefined ? {} : { retryOf: message.retryOf }),
    state: message.state,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    deadlineAt: message.deadlineAt,
    ...(message.acknowledgedAt === undefined ? {} : { acknowledgedAt: message.acknowledgedAt }),
    ...(message.respondedAt === undefined ? {} : { respondedAt: message.respondedAt }),
    ...(message.response === undefined
      ? {}
      : {
          response: {
            status: message.response.status,
            answer: message.response.answer,
            ...(message.response.confidence === undefined
              ? {}
              : { confidence: message.response.confidence }),
            evidenceCount: message.response.evidence.length,
            evidenceTypes: [...new Set(message.response.evidence.map((item) => item.type))],
            verifiedAt: message.response.verifiedAt,
          },
        }),
  }));

  return { messages: { state: 'ready', data: { items, truncated } } };
}
