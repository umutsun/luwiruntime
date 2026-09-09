import type {
  BridgeExecutionProfile,
  BridgeOwnerDeclaration,
  BridgeProvider,
  BridgeSlotAcquireBody,
  BridgeSlotTransitionResponse,
} from '@luwi/protocol';

import type { NativeAgentName } from './agent-runner.js';

/**
 * Holds one bridge slot for the process it runs in.
 *
 * The daemon owns the compare-and-set; this owns the cadence and the honest
 * answer to "do I still own it?". Three rules shape it:
 *
 * - **Acquire before register.** The declaration this exposes is what the
 *   session bootstrap sends, so a session can never exist for a slot the
 *   process does not hold.
 * - **A refusal is definitive; a failure is provisional.** `not_owner` means
 *   another owner took the tuple and the worker stops now. A transport error
 *   is tolerated only until the last proven `expiresAt` passes — after that
 *   ownership is unprovable, which is the same thing as lost.
 * - **Lost is reported once.** The worker that hears it stops claiming, and
 *   the timer that would have renewed a dead token is already disarmed.
 */

/** The slot's provider name for a native CLI the bridge can run. */
export function bridgeProviderFor(name: NativeAgentName): BridgeProvider {
  switch (name) {
    case 'claude':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini-cli';
    case 'antigravity':
      return 'antigravity';
  }
}

/** The native CLI a slot's provider is served by; the inverse of `bridgeProviderFor`. */
export function nativeAgentNameFor(provider: BridgeProvider): NativeAgentName {
  switch (provider) {
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'gemini-cli':
      return 'gemini';
    case 'antigravity':
      return 'antigravity';
  }
}

export type BridgeSlotClient = {
  acquire(body: BridgeSlotAcquireBody): Promise<BridgeSlotTransitionResponse>;
  renew(slotId: string, ownerToken: string): Promise<BridgeSlotTransitionResponse>;
  release(slotId: string, ownerToken: string): Promise<BridgeSlotTransitionResponse>;
};

export type BridgeSlotLossReason = 'refused' | 'unprovable';

export type BridgeSlotOwnerOptions = {
  client: BridgeSlotClient;
  slot: {
    projectId: string;
    agentId: string;
    provider: BridgeProvider;
    executionProfile: BridgeExecutionProfile;
  };
  ownerToken: string;
  /** A third of the 15 s slot TTL, so two renewals can fail before it lapses. */
  renewIntervalMs?: number;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  onLost: (reason: BridgeSlotLossReason) => void;
  onError?: (error: unknown) => void;
};

export interface BridgeSlotOwner {
  acquire(): Promise<'acquired' | 'held'>;
  release(): Promise<void>;
  /** Present exactly while the slot is owned; what registration declares. */
  readonly declaration: BridgeOwnerDeclaration | undefined;
}

export const DEFAULT_SLOT_RENEW_INTERVAL_MS = 5_000;

const REFUSAL_CODES = new Set(['BRIDGE_SLOT_NOT_OWNER', 'BRIDGE_SLOT_NOT_FOUND']);

function isRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' && REFUSAL_CODES.has(code);
}

export function createBridgeSlotOwner(options: BridgeSlotOwnerOptions): BridgeSlotOwner {
  const arm = options.setInterval ?? setInterval;
  const disarm = options.clearInterval ?? clearInterval;
  const now = options.now ?? Date.now;
  const intervalMs = options.renewIntervalMs ?? DEFAULT_SLOT_RENEW_INTERVAL_MS;

  let declaration: BridgeOwnerDeclaration | undefined;
  let expiresAtMs = 0;
  let timer: NodeJS.Timeout | undefined;
  let renewing = false;

  const stopOwning = (): void => {
    declaration = undefined;
    if (timer !== undefined) {
      disarm(timer);
      timer = undefined;
    }
  };

  const lose = (reason: BridgeSlotLossReason): void => {
    if (declaration === undefined) return;
    stopOwning();
    options.onLost(reason);
  };

  const renew = async (): Promise<void> => {
    const current = declaration;
    if (current === undefined || renewing) return;
    renewing = true;
    try {
      const result = await options.client.renew(current.slotId, current.ownerToken);
      expiresAtMs = Date.parse(result.slot.expiresAt);
    } catch (error) {
      if (isRefusal(error)) {
        lose('refused');
        return;
      }
      options.onError?.(error);
      if (now() >= expiresAtMs) lose('unprovable');
    } finally {
      renewing = false;
    }
  };

  return {
    get declaration() {
      return declaration;
    },

    async acquire() {
      if (declaration !== undefined) return 'acquired';
      const result = await options.client.acquire({
        projectId: options.slot.projectId,
        agentId: options.slot.agentId,
        provider: options.slot.provider,
        executionProfile: options.slot.executionProfile,
        ownerToken: options.ownerToken,
      });
      if (result.status !== 'acquired') return 'held';
      declaration = {
        slotId: result.slot.id,
        ownerToken: options.ownerToken,
        provider: options.slot.provider,
        executionProfile: options.slot.executionProfile,
      };
      expiresAtMs = Date.parse(result.slot.expiresAt);
      // Not unreffed: like the session heartbeat, this is part of what keeps a
      // bridge process alive, and a lapsed slot is a lost worker.
      timer = arm(() => {
        void renew();
      }, intervalMs);
      return 'acquired';
    },

    async release() {
      const current = declaration;
      if (current === undefined) return;
      stopOwning();
      try {
        await options.client.release(current.slotId, current.ownerToken);
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}
