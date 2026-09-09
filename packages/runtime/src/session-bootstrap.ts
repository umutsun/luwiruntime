import {
  LEASE_DEFAULT_DURATION_MS,
  LEASE_MAX_DURATION_MS,
  LEASE_MIN_DURATION_MS,
  type BridgeOwnerDeclaration,
  type NativeSessionRef,
} from '@luwi/protocol';

/**
 * Registers a session for the process it runs in, then keeps it alive.
 *
 * This is the piece that makes a running agent visible at all. Three rules
 * shape it, and each exists because of a property of the runtime it talks to:
 *
 * - **The heartbeat is owned here, not by the caller.** Presence TTL is 15 s and
 *   `disconnected` has no transition out, so a forgotten beat kills a session id
 *   permanently. A confirmed dead id is replaced with a new registration.
 * - **A failure never reaches the caller.** An agent starts whether or not LUWI
 *   is running; a coordinator that can prevent the tools it coordinates from
 *   starting has inverted its own relationship to them.
 * - **Recovery is conservative.** Transient failures retain the current session
 *   and use bounded backoff. Only explicit missing/terminal responses rotate it.
 * - **A crash is allowed to lapse.** Presence expiry is the backstop and the
 *   session goes `disconnected`, which is the honest outcome. This does not try
 *   to outlive its own process.
 */

export type SessionBootstrapClient = {
  register(request: {
    projectId: string;
    agentId: string;
    workingDirectory: string;
    native?: NativeSessionRef;
    metadata?: Record<string, unknown>;
    bridgeOwner?: BridgeOwnerDeclaration;
  }): Promise<{ id: string }>;
  heartbeat(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
};

/** The fields of a held lease the renewal loop needs — no path or reason. */
export type WorkLeaseSummary = {
  id: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
};

/**
 * The optional lease surface that turns on automatic renewal (ADR 0026).
 *
 * When present, the bootstrap renews every lease the current session holds on a
 * second timer, keeping a live holder's claims alive without the agent renewing
 * by hand. Absent, the bootstrap is presence-only, exactly as before.
 */
export type SessionBootstrapLeaseClient = {
  listSessionLeases(sessionId: string): Promise<WorkLeaseSummary[]>;
  renewLease(leaseId: string, sessionId: string, durationMs: number): Promise<void>;
};

export type SessionBootstrapOptions = {
  client: SessionBootstrapClient;
  projectId: string;
  agentId: string;
  workingDirectory: string;
  /**
   * The vendor-native reference to declare, when one could be resolved.
   *
   * Absent is a real answer: a session registers without a native block rather
   * than with a fabricated one, because a wrong binding attributes its tokens
   * to another session.
   */
  native?: NativeSessionRef;
  /** Free-form session metadata to register with, e.g. `{ model }`. */
  metadata?: Record<string, unknown>;
  /**
   * The bridge slot this process already owns. It rides every registration,
   * including a recovery, so the same Function that registers a rotated
   * session also attaches it to the slot atomically.
   */
  bridgeOwner?: BridgeOwnerDeclaration;
  /** Must stay well inside the presence TTL. Defaults to a third of 15 s. */
  heartbeatIntervalMs?: number;
  /** Caps exponential retry delay. Must be at least the heartbeat interval. */
  maxRetryBackoffMs?: number;
  /**
   * When present, held leases are renewed automatically (ADR 0026). Absent, the
   * bootstrap keeps presence only and touches no lease.
   */
  leaseClient?: SessionBootstrapLeaseClient;
  /** How often held leases are renewed. Defaults to half the default lease TTL. */
  leaseRenewIntervalMs?: number;
  /** Runs after registration but before the session id becomes visible to callers. */
  prepareSession?: (change: {
    reason: 'registered' | 'recovered';
    sessionId: string;
    previousSessionId?: string;
  }) => Promise<void>;
  /** Classifies failures at the boundary where they occurred. */
  classifyError?: (
    phase: 'register' | 'prepare' | 'heartbeat',
    error: unknown,
  ) => 'transient' | 'lost_session' | 'fatal';
  /** Called once when retrying would violate an ownership or trust boundary. */
  onFatal?: (error: unknown) => void;
  onError?: (error: unknown) => void;
  onSessionChanged?: (change: SessionBootstrapChange) => void;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
};

export type SessionBootstrapChange =
  | { reason: 'registered'; sessionId: string }
  | { reason: 'recovered'; previousSessionId: string; sessionId: string }
  | { reason: 'stopped'; previousSessionId: string };

export interface SessionBootstrap {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly sessionId: string | undefined;
}

/** A third of the 15 s presence TTL, so two beats can fail before a lapse. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
/** Bounds degraded retry traffic while still probing often enough to recover. */
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 30_000;
/** Half the default lease TTL, so a lease is renewed well before its deadline. */
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = LEASE_DEFAULT_DURATION_MS / 2;

const LOST_SESSION_CODES = new Set(['SESSION_NOT_FOUND', 'SESSION_TERMINAL']);

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function isLostSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' && LOST_SESSION_CODES.has(code);
}

export function createSessionBootstrap(options: SessionBootstrapOptions): SessionBootstrap {
  const arm = options.setInterval ?? setInterval;
  const disarm = options.clearInterval ?? clearInterval;
  const intervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxRetryBackoffMs = options.maxRetryBackoffMs ?? DEFAULT_MAX_RETRY_BACKOFF_MS;
  const now = options.now ?? Date.now;
  const leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
  requirePositiveInteger(intervalMs, 'heartbeatIntervalMs');
  requirePositiveInteger(maxRetryBackoffMs, 'maxRetryBackoffMs');
  if (maxRetryBackoffMs < intervalMs) {
    throw new TypeError('maxRetryBackoffMs must be at least heartbeatIntervalMs.');
  }
  if (options.leaseClient !== undefined) {
    requirePositiveInteger(leaseRenewIntervalMs, 'leaseRenewIntervalMs');
  }

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics must never prevent session cleanup or retry accounting.
    }
  };
  const reportSessionChange = (change: SessionBootstrapChange): void => {
    try {
      options.onSessionChanged?.(change);
    } catch (error) {
      report(error);
    }
  };

  const registrationRequest = {
    projectId: options.projectId,
    agentId: options.agentId,
    workingDirectory: options.workingDirectory,
    ...(options.native === undefined ? {} : { native: options.native }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.bridgeOwner === undefined ? {} : { bridgeOwner: options.bridgeOwner }),
  };

  let sessionId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let active = false;
  let lifecycle = 0;
  let operation: Promise<void> | undefined;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  let recoverySessionId: string | undefined;
  let renewalTimer: NodeJS.Timeout | undefined;
  let renewalOperation: Promise<void> | undefined;

  const resetBackoff = (): void => {
    consecutiveFailures = 0;
    nextAttemptAt = 0;
  };

  const classifyError = (
    phase: 'register' | 'prepare' | 'heartbeat',
    error: unknown,
  ): 'transient' | 'lost_session' | 'fatal' =>
    options.classifyError?.(phase, error) ??
    (phase === 'heartbeat' && isLostSessionError(error) ? 'lost_session' : 'transient');

  const haltFatal = async (error: unknown): Promise<void> => {
    const current = sessionId;
    active = false;
    lifecycle += 1;
    sessionId = undefined;
    recoverySessionId = undefined;
    resetBackoff();
    if (timer !== undefined) {
      disarm(timer);
      timer = undefined;
    }
    if (renewalTimer !== undefined) {
      disarm(renewalTimer);
      renewalTimer = undefined;
    }
    if (current !== undefined) await closeQuietly(current);
    report(error);
    try {
      options.onFatal?.(error);
    } catch (observerError) {
      report(observerError);
    }
  };

  const recordTransientFailure = (error: unknown): void => {
    report(error);
    consecutiveFailures += 1;
    const exponent = Math.min(consecutiveFailures - 1, 30);
    const delayMs = Math.min(maxRetryBackoffMs, intervalMs * 2 ** exponent);
    nextAttemptAt = now() + delayMs;
  };

  const closeQuietly = async (id: string): Promise<void> => {
    try {
      await options.client.close(id);
    } catch (error) {
      report(error);
    }
  };

  const attempt = async (generation: number): Promise<void> => {
    if (!active || generation !== lifecycle || operation !== undefined || now() < nextAttemptAt) {
      return;
    }

    const current = sessionId;
    const pending = (async (): Promise<void> => {
      if (current === undefined) {
        try {
          const registered = await options.client.register(registrationRequest);
          if (!active || generation !== lifecycle) {
            await closeQuietly(registered.id);
            return;
          }
          const previousSessionId = recoverySessionId;
          const preparedChange =
            previousSessionId === undefined
              ? ({ reason: 'registered', sessionId: registered.id } as const)
              : ({
                  reason: 'recovered',
                  previousSessionId,
                  sessionId: registered.id,
                } as const);
          try {
            await options.prepareSession?.(preparedChange);
          } catch (error) {
            await closeQuietly(registered.id);
            if (!active || generation !== lifecycle) return;
            if (classifyError('prepare', error) === 'fatal') await haltFatal(error);
            else recordTransientFailure(error);
            return;
          }
          if (!active || generation !== lifecycle) {
            await closeQuietly(registered.id);
            return;
          }
          sessionId = registered.id;
          if (previousSessionId === undefined) {
            reportSessionChange(preparedChange);
          } else {
            reportSessionChange(preparedChange);
            recoverySessionId = undefined;
          }
          resetBackoff();
        } catch (error) {
          if (active && generation === lifecycle) {
            if (classifyError('register', error) === 'fatal') await haltFatal(error);
            else recordTransientFailure(error);
          }
        }
        return;
      }

      try {
        await options.client.heartbeat(current);
        if (active && generation === lifecycle && sessionId === current) resetBackoff();
      } catch (error) {
        if (!active || generation !== lifecycle || sessionId !== current) return;
        const classification = classifyError('heartbeat', error);
        if (classification === 'fatal') {
          await haltFatal(error);
          return;
        }
        if (classification === 'lost_session') {
          report(error);
          recoverySessionId = current;
          sessionId = undefined;
          resetBackoff();
          return;
        }
        recordTransientFailure(error);
      }
    })();

    operation = pending;
    try {
      await pending;
    } finally {
      if (operation === pending) operation = undefined;
    }
  };

  /** The lease's own duration, so a renewal preserves rather than extends it. */
  const deriveLeaseDurationMs = (lease: WorkLeaseSummary): number => {
    const base = Date.parse(lease.renewedAt ?? lease.acquiredAt);
    const duration = Date.parse(lease.expiresAt) - base;
    if (!Number.isFinite(duration) || duration <= 0) return LEASE_DEFAULT_DURATION_MS;
    return Math.min(LEASE_MAX_DURATION_MS, Math.max(LEASE_MIN_DURATION_MS, duration));
  };

  const renewLeases = async (generation: number): Promise<void> => {
    const leaseClient = options.leaseClient;
    if (
      leaseClient === undefined ||
      !active ||
      generation !== lifecycle ||
      renewalOperation !== undefined
    ) {
      return;
    }
    const current = sessionId;
    if (current === undefined) return;

    const pending = (async (): Promise<void> => {
      let leases: WorkLeaseSummary[];
      try {
        leases = await leaseClient.listSessionLeases(current);
      } catch (error) {
        // Surfaced once; the next tick re-reads the held-only index, so a lease
        // that vanished is simply absent rather than retried forever.
        report(error);
        return;
      }
      for (const lease of leases) {
        // Re-read the bound session each iteration: a rotation must not renew a
        // dead session's lease, which would be refused against the wrong holder.
        if (!active || generation !== lifecycle || sessionId !== current) return;
        try {
          await leaseClient.renewLease(lease.id, current, deriveLeaseDurationMs(lease));
        } catch (error) {
          report(error);
        }
      }
    })();

    renewalOperation = pending;
    try {
      await pending;
    } finally {
      if (renewalOperation === pending) renewalOperation = undefined;
    }
  };

  return {
    get sessionId() {
      return sessionId;
    },

    async start() {
      if (active) return;
      active = true;
      lifecycle += 1;
      const generation = lifecycle;
      resetBackoff();
      await attempt(generation);
      if (!active || generation !== lifecycle || timer !== undefined) return;

      /**
       * Deliberately **not** unreffed.
       *
       * A daemon has other work holding its event loop open, so unreffing its
       * timers is right. Here the heartbeat is the only thing keeping an
       * attached process alive: unreffed, `session attach` registered and then
       * exited immediately, and the session it had just created lapsed to
       * `disconnected` fifteen seconds later. Observed on the first live run.
       */
      timer = arm(() => {
        void attempt(lifecycle);
      }, intervalMs);

      // A second timer, armed alongside the heartbeat and disarmed with it, keeps
      // the session's held leases alive on their own cadence (ADR 0026). It
      // inherits the heartbeat's not-unreffed lifetime through the same seam.
      if (options.leaseClient !== undefined) {
        renewalTimer = arm(() => {
          void renewLeases(lifecycle);
        }, leaseRenewIntervalMs);
      }
    },

    async stop() {
      if (!active && sessionId === undefined && timer === undefined) return;
      active = false;
      lifecycle += 1;
      const current = sessionId;
      // Cleared before the close so a beat cannot race the close it follows.
      sessionId = undefined;
      recoverySessionId = undefined;
      resetBackoff();
      if (timer !== undefined) {
        disarm(timer);
        timer = undefined;
      }
      if (renewalTimer !== undefined) {
        disarm(renewalTimer);
        renewalTimer = undefined;
      }
      if (current === undefined) return;
      await closeQuietly(current);
      reportSessionChange({ reason: 'stopped', previousSessionId: current });
    },
  };
}
