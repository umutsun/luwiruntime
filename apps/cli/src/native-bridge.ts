import type { AgentMessageResponse, EvidenceType, MessageKind } from '@luwi/protocol';

import { boundedAnswer, isTerminalMessageState, type BridgeDaemonClient } from './bridge-daemon.js';
import type { NativeAgentName } from './agent-runner.js';
import { providerLaunchArguments, type ProviderLaunchPlan } from './provider-execution-profiles.js';

export { codexMcpBindingArgs } from './provider-execution-profiles.js';

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
  run(input: {
    prompt: string;
    deadlineAt: string;
    signal: AbortSignal;
  }): Promise<NativeBridgeRunResult>;
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
    case 'antigravity':
      // agy is Claude-Code-flavoured: `--print <prompt>`, and its only headless
      // auto-approve is `--dangerously-skip-permissions` (no --allowed-tools), which
      // the operator passes after `--`.
      return ['--print', prompt, ...nativeArgs];
  }
}

/** Materialize the sole variable argument in a validated supervised plan. */
export function supervisedHeadlessArguments(
  plan: ProviderLaunchPlan,
  prompt: string,
): readonly string[] {
  return providerLaunchArguments(plan, prompt);
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
  let claimController: AbortController | undefined;
  let executionController: AbortController | undefined;
  let inFlight: Promise<number> | undefined;

  const isAbortError = (error: unknown): boolean =>
    error instanceof Error && error.name === 'AbortError';
  const throwIfAborted = (signal: AbortSignal): void => {
    if (signal.aborted) throw new DOMException('The native bridge stopped.', 'AbortError');
  };

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
    signal: AbortSignal,
  ): Promise<void> => {
    throwIfAborted(signal);
    sessionForRequest = session;
    let current = await options.daemon.getMessage(correlationId);
    throwIfAborted(signal);
    if (isTerminalMessageState(current.state)) return;
    const recoveredProcessing = current.state === 'processing';
    if (current.state === 'delivered') {
      current = await options.daemon.transitionMessage('acknowledge', session, correlationId);
      throwIfAborted(signal);
    }
    if (current.state === 'acknowledged') {
      current = await options.daemon.transitionMessage('processing', session, correlationId);
      throwIfAborted(signal);
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
      throwIfAborted(signal);
      let run: NativeBridgeRunResult;
      try {
        run = await options.executor.run({ prompt, deadlineAt: current.deadlineAt, signal });
      } catch (error) {
        if (signal.aborted && isAbortError(error)) throw error;
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
      if (stopping) return 0;
      if (inFlight !== undefined) return inFlight;
      const operation = (async (): Promise<number> => {
        const session = options.currentSessionId();
        if (session === undefined) return 0;
        if (!seenSessions.has(session)) {
          seenSessions.add(session);
          await options.daemon.setSessionStatus(session, 'idle');
        }
        if (stopping) return 0;
        claimController = new AbortController();
        let claimed;
        try {
          claimed = await options.daemon.claimInbox(
            session,
            {
              bridgeInstanceId: options.bridgeInstanceId,
              limit: options.claimLimit,
              blockMs: options.claimBlockMs,
              minIdleMs: options.claimMinIdleMs,
            },
            { signal: claimController.signal },
          );
        } catch (error) {
          if (stopping && isAbortError(error)) return 0;
          throw error;
        } finally {
          claimController = undefined;
        }
        for (const item of claimed.items) {
          if (stopping) break;
          if (item.itemKind !== 'request') continue;
          executionController = new AbortController();
          try {
            await processRequest(
              session,
              item.correlationId,
              item.payload.content,
              executionController.signal,
            );
          } catch (error) {
            if (stopping && isAbortError(error)) break;
            throw error;
          } finally {
            executionController = undefined;
          }
        }
        return claimed.items.length;
      })();
      inFlight = operation;
      try {
        return await operation;
      } finally {
        if (inFlight === operation) inFlight = undefined;
      }
    },

    async stop() {
      stopping = true;
      claimController?.abort();
      executionController?.abort();
      const pending = inFlight;
      if (pending !== undefined) {
        try {
          await pending;
        } catch (error) {
          if (!isAbortError(error)) throw error;
        }
      }
    },
  };
}
