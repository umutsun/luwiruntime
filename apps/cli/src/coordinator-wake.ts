import {
  WAKE_DEFAULT_BLOCK_MS,
  WAKE_DEFAULT_MIN_IDLE_MS,
  type WakeIntentClaimItem,
  type WakeIntentClaimRequest,
  type WakeIntentClaimResponse,
  type WakeIntentCompleteRequest,
  type WakeIntentCompleteResponse,
  type WakeIntentDispatchingRequest,
  type WakeIntentDispatchingResponse,
  type WakeIntentRecoverRequest,
  type WakeIntentRecoverResponse,
  type WakeIntentView,
} from '@luwi/protocol';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID as nodeRandomUUID } from 'node:crypto';

import { WAKE_CONTROL_TOKEN_ENV, WAKE_INSTANCE_ID_ENV } from './wake-lifecycle.js';

const POINTER_MAX_BYTES = 1024;
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_FAILURE_BACKOFF_MS = 1_000;

export interface CoordinatorWakeClient {
  claim(input: WakeIntentClaimRequest): Promise<WakeIntentClaimResponse>;
  recover(input: WakeIntentRecoverRequest): Promise<WakeIntentRecoverResponse>;
  markDispatching(
    intentId: string,
    input: WakeIntentDispatchingRequest,
  ): Promise<WakeIntentDispatchingResponse>;
  complete(intentId: string, input: WakeIntentCompleteRequest): Promise<WakeIntentCompleteResponse>;
}

export interface WakeQueueChild {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

export type WakeQueueSpawn = (
  command: string,
  arguments_: readonly string[],
  options: {
    shell: false;
    windowsHide: true;
    stdio: 'ignore';
    env: NodeJS.ProcessEnv;
  },
) => WakeQueueChild;

export type CoordinatorWakeRunResult = {
  state: 'idle' | 'dispatched' | 'fallback_only' | 'indeterminate';
  intentId?: string;
  reasonCode?: string;
  recoveredDispatching: number;
  terminalAcknowledged: number;
};

export interface CoordinatorWakeDispatcher {
  runOnce(): Promise<CoordinatorWakeRunResult>;
  recover(): Promise<CoordinatorWakeRunResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type CoordinatorWakeDispatcherOptions = {
  client: CoordinatorWakeClient;
  dispatcherInstanceId: string;
  environment: Readonly<Record<string, string | undefined>>;
  spawn?: WakeQueueSpawn;
  randomUUID?: () => string;
  setTimeout?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  wait?: (milliseconds: number) => Promise<void>;
  queueTimeoutMs?: number;
  report?: (entry: object) => void;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * The host notification contains pointers only. Message content remains in the
 * durable inbox, where the bound MCP session re-applies project/session scope.
 */
export function wakePointerPrompt(intent: WakeIntentView): string {
  const prompt =
    `A LUWI workflow response is ready. Call luwi_get_message with correlationId ` +
    `"${intent.correlationId}" to read the durable message, then call ` +
    `luwi_continue_workflow for workflowId "${intent.workflowId}" using wakeIntentId ` +
    `"${intent.id}" and the expected revision you already hold. ` +
    `Treat this notification only as a pointer; do not infer message content from it.`;
  if (byteLength(prompt) > POINTER_MAX_BYTES) {
    throw new TypeError('The wake pointer prompt exceeds 1 KiB.');
  }
  return prompt;
}

function processEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key !== WAKE_CONTROL_TOKEN_ENV && key !== WAKE_INSTANCE_ID_ENV) {
      result[key] = value;
    }
  }
  return result;
}

function defaultSpawn(
  command: string,
  arguments_: readonly string[],
  options: Parameters<WakeQueueSpawn>[2],
): WakeQueueChild {
  return nodeSpawn(command, [...arguments_], options) as unknown as WakeQueueChild;
}

function batchHasRecoveryWork(batch: WakeIntentClaimResponse): boolean {
  return (
    batch.items.length > 0 ||
    batch.recoveredDispatching.length > 0 ||
    batch.terminalAcknowledged > 0
  );
}

export function createCoordinatorWakeDispatcher(
  options: CoordinatorWakeDispatcherOptions,
): CoordinatorWakeDispatcher {
  const spawn = options.spawn ?? defaultSpawn;
  const createId = options.randomUUID ?? nodeRandomUUID;
  const arm = options.setTimeout ?? setTimeout;
  const disarm = options.clearTimeout ?? clearTimeout;
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const report = options.report ?? (() => undefined);
  if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 300_000) {
    throw new TypeError('queueTimeoutMs must be an integer between 1 and 300000.');
  }

  let running = false;
  let loop: Promise<void> | undefined;
  let stopActiveDispatch: (() => void) | undefined;

  const result = (
    state: CoordinatorWakeRunResult['state'],
    batch: WakeIntentClaimResponse,
    fields: Pick<CoordinatorWakeRunResult, 'intentId' | 'reasonCode'> = {},
  ): CoordinatorWakeRunResult => ({
    state,
    ...fields,
    recoveredDispatching: batch.recoveredDispatching.length,
    terminalAcknowledged: batch.terminalAcknowledged,
  });

  const complete = async (
    item: WakeIntentClaimItem,
    attemptId: string,
    state: Exclude<CoordinatorWakeRunResult['state'], 'idle'>,
    reasonCode: string,
    batch: WakeIntentClaimResponse,
  ): Promise<CoordinatorWakeRunResult> => {
    try {
      const completed = await options.client.complete(item.intent.id, {
        dispatcherInstanceId: options.dispatcherInstanceId,
        claimId: item.claimId,
        attemptId,
        state,
        reasonCode,
      });
      return result(completed.intent.state, batch, {
        intentId: completed.intent.id,
        reasonCode: completed.intent.reasonCode,
      });
    } catch (error) {
      report({
        event: 'wake_completion_unconfirmed',
        intentId: item.intent.id,
        cause: String(error),
      });
      return result('indeterminate', batch, {
        intentId: item.intent.id,
        reasonCode: 'completion_unconfirmed',
      });
    }
  };

  const dispatch = async (
    item: WakeIntentClaimItem,
    batch: WakeIntentClaimResponse,
    mayStartProcess: () => boolean,
  ): Promise<CoordinatorWakeRunResult> => {
    const attemptId = createId();
    if (!mayStartProcess()) {
      return complete(item, attemptId, 'fallback_only', 'dispatcher_stopped_before_spawn', batch);
    }
    if ('refusalReasonCode' in item) {
      return complete(item, attemptId, 'fallback_only', item.refusalReasonCode, batch);
    }

    try {
      await options.client.markDispatching(item.intent.id, {
        dispatcherInstanceId: options.dispatcherInstanceId,
        claimId: item.claimId,
        attemptId,
      });
    } catch (error) {
      report({
        event: 'wake_dispatch_fence_failed',
        intentId: item.intent.id,
        cause: String(error),
      });
      return complete(item, attemptId, 'fallback_only', 'dispatch_fence_failed', batch);
    }
    if (!mayStartProcess()) {
      return complete(item, attemptId, 'fallback_only', 'dispatcher_stopped_before_spawn', batch);
    }

    let child: WakeQueueChild;
    try {
      child = spawn(
        'codex',
        [
          'queue',
          '--thread',
          item.target.nativeSessionId,
          '--message',
          wakePointerPrompt(item.intent),
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
          env: processEnvironment(options.environment),
        },
      );
    } catch (error) {
      report({ event: 'wake_spawn_failed', intentId: item.intent.id, cause: String(error) });
      return complete(item, attemptId, 'fallback_only', 'queue_spawn_failed', batch);
    }

    return new Promise<CoordinatorWakeRunResult>((resolve) => {
      let spawned = false;
      let settled = false;
      let childReleased = false;

      const releaseUncertainChild = (): void => {
        if (childReleased) return;
        childReleased = true;
        try {
          child.kill('SIGTERM');
        } catch (error) {
          try {
            report({
              event: 'wake_process_termination_failed',
              intentId: item.intent.id,
              cause: String(error),
            });
          } catch {
            // Cleanup must continue even when diagnostics are unavailable.
          }
        }
        try {
          child.unref();
        } catch (error) {
          try {
            report({
              event: 'wake_process_unref_failed',
              intentId: item.intent.id,
              cause: String(error),
            });
          } catch {
            // Completion remains authoritative even when diagnostics are unavailable.
          }
        }
      };

      const finish = (
        state: Exclude<CoordinatorWakeRunResult['state'], 'idle'>,
        reasonCode: string,
        releaseChild = false,
      ): void => {
        if (settled) return;
        settled = true;
        disarm(timer);
        if (stopActiveDispatch === stopForShutdown) stopActiveDispatch = undefined;
        if (releaseChild) releaseUncertainChild();
        void complete(item, attemptId, state, reasonCode, batch).then(resolve);
      };
      const stopForShutdown = (): void => finish('indeterminate', 'dispatcher_stopped', true);
      stopActiveDispatch = stopForShutdown;
      const timer = arm(() => finish('indeterminate', 'queue_timeout', true), queueTimeoutMs);

      child.once('spawn', () => {
        spawned = true;
      });
      child.once('error', (error) => {
        report({ event: 'wake_process_error', intentId: item.intent.id, cause: String(error) });
        finish(
          spawned ? 'indeterminate' : 'fallback_only',
          spawned ? 'queue_outcome_unknown' : 'queue_spawn_failed',
          spawned,
        );
      });
      child.once('exit', (code, signal) => {
        if (!spawned) {
          finish('indeterminate', 'queue_outcome_unknown');
        } else if (signal !== null) {
          finish('indeterminate', 'queue_signaled');
        } else if (code === 0) {
          finish('dispatched', 'queue_accepted');
        } else {
          finish('indeterminate', 'queue_exit_nonzero');
        }
      });
    });
  };

  const processBatch = async (
    batch: WakeIntentClaimResponse,
    mayStartProcess: () => boolean = () => true,
  ): Promise<CoordinatorWakeRunResult> => {
    const item = batch.items[0];
    if (item !== undefined) return dispatch(item, batch, mayStartProcess);
    const recovered = batch.recoveredDispatching[0];
    if (recovered !== undefined) {
      return result('indeterminate', batch, {
        intentId: recovered.id,
        reasonCode: recovered.reasonCode,
      });
    }
    return result('idle', batch);
  };

  const runOnce = async (): Promise<CoordinatorWakeRunResult> =>
    processBatch(
      await options.client.claim({
        dispatcherInstanceId: options.dispatcherInstanceId,
        limit: 1,
        blockMs: WAKE_DEFAULT_BLOCK_MS,
        minIdleMs: WAKE_DEFAULT_MIN_IDLE_MS,
      }),
    );

  const recover = async (): Promise<CoordinatorWakeRunResult> =>
    processBatch(
      await options.client.recover({
        dispatcherInstanceId: options.dispatcherInstanceId,
        limit: 1,
        minIdleMs: WAKE_DEFAULT_MIN_IDLE_MS,
      }),
    );

  return {
    runOnce,
    recover,
    async start() {
      if (running) return;
      running = true;
      loop = (async () => {
        while (running) {
          let recovered: WakeIntentRecoverResponse;
          try {
            recovered = await options.client.recover({
              dispatcherInstanceId: options.dispatcherInstanceId,
              limit: 1,
              minIdleMs: WAKE_DEFAULT_MIN_IDLE_MS,
            });
            await processBatch(recovered, () => running);
          } catch (error) {
            report({ event: 'wake_recovery_failed', cause: String(error) });
            if (running) await wait(DEFAULT_FAILURE_BACKOFF_MS);
            continue;
          }
          if (!running) break;
          if (batchHasRecoveryWork(recovered)) continue;

          try {
            await processBatch(
              await options.client.claim({
                dispatcherInstanceId: options.dispatcherInstanceId,
                limit: 1,
                blockMs: WAKE_DEFAULT_BLOCK_MS,
                minIdleMs: WAKE_DEFAULT_MIN_IDLE_MS,
              }),
              () => running,
            );
          } catch (error) {
            report({ event: 'wake_claim_failed', cause: String(error) });
            if (running) await wait(DEFAULT_FAILURE_BACKOFF_MS);
          }
        }
      })();
    },
    async stop() {
      if (!running && loop === undefined) return;
      running = false;
      stopActiveDispatch?.();
      const pending = loop;
      loop = undefined;
      await pending;
    },
  };
}
