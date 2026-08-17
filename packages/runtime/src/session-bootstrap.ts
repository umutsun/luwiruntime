import type { NativeSessionRef } from '@luwi/protocol';

/**
 * Registers a session for the process it runs in, then keeps it alive.
 *
 * This is the piece that makes a running agent visible at all. Three rules
 * shape it, and each exists because of a property of the runtime it talks to:
 *
 * - **The heartbeat is owned here, not by the caller.** Presence TTL is 15 s and
 *   `disconnected` has no transition out, so a forgotten beat kills a session id
 *   permanently.
 * - **A failure never reaches the caller.** An agent starts whether or not LUWI
 *   is running; a coordinator that can prevent the tools it coordinates from
 *   starting has inverted its own relationship to them.
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
  }): Promise<{ id: string }>;
  heartbeat(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
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
  /** Must stay well inside the presence TTL. Defaults to a third of 15 s. */
  heartbeatIntervalMs?: number;
  onError?: (error: unknown) => void;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
};

export interface SessionBootstrap {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly sessionId: string | undefined;
}

/** A third of the 15 s presence TTL, so two beats can fail before a lapse. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export function createSessionBootstrap(options: SessionBootstrapOptions): SessionBootstrap {
  const arm = options.setInterval ?? setInterval;
  const disarm = options.clearInterval ?? clearInterval;
  const intervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  let sessionId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let starting = false;

  return {
    get sessionId() {
      return sessionId;
    },

    async start() {
      if (sessionId !== undefined || starting) return;
      starting = true;
      try {
        const registered = await options.client.register({
          projectId: options.projectId,
          agentId: options.agentId,
          workingDirectory: options.workingDirectory,
          ...(options.native === undefined ? {} : { native: options.native }),
        });
        sessionId = registered.id;
      } catch (error) {
        // Logged once and then inert: the agent carries on without LUWI.
        report(error);
        return;
      } finally {
        starting = false;
      }

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
        const current = sessionId;
        if (current === undefined) return;
        // A refused beat is retried on the next tick rather than ending the
        // session: one blip must not become a permanent `disconnected`.
        void options.client.heartbeat(current).catch(report);
      }, intervalMs);
    },

    async stop() {
      const current = sessionId;
      // Cleared before the close so a beat cannot race the close it follows.
      sessionId = undefined;
      if (timer !== undefined) {
        disarm(timer);
        timer = undefined;
      }
      if (current === undefined) return;
      try {
        await options.client.close(current);
      } catch (error) {
        report(error);
      }
    },
  };
}
