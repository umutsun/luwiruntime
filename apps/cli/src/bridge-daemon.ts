import {
  MESSAGE_MAX_RESPONSE_BYTES,
  type AgentMessage,
  type AgentMessageResponse,
  type InboxClaimResponse,
  type SessionStatusTarget,
  type WorkLease,
} from '@luwi/protocol';

/**
 * The loopback daemon surface a CLI bridge drives to serve one session's inbox.
 * Shared by the DeepSeek ACP bridge (ADR 0025) and the native inbox bridge
 * (ADR 0031); the DeepSeek variant adds native-identity declaration.
 */
export interface BridgeDaemonClient {
  registerSession(input: {
    projectId: string;
    agentId: string;
    workingDirectory: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
  heartbeatSession(sessionId: string): Promise<void>;
  setSessionStatus(sessionId: string, status: SessionStatusTarget): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  claimInbox(
    sessionId: string,
    request: {
      bridgeInstanceId: string;
      limit: number;
      blockMs: number;
      minIdleMs: number;
    },
  ): Promise<InboxClaimResponse>;
  getMessage(correlationId: string): Promise<AgentMessage>;
  /** Advisory work leases in the bridge's project (ADR 0020), for prompt coordination context. */
  listLeases(projectId: string): Promise<{ leases: readonly WorkLease[]; truncated: boolean }>;
  /** Holder-only release (`POST /api/v1/leases/:leaseId/release`). */
  releaseLease(leaseId: string, sessionId: string): Promise<void>;
  transitionMessage(
    action: 'acknowledge' | 'processing',
    sessionId: string,
    correlationId: string,
  ): Promise<AgentMessage>;
  completeMessage(
    action: 'respond' | 'reject' | 'fail',
    sessionId: string,
    correlationId: string,
    response: AgentMessageResponse,
  ): Promise<AgentMessage>;
}

export function isTerminalMessageState(state: AgentMessage['state']): boolean {
  return (
    state === 'responded' || state === 'rejected' || state === 'failed' || state === 'timed_out'
  );
}

/** Truncate an answer to the protocol's UTF-8 response limit on a character boundary. */
export function boundedAnswer(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MESSAGE_MAX_RESPONSE_BYTES) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > MESSAGE_MAX_RESPONSE_BYTES) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
