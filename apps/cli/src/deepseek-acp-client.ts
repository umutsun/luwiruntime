import {
  CLIENT_METHODS,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk';
import {
  zRequestPermissionRequest,
  zSessionNotification,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import {
  NodeWindowsProcessTreeIo,
  PathExecutableResolver,
  WindowsOwnedProcessTreeCleaner,
  resolveTrustedWindowsUtilities,
  type TrustedWindowsUtilities,
  type WindowsProcessCleanupRequest,
} from '@luwi/adapters';
import { MESSAGE_MAX_RESPONSE_BYTES } from '@luwi/protocol';
import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';

import {
  DeepSeekBridgeStartupCancelledError,
  type DeepSeekAcpFactory,
  type DeepSeekAcpPromptResult,
  type DeepSeekAcpSession,
} from './deepseek-bridge.js';

export type DeepSeekPermissionPolicy = 'reject' | 'allow-once';

export type DeepSeekAcpFactoryOptions = {
  command: string;
  args: string[];
  permission: DeepSeekPermissionPolicy;
  environment: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  cleanupTimeoutMs?: number;
  startupTimeoutMs?: number;
  cancelTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Narrow lifecycle seam used by deterministic Windows cleanup tests. */
  platform?: NodeJS.Platform;
  /** Prevalidated utility seam used only by deterministic lifecycle tests. */
  trustedWindowsUtilities?: TrustedWindowsUtilities;
  /** Narrow owned-tree cleanup seam used by deterministic lifecycle tests. */
  windowsProcessCleanup?: (request: WindowsProcessCleanupRequest) => Promise<boolean>;
};

const DEFAULT_CLOSE_GRACE_MS = 6_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function exitWithin(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, milliseconds);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  maximumFrameBytes: number,
): Stream {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<unknown>({
    async start(controller) {
      const reader = input.getReader();
      let pending = Buffer.alloc(0);
      const parse = (line: Buffer): void => {
        if (line.byteLength > maximumFrameBytes) {
          throw new Error('DeepSeek ACP frame exceeds the configured byte limit.');
        }
        const text = line.toString('utf8').trim();
        if (text === '') return;
        try {
          controller.enqueue(validateInboundMessage(JSON.parse(text) as unknown));
        } catch {
          throw new Error('DeepSeek ACP frame is malformed or unsupported.');
        }
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          pending = Buffer.concat([pending, Buffer.from(value)]);
          for (;;) {
            const newline = pending.indexOf(0x0a);
            if (newline < 0) break;
            parse(pending.subarray(0, newline));
            pending = pending.subarray(newline + 1);
          }
          if (pending.byteLength > maximumFrameBytes) {
            throw new Error('DeepSeek ACP frame exceeds the configured byte limit.');
          }
        }
        if (pending.byteLength > 0) parse(pending);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
  const writable: Stream['writable'] = new WritableStream({
    async write(message) {
      const frame = encoder.encode(`${JSON.stringify(message)}\n`);
      if (frame.byteLength > maximumFrameBytes) {
        throw new Error('LUWI ACP frame exceeds the configured byte limit.');
      }
      const writer = output.getWriter();
      try {
        await writer.write(frame);
      } finally {
        writer.releaseLock();
      }
    },
  });
  return { readable: readable as Stream['readable'], writable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validJsonRpcId(value: unknown): value is string | number | null {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function validateInboundMessage(value: unknown): unknown {
  if (!isRecord(value) || value['jsonrpc'] !== '2.0') {
    throw new Error('invalid envelope');
  }
  if ('method' in value) {
    if (typeof value['method'] !== 'string') throw new Error('invalid method');
    if ('id' in value) {
      if (
        !validJsonRpcId(value['id']) ||
        value['method'] !== CLIENT_METHODS.session_request_permission
      ) {
        throw new Error('unsupported request');
      }
      const parsed = zRequestPermissionRequest.safeParse(value['params']);
      if (!parsed.success) throw new Error('invalid request parameters');
      return { jsonrpc: '2.0', id: value['id'], method: value['method'], params: parsed.data };
    }
    if (value['method'] !== CLIENT_METHODS.session_update) {
      throw new Error('unsupported notification');
    }
    const parsed = zSessionNotification.safeParse(value['params']);
    if (!parsed.success) throw new Error('invalid notification parameters');
    return { jsonrpc: '2.0', method: value['method'], params: parsed.data };
  }
  if (!('id' in value) || !validJsonRpcId(value['id'])) {
    throw new Error('invalid response');
  }
  const hasResult = 'result' in value;
  const hasError = 'error' in value;
  if (hasResult === hasError) throw new Error('invalid response result');
  if (hasResult) return { jsonrpc: '2.0', id: value['id'], result: value['result'] };
  const error = value['error'];
  if (
    !isRecord(error) ||
    typeof error['code'] !== 'number' ||
    !Number.isFinite(error['code']) ||
    typeof error['message'] !== 'string'
  ) {
    throw new Error('invalid error response');
  }
  return {
    jsonrpc: '2.0',
    id: value['id'],
    error: { code: error['code'], message: 'DeepSeek ACP request failed.' },
  };
}

async function closeChild(
  child: ChildProcess,
  graceMs: number,
  cleanupOwnedWindowsTree?: () => Promise<boolean>,
): Promise<void> {
  if (cleanupOwnedWindowsTree !== undefined) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        'DeepSeek ACP owned Windows process tree cleanup could not be verified after the root process exited.',
      );
    }
    let cleaned = false;
    try {
      cleaned = await cleanupOwnedWindowsTree();
    } catch {
      // The caller receives a generic cleanup failure after a final direct-child attempt.
    }
    if (cleaned && (await exitWithin(child, graceMs))) return;
    child.kill('SIGKILL');
    await exitWithin(child, graceMs);
    throw new Error('DeepSeek ACP owned Windows process tree cleanup could not be verified.');
  }
  child.stdin?.end();
  if (await exitWithin(child, graceMs)) return;
  child.kill('SIGTERM');
  if (await exitWithin(child, graceMs)) return;
  child.kill('SIGKILL');
  if (!(await exitWithin(child, graceMs))) {
    throw new Error('DeepSeek ACP subprocess did not exit after forced termination.');
  }
}

export function createDeepSeekAcpFactory(options: DeepSeekAcpFactoryOptions): DeepSeekAcpFactory {
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const platform = options.platform ?? process.platform;
  const cleaner = new WindowsOwnedProcessTreeCleaner(new NodeWindowsProcessTreeIo());
  const windowsProcessCleanup =
    options.windowsProcessCleanup ??
    (async (request: WindowsProcessCleanupRequest) => (await cleaner.cleanup(request)).cleaned);
  return {
    async start(input): Promise<DeepSeekAcpSession> {
      if (!isAbsolute(input.workingDirectory)) {
        throw new Error('DeepSeek ACP working directory must be absolute.');
      }
      if (input.signal.aborted) throw new DeepSeekBridgeStartupCancelledError();
      const windowsUtilities =
        platform === 'win32'
          ? (options.trustedWindowsUtilities ??
            (await resolveTrustedWindowsUtilities(options.environment)))
          : undefined;
      const windowsCommandShim =
        platform === 'win32' &&
        (extname(options.command).toLowerCase() === '.cmd' ||
          extname(options.command).toLowerCase() === '.bat');
      if (windowsCommandShim && windowsUtilities?.cmdPath === undefined) {
        throw new Error('A trusted Windows command interpreter is unavailable.');
      }
      let command = windowsCommandShim ? windowsUtilities!.cmdPath! : options.command;
      const args = windowsCommandShim
        ? ['/d', '/s', '/c', options.command, ...options.args]
        : options.args;
      let rootCanonicalExecutablePath: string | undefined;
      if (platform === 'win32') {
        if (!isAbsolute(command)) {
          const resolved = await new PathExecutableResolver(
            options.environment['PATH'] ?? '',
            platform,
          ).resolve(command);
          if (resolved === undefined) {
            throw new Error('DeepSeek ACP executable could not be resolved through PATH.');
          }
          command = resolved;
        }
        try {
          rootCanonicalExecutablePath = await realpath(command);
          command = rootCanonicalExecutablePath;
        } catch {
          throw new Error('DeepSeek ACP executable identity could not be verified.');
        }
      }
      const rootExecutableName = basename(command);
      const rootSpawnedAtMs = Date.now();
      const child = spawn(command, args, {
        cwd: input.workingDirectory,
        env: { ...options.environment, ...input.environment },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });
      const rootObservedBeforeMs = Date.now();
      const rootParentPid = process.pid;
      const cleanupOwnedWindowsTree =
        platform === 'win32' && child.pid !== undefined
          ? async () =>
              await windowsProcessCleanup({
                rootPid: child.pid!,
                rootParentPid,
                rootExecutableName,
                rootSpawnedAtMs,
                rootObservedBeforeMs,
                rootCanonicalExecutablePath,
                taskkillPath: windowsUtilities?.taskkillPath,
                powershellPath: windowsUtilities?.powershellPath,
                timeoutMs: cleanupTimeoutMs,
              })
          : undefined;
      if (child.stdin === null || child.stdout === null) {
        child.kill();
        throw new Error('DeepSeek ACP subprocess did not expose protocol streams.');
      }
      const childClosed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => resolve());
      });

      let remoteSessionId: string | undefined;
      let promptText = '';
      let promptBytes = 0;
      let prompting = false;
      let closing = false;
      let closePromise: Promise<void> | undefined;

      const client = (): Client => ({
        sessionUpdate(params: SessionNotification): Promise<void> {
          if (params.sessionId !== remoteSessionId) return Promise.resolve();
          const update = params.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            for (const character of update.content.text) {
              const characterBytes = Buffer.byteLength(character, 'utf8');
              if (promptBytes + characterBytes > MESSAGE_MAX_RESPONSE_BYTES) break;
              promptText += character;
              promptBytes += characterBytes;
            }
          }
          return Promise.resolve();
        },
        requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
          if (closing || options.permission === 'reject') {
            return Promise.resolve({ outcome: { outcome: 'cancelled' } });
          }
          const allowed = params.options.find((candidate) => candidate.kind === 'allow_once');
          return Promise.resolve(
            allowed === undefined
              ? { outcome: { outcome: 'cancelled' } }
              : { outcome: { outcome: 'selected', optionId: allowed.optionId } },
          );
        },
      });

      const connection = new ClientSideConnection(
        client,
        boundedNdJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          maxFrameBytes,
        ),
      );
      const childUnavailable = childClosed.then((): never => {
        throw new Error('DeepSeek ACP subprocess closed during startup.');
      });
      childUnavailable.catch(() => undefined);
      let rejectStartupCancellation: ((error: Error) => void) | undefined;
      const startupCancelled = new Promise<never>((_resolve, reject) => {
        rejectStartupCancellation = reject;
      });
      const onStartupAbort = (): void => {
        rejectStartupCancellation?.(new DeepSeekBridgeStartupCancelledError());
      };
      input.signal.addEventListener('abort', onStartupAbort, { once: true });
      if (input.signal.aborted) onStartupAbort();

      try {
        await withTimeout(
          Promise.race([
            (async () => {
              await connection.initialize({
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {},
              });
              const created = await connection.newSession({
                cwd: input.workingDirectory,
                mcpServers: [],
              });
              if (created.sessionId.trim() === '') {
                throw new Error('DeepSeek ACP returned an empty session id.');
              }
              remoteSessionId = created.sessionId;
            })(),
            childUnavailable,
            startupCancelled,
          ]),
          startupTimeoutMs,
          'DeepSeek ACP startup timed out.',
        );
      } catch (error) {
        closing = true;
        await closeChild(child, closeGraceMs, cleanupOwnedWindowsTree);
        throw toError(error);
      } finally {
        input.signal.removeEventListener('abort', onStartupAbort);
      }

      if (remoteSessionId === undefined) {
        await closeChild(child, closeGraceMs, cleanupOwnedWindowsTree);
        throw new Error('DeepSeek ACP startup completed without a session id.');
      }
      const sessionId = remoteSessionId;

      return {
        sessionId,
        closed: childClosed,
        async prompt(content: string, deadlineAt: string): Promise<DeepSeekAcpPromptResult> {
          if (closing) throw new Error('DeepSeek ACP session is closing.');
          if (prompting) throw new Error('DeepSeek ACP permits only one in-flight prompt.');
          prompting = true;
          promptText = '';
          promptBytes = 0;
          try {
            const operation = connection.prompt({
              sessionId,
              prompt: [{ type: 'text', text: content }],
            });
            operation.catch(() => undefined);
            const remainingMs = Math.max(1, Date.parse(deadlineAt) - Date.now());
            const result = await withTimeout(
              Promise.race([
                operation,
                childClosed.then((): never => {
                  throw new Error('DeepSeek ACP subprocess closed during a prompt.');
                }),
              ]),
              remainingMs,
              'DeepSeek ACP prompt exceeded its LUWI message deadline.',
              () => {
                void connection.cancel({ sessionId }).catch(() => undefined);
              },
            );
            return { text: promptText, stopReason: result.stopReason };
          } finally {
            prompting = false;
          }
        },
        async cancel() {
          if (closing) return;
          await withTimeout(
            connection.cancel({ sessionId }),
            cancelTimeoutMs,
            'DeepSeek ACP cancellation timed out.',
          );
        },
        close() {
          if (closePromise !== undefined) return closePromise;
          closing = true;
          closePromise = closeChild(child, closeGraceMs, cleanupOwnedWindowsTree);
          return closePromise;
        },
      };
    },
  };
}
