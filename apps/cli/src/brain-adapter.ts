import type { NativeAgentName, NativeAgentProcessRunner } from './agent-runner.js';
import { nativeHeadlessArguments } from './native-bridge.js';

/**
 * The brain behind the orchestrator (ADR 0035): something that answers one
 * bounded question with text. Two shapes exist — LuwiBot's own WebSocket, and
 * one headless run of a native CLI — and the bridge treats them identically.
 * A brain answers; it never acts, and it is never handed a tool by LUWI.
 */

export type BrainAnswer = { text: string; ms: number };

export interface BrainAdapter {
  readonly name: string;
  judge(prompt: string, options: { timeoutMs: number }): Promise<BrainAnswer>;
}

export class BrainError extends Error {
  readonly code: 'BRAIN_UNAVAILABLE' | 'BRAIN_TIMEOUT' | 'BRAIN_EMPTY';

  constructor(code: BrainError['code'], message: string) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
  }
}

/** The minimum a socket needs; the real WebSocket has all of it. */
export interface BrainSocket {
  readonly readyState: number;
  addEventListener(
    event: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

function messageText(incoming: unknown): string {
  const data = (incoming as { data?: unknown } | undefined)?.data;
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return '';
}

/**
 * LuwiBot over its chat WebSocket: one fresh socket per judgment, one
 * `{ message }` frame in, one `{ reply } | { error }` frame out. No history is
 * sent — the context LUWI assembled is the whole conversation, and whatever
 * memory the bot keeps is its own.
 */
export function createWebSocketBrain(options: {
  url: string;
  createSocket: (url: string) => BrainSocket;
  setTimeout: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
  now?: () => number;
}): BrainAdapter {
  const now = options.now ?? Date.now;
  return {
    name: 'luwibot-ws',
    judge: (prompt, { timeoutMs }) =>
      new Promise<BrainAnswer>((resolve, reject) => {
        const started = now();
        let settled = false;
        const socket = options.createSocket(options.url);
        const finish = (outcome: { answer?: BrainAnswer; error?: Error }): void => {
          if (settled) return;
          settled = true;
          options.clearTimeout(timer);
          try {
            socket.close(1000, 'judgment complete');
          } catch {
            // A socket that already closed has nothing to release.
          }
          if (outcome.error !== undefined) reject(outcome.error);
          else if (outcome.answer !== undefined) resolve(outcome.answer);
        };
        const timer = options.setTimeout(() => {
          finish({
            error: new BrainError(
              'BRAIN_TIMEOUT',
              `LuwiBot did not answer within ${String(timeoutMs)} ms.`,
            ),
          });
        }, timeoutMs);
        socket.addEventListener('open', () => {
          try {
            // `json: true` marks this as an autopilot judgment, not a chat turn, so
            // LuwiBot answers in strict JSON mode instead of conversational prose —
            // otherwise the plan/review answer is not a JSON object and the goal
            // escalates `brain_invalid`.
            socket.send(JSON.stringify({ message: prompt, history: [], json: true }));
          } catch (error) {
            finish({
              error: new BrainError(
                'BRAIN_UNAVAILABLE',
                `LuwiBot socket send failed: ${(error as Error).message}`,
              ),
            });
          }
        });
        socket.addEventListener('error', () => {
          finish({
            error: new BrainError('BRAIN_UNAVAILABLE', `LuwiBot is unreachable at ${options.url}.`),
          });
        });
        socket.addEventListener('close', () => {
          finish({
            error: new BrainError(
              'BRAIN_UNAVAILABLE',
              'LuwiBot closed the socket before answering.',
            ),
          });
        });
        socket.addEventListener('message', (incoming) => {
          let parsed: { reply?: unknown; error?: unknown };
          try {
            parsed = JSON.parse(messageText(incoming)) as { reply?: unknown; error?: unknown };
          } catch {
            finish({
              error: new BrainError(
                'BRAIN_EMPTY',
                'LuwiBot answered with something that is not JSON.',
              ),
            });
            return;
          }
          if (typeof parsed.error === 'string') {
            finish({
              error: new BrainError(
                'BRAIN_UNAVAILABLE',
                `LuwiBot answered with an error: ${parsed.error}`,
              ),
            });
            return;
          }
          const text = typeof parsed.reply === 'string' ? parsed.reply : '';
          if (text.trim() === '') {
            finish({
              error: new BrainError('BRAIN_EMPTY', 'LuwiBot answered with an empty reply.'),
            });
            return;
          }
          finish({ answer: { text, ms: now() - started } });
        });
      }),
  };
}

/**
 * One headless run of a native CLI per judgment, through the same process
 * runner the worker bridge uses. Everything after `--` on the orchestrator's
 * command line reaches the CLI unchanged: for a judgment it should grant no
 * write tool, because the brain is not supposed to hold a pen.
 */
export function createNativeBrain(options: {
  provider: NativeAgentName;
  executable: string;
  workingDirectory: string;
  nativeArgs: readonly string[];
  runner: NativeAgentProcessRunner;
  environment: Readonly<Record<string, string | undefined>>;
  setTimeout: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
  onDiagnostic?: (error: unknown) => void;
  now?: () => number;
}): BrainAdapter {
  const now = options.now ?? Date.now;
  return {
    name: options.provider,
    async judge(prompt, { timeoutMs }) {
      const { EventEmitter } = await import('node:events');
      const signals = new EventEmitter();
      const started = now();
      let output = '';
      let timedOut = false;
      const timer = options.setTimeout(() => {
        timedOut = true;
        signals.emit('SIGTERM');
      }, timeoutMs);
      // The brain must not inherit a LUWI session: a judgment is not a worker
      // run, and a bound MCP server would hand it tools it must not have.
      const environment: Record<string, string | undefined> = { ...options.environment };
      delete environment['LUWI_SESSION_ID'];
      delete environment['LUWI_DAEMON_URL'];
      try {
        const result = await options.runner.run({
          executable: options.executable,
          args: nativeHeadlessArguments(options.provider, prompt, options.nativeArgs),
          workingDirectory: options.workingDirectory,
          environment,
          signals,
          captureOutput: (chunk) => {
            output = (output + chunk).slice(-200_000);
          },
          ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
        });
        if (timedOut) {
          throw new BrainError(
            'BRAIN_TIMEOUT',
            `The ${options.provider} judgment ran past ${String(timeoutMs)} ms and was stopped.`,
          );
        }
        if (result.exitCode !== 0 && output.trim() === '') {
          throw new BrainError(
            'BRAIN_UNAVAILABLE',
            `The ${options.provider} judgment exited with code ${String(result.exitCode)} and no output.`,
          );
        }
        if (output.trim() === '') {
          throw new BrainError(
            'BRAIN_EMPTY',
            `The ${options.provider} judgment produced no output.`,
          );
        }
        return { text: output, ms: now() - started };
      } finally {
        options.clearTimeout(timer);
      }
    },
  };
}
