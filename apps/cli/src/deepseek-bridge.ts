import type { AgentMessageResponse, NativeSessionRef } from '@luwi/protocol';

import {
  boundedAnswer,
  isTerminalMessageState as terminal,
  type BridgeDaemonClient,
} from './bridge-daemon.js';

export type DeepSeekAcpPromptResult = {
  text: string;
  stopReason: string;
};

export interface DeepSeekAcpSession {
  readonly sessionId: string;
  readonly closed: Promise<void>;
  prompt(content: string, deadlineAt: string): Promise<DeepSeekAcpPromptResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface DeepSeekAcpFactory {
  start(input: {
    workingDirectory: string;
    signal: AbortSignal;
    environment: {
      LUWI_DAEMON_URL: string;
      LUWI_SESSION_ID: string;
    };
  }): Promise<DeepSeekAcpSession>;
}

export class DeepSeekBridgeStartupCancelledError extends Error {
  constructor() {
    super('DeepSeek bridge startup was cancelled.');
    this.name = 'DeepSeekBridgeStartupCancelledError';
  }
}

export class DeepSeekBridgeStartupCleanupError extends AggregateError {
  constructor(startupError: unknown, cleanupError: unknown) {
    super(
      [startupError, cleanupError],
      'DeepSeek bridge startup failed and owned-resource cleanup could not be verified.',
    );
    this.name = 'DeepSeekBridgeStartupCleanupError';
  }
}

export interface DeepSeekBridgeDaemonClient extends BridgeDaemonClient {
  declareNative(sessionId: string, native: NativeSessionRef): Promise<void>;
}

export type DeepSeekBridgeOptions = {
  daemon: DeepSeekBridgeDaemonClient;
  acp: DeepSeekAcpFactory;
  daemonUrl: string;
  projectId: string;
  agentId: string;
  workingDirectory: string;
  bridgeInstanceId: string;
  claimLimit: number;
  claimBlockMs: number;
  claimMinIdleMs: number;
  now?: () => string;
};

export interface DeepSeekBridge {
  readonly sessionId: string | undefined;
  start(): Promise<void>;
  heartbeat(): Promise<void>;
  pollOnce(): Promise<number>;
  stop(): Promise<void>;
}

const NATIVE_ADAPTER_ID = 'deepseek-harness-acp-v1';

function terminalResponse(
  result: DeepSeekAcpPromptResult,
  verifiedAt: string,
): { action: 'respond' | 'reject' | 'fail'; response: AgentMessageResponse } {
  const text = result.text.trim();
  if (result.stopReason === 'end_turn' && text !== '') {
    return {
      action: 'respond',
      response: { status: 'answered', answer: boundedAnswer(text), evidence: [], verifiedAt },
    };
  }
  if (result.stopReason === 'refusal') {
    return {
      action: 'reject',
      response: {
        status: 'rejected',
        answer: boundedAnswer(text === '' ? 'DeepSeek Harness refused the ACP prompt.' : text),
        evidence: [],
        verifiedAt,
      },
    };
  }
  const reason = result.stopReason.replaceAll('_', ' ');
  return {
    action: 'fail',
    response: {
      status: 'failed',
      answer: boundedAnswer(
        text === ''
          ? `DeepSeek Harness stopped without a committed answer (${reason}).`
          : `${text}\n\n[ACP stop reason: ${reason}]`,
      ),
      evidence: [],
      verifiedAt,
    },
  };
}

export function createDeepSeekBridge(options: DeepSeekBridgeOptions): DeepSeekBridge {
  const now = options.now ?? (() => new Date().toISOString());
  let luwiSessionId: string | undefined;
  let acpSession: DeepSeekAcpSession | undefined;
  let acpClosed = false;
  let stopping = false;
  let startupAbort: AbortController | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const shutdown = async (): Promise<void> => {
    stopping = true;
    startupAbort?.abort();
    const cleanupErrors: unknown[] = [];
    const currentAcp = acpSession;
    acpSession = undefined;
    if (currentAcp !== undefined) {
      await currentAcp.cancel().catch(() => undefined);
      try {
        await currentAcp.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const currentLuwi = luwiSessionId;
    luwiSessionId = undefined;
    if (currentLuwi !== undefined) {
      try {
        await options.daemon.closeSession(currentLuwi);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'DeepSeek bridge owned-resource cleanup failed.');
    }
  };

  const requireStarted = (): { luwi: string; acp: DeepSeekAcpSession } => {
    if (luwiSessionId === undefined || acpSession === undefined || stopping || acpClosed) {
      throw new Error('DeepSeek bridge is not running.');
    }
    return { luwi: luwiSessionId, acp: acpSession };
  };

  const processRequest = async (
    luwi: string,
    acp: DeepSeekAcpSession,
    correlationId: string,
    content: string,
    deadlineAt: string,
  ): Promise<void> => {
    let current = await options.daemon.getMessage(correlationId);
    if (terminal(current.state)) return;
    const recoveredProcessing = current.state === 'processing';
    if (current.state === 'delivered') {
      current = await options.daemon.transitionMessage('acknowledge', luwi, correlationId);
    }
    if (current.state === 'acknowledged') {
      current = await options.daemon.transitionMessage('processing', luwi, correlationId);
    }
    if (current.state !== 'processing') return;

    const completeSafely = async (
      action: 'respond' | 'reject' | 'fail',
      response: AgentMessageResponse,
    ): Promise<void> => {
      try {
        await options.daemon.completeMessage(action, luwi, correlationId, response);
      } catch (error) {
        const latest = await options.daemon.getMessage(correlationId);
        if (!terminal(latest.state)) throw error;
      }
    };

    if (recoveredProcessing) {
      await completeSafely('fail', {
        status: 'failed',
        answer:
          'Recovered DeepSeek processing work was not replayed because its prior side effects cannot be proven idempotent.',
        evidence: [],
        verifiedAt: now(),
      });
      return;
    }

    await options.daemon.setSessionStatus(luwi, 'thinking');
    try {
      let result: DeepSeekAcpPromptResult;
      try {
        result = await acp.prompt(content, deadlineAt);
      } catch (error) {
        if (stopping) return;
        const failure: AgentMessageResponse = {
          status: 'failed',
          answer: 'DeepSeek Harness ACP prompt failed.',
          evidence: [],
          verifiedAt: now(),
        };
        await completeSafely('fail', failure);
        throw error;
      }
      if (stopping && result.stopReason === 'cancelled') return;
      const completion = terminalResponse(result, now());
      await completeSafely(completion.action, completion.response);
    } finally {
      if (!stopping) await options.daemon.setSessionStatus(luwi, 'idle');
    }
  };

  return {
    get sessionId() {
      return luwiSessionId;
    },

    start() {
      if (startPromise !== undefined) return startPromise;
      stopping = false;
      acpClosed = false;
      stopPromise = undefined;
      startupAbort = new AbortController();
      startPromise = (async () => {
        const registered = await options.daemon.registerSession({
          projectId: options.projectId,
          agentId: options.agentId,
          workingDirectory: options.workingDirectory,
          // `bridge` is a reserved key the daemon writes only for a slot-owning
          // native bridge; this experimental harness names itself differently.
          metadata: { harness: 'deepseek-acp', experimental: true },
        });
        luwiSessionId = registered.id;
        try {
          if (stopping) throw new DeepSeekBridgeStartupCancelledError();
          acpSession = await options.acp.start({
            workingDirectory: options.workingDirectory,
            signal: startupAbort!.signal,
            environment: {
              LUWI_DAEMON_URL: options.daemonUrl,
              LUWI_SESSION_ID: registered.id,
            },
          });
          if (stopping) throw new DeepSeekBridgeStartupCancelledError();
          void acpSession.closed.then(
            () => {
              if (!stopping) acpClosed = true;
            },
            () => {
              if (!stopping) acpClosed = true;
            },
          );
          await options.daemon.declareNative(registered.id, {
            adapterId: NATIVE_ADAPTER_ID,
            nativeSessionId: acpSession.sessionId,
          });
          if (stopping) throw new DeepSeekBridgeStartupCancelledError();
          await options.daemon.setSessionStatus(registered.id, 'idle');
        } catch (error) {
          try {
            await shutdown();
          } catch (cleanupError) {
            throw new DeepSeekBridgeStartupCleanupError(error, cleanupError);
          }
          throw error;
        } finally {
          startupAbort = undefined;
        }
      })();
      return startPromise;
    },

    async heartbeat() {
      const { luwi } = requireStarted();
      await options.daemon.heartbeatSession(luwi);
    },

    async pollOnce() {
      const { luwi, acp } = requireStarted();
      const claimed = await Promise.race([
        options.daemon.claimInbox(luwi, {
          bridgeInstanceId: options.bridgeInstanceId,
          limit: options.claimLimit,
          blockMs: options.claimBlockMs,
          minIdleMs: options.claimMinIdleMs,
        }),
        acp.closed.then((): never => {
          throw new Error('DeepSeek ACP subprocess closed unexpectedly.');
        }),
      ]);
      for (const item of claimed.items) {
        if (stopping) break;
        if (item.itemKind !== 'request') continue;
        await processRequest(
          luwi,
          acp,
          item.correlationId,
          item.payload.content,
          item.payload.deadlineAt,
        );
      }
      return claimed.items.length;
    },

    stop() {
      stopping = true;
      startupAbort?.abort();
      if (stopPromise !== undefined) return stopPromise;
      const pendingStart = startPromise;
      stopPromise = (async () => {
        try {
          await pendingStart;
        } catch (error) {
          if (!(error instanceof DeepSeekBridgeStartupCancelledError)) throw error;
        }
        await shutdown();
      })();
      return stopPromise;
    },
  };
}
