import type { AgentMessageResponse, EvidenceType, MessageKind } from '@luwi/protocol';

import { boundedAnswer, isTerminalMessageState, type BridgeDaemonClient } from './bridge-daemon.js';
import type { NativeAgentName } from './agent-runner.js';

/**
 * ADR 0031: serve one LUWI session's durable inbox unattended by running the
 * native CLI headless once per message. The child is expected to complete the
 * message through the bound `luwi-runtime` MCP server; the bridge completes only
 * what the child left unfinished, and never writes `answered`.
 */

/** The Windows command line caps at 32 767 characters; stay clear of it. */
const MAX_PROMPT_BYTES = 30_000;

export type NativeBridgeRunResult = {
  /** `completed` = the child exited on its own; `deadline` = the deadline timer stopped it. */
  result: 'completed' | 'deadline';
  exitCode: number;
  outputTail: string;
};

export interface NativeBridgeExecutor {
  run(input: { prompt: string; deadlineAt: string }): Promise<NativeBridgeRunResult>;
}

export type NativeBridgeOptions = {
  daemon: BridgeDaemonClient;
  executor: NativeBridgeExecutor;
  /** The session the bootstrap currently owns; re-read every poll so a rotation is picked up. */
  currentSessionId: () => string | undefined;
  agentId: string;
  bridgeInstanceId: string;
  claimLimit: number;
  claimBlockMs: number;
  claimMinIdleMs: number;
  now?: () => string;
  report?: (line: object) => void;
};

export interface NativeBridge {
  pollOnce(): Promise<number>;
  stop(): Promise<void>;
}

export function nativeHeadlessArguments(
  provider: NativeAgentName,
  prompt: string,
  nativeArgs: readonly string[],
): string[] {
  switch (provider) {
    case 'claude':
      // `--allowedTools` is variadic and would swallow a trailing prompt.
      return ['--print', prompt, ...nativeArgs];
    case 'codex':
      // `codex exec [OPTIONS] [PROMPT]` — the prompt is the final positional.
      return ['exec', ...nativeArgs, prompt];
    case 'gemini':
      return ['--prompt', prompt, ...nativeArgs];
  }
}

export function framePrompt(input: {
  correlationId: string;
  kind: MessageKind;
  sourceAgentId: string;
  subject?: string;
  sessionId: string;
  agentId: string;
  evidenceRequirements: readonly EvidenceType[];
  content: string;
}): string {
  const evidence =
    input.evidenceRequirements.length === 0 ? 'none' : input.evidenceRequirements.join(', ');
  return [
    `LUWI message ${input.correlationId} (${input.kind}) from agent ${input.sourceAgentId}, subject: ${input.subject ?? 'none'}.`,
    `You are LUWI session ${input.sessionId} for agent ${input.agentId}. When you are done, report`,
    `through the luwi-runtime MCP tools: call luwi_respond_to_message with correlationId`,
    `"${input.correlationId}" and a status of answered, partially_answered, rejected or failed. If`,
    `those tools are unavailable, print your final answer as plain text. Evidence requested: ${evidence}.`,
    '',
    input.content,
  ].join('\n');
}

function withTail(reason: string, tail: string): string {
  const trimmed = tail.trim();
  return trimmed === '' ? reason : `${reason}\n\n[native output tail]\n${trimmed}`;
}

export function createNativeBridge(options: NativeBridgeOptions): NativeBridge {
  const now = options.now ?? (() => new Date().toISOString());
  const seenSessions = new Set<string>();
  let stopping = false;

  const failure = (answer: string): AgentMessageResponse => ({
    status: 'failed',
    answer: boundedAnswer(answer),
    evidence: [],
    verifiedAt: now(),
  });

  const completeSafely = async (
    correlationId: string,
    response: AgentMessageResponse,
  ): Promise<void> => {
    try {
      await options.daemon.completeMessage(
        'fail',
        currentSessionOrThrow(),
        correlationId,
        response,
      );
    } catch (error) {
      const latest = await options.daemon.getMessage(correlationId);
      if (!isTerminalMessageState(latest.state)) throw error;
    }
  };

  let sessionForRequest: string | undefined;
  const currentSessionOrThrow = (): string => {
    if (sessionForRequest === undefined) throw new Error('The native bridge has no bound session.');
    return sessionForRequest;
  };

  const processRequest = async (
    session: string,
    correlationId: string,
    payloadContent: string,
  ): Promise<void> => {
    sessionForRequest = session;
    let current = await options.daemon.getMessage(correlationId);
    if (isTerminalMessageState(current.state)) return;
    const recoveredProcessing = current.state === 'processing';
    if (current.state === 'delivered') {
      current = await options.daemon.transitionMessage('acknowledge', session, correlationId);
    }
    if (current.state === 'acknowledged') {
      current = await options.daemon.transitionMessage('processing', session, correlationId);
    }
    if (current.state !== 'processing') return;

    if (recoveredProcessing) {
      await completeSafely(
        correlationId,
        failure(
          'Recovered native processing work was not replayed because its prior side effects cannot be proven idempotent.',
        ),
      );
      return;
    }

    const prompt = framePrompt({
      correlationId,
      kind: current.kind,
      sourceAgentId: current.sourceAgentId,
      ...(current.subject === undefined ? {} : { subject: current.subject }),
      sessionId: session,
      agentId: options.agentId,
      evidenceRequirements: current.evidenceRequirements ?? [],
      content: payloadContent,
    });
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      await completeSafely(
        correlationId,
        failure(
          `The framed message prompt is too long for a headless native run (limit ${MAX_PROMPT_BYTES} bytes).`,
        ),
      );
      return;
    }

    await options.daemon.setSessionStatus(session, 'tool_running');
    try {
      let run: NativeBridgeRunResult;
      try {
        run = await options.executor.run({ prompt, deadlineAt: current.deadlineAt });
      } catch (error) {
        await completeSafely(
          correlationId,
          failure('The native agent process could not start or exited abnormally.'),
        );
        throw error;
      }
      const latest = await options.daemon.getMessage(correlationId);
      if (isTerminalMessageState(latest.state)) {
        options.report?.({ correlationId, completedBy: 'native', exitCode: run.exitCode });
        return;
      }
      let reason: string;
      if (stopping) {
        reason = 'The native agent bridge stopped before the agent finished the message.';
      } else if (run.result === 'deadline') {
        reason = 'The native agent was stopped at the message deadline before completing it.';
      } else {
        reason = `The native agent exited (code ${run.exitCode}) without completing the message.`;
      }
      await completeSafely(correlationId, failure(withTail(reason, run.outputTail)));
      options.report?.({ correlationId, completedBy: 'bridge', reason, exitCode: run.exitCode });
    } finally {
      if (!stopping) await options.daemon.setSessionStatus(session, 'idle');
    }
  };

  return {
    async pollOnce() {
      const session = options.currentSessionId();
      if (session === undefined) return 0;
      if (!seenSessions.has(session)) {
        seenSessions.add(session);
        await options.daemon.setSessionStatus(session, 'idle');
      }
      const claimed = await options.daemon.claimInbox(session, {
        bridgeInstanceId: options.bridgeInstanceId,
        limit: options.claimLimit,
        blockMs: options.claimBlockMs,
        minIdleMs: options.claimMinIdleMs,
      });
      for (const item of claimed.items) {
        if (stopping) break;
        if (item.itemKind !== 'request') continue;
        await processRequest(session, item.correlationId, item.payload.content);
      }
      return claimed.items.length;
    },

    async stop() {
      stopping = true;
    },
  };
}
