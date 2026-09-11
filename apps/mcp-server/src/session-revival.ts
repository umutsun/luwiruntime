import type { SessionView } from '@luwi/protocol';
import { createSessionBootstrap, type SessionBootstrap } from '@luwi/runtime';

import { McpDaemonError, type McpDaemonClient } from './daemon-client.js';
import type { SessionBindingRecord } from './session-binding.js';

/**
 * Reader-owned revival of a dropped attach session (ADR 0034).
 *
 * An attached GUI session registers as `starting` and only leaves it when this
 * server's `luwi_join` binds it. The runtime drops a session still `starting`
 * past its grace, and the attach process — whose reader is this server, not
 * itself — re-registers nothing. So the session file keeps naming a terminal
 * id, and the reader is the only party left that can act: on the next join it
 * registers a successor copied from the dropped record (same project, agent,
 * working directory and metadata) plus the native reference the attach wrote
 * into the binding — a session's view does not carry it — and keeps it alive
 * with its own heartbeat. A successor reaped before the next join is dropped the
 * same way; the join after that registers again. A new attach — a different,
 * live id in the file — supersedes the successor, which is then closed.
 */
export type SessionRevivalClient = Pick<
  McpDaemonClient,
  'verifyBoundSession' | 'getSession' | 'registerSession' | 'heartbeat' | 'closeSession'
>;

export type SessionRevivalOptions = {
  client: SessionRevivalClient;
  /** What the binding names right now — the attach's file, re-read per call. */
  resolveBinding: () => Promise<SessionBindingRecord>;
  heartbeatIntervalMs?: number;
  onError?: (error: unknown) => void;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
};

export interface SessionRevival {
  /** The bound session for any tool call: the binding's session, or its live successor. */
  resolveBoundSession(): Promise<SessionView>;
  /** `luwi_join` on a dropped session: register the successor this reader keeps alive. */
  revive(): Promise<SessionView>;
  /** Close the successor, if one is alive. */
  stop(): Promise<void>;
}

const TERMINAL_STATUSES = new Set(['completed', 'disconnected']);

export function createSessionRevival(options: SessionRevivalOptions): SessionRevival {
  let successor: { predecessorId: string; bootstrap: SessionBootstrap } | undefined;

  const retire = async (): Promise<void> => {
    const current = successor;
    successor = undefined;
    if (current !== undefined) await current.bootstrap.stop();
  };

  const revive = async (): Promise<SessionView> => {
    const binding = await options.resolveBinding();
    const id = binding.attached;
    if (successor?.predecessorId === id && successor.bootstrap.sessionId !== undefined) {
      return options.client.verifyBoundSession(successor.bootstrap.sessionId);
    }
    const dropped = await options.client.getSession(id);
    if (!TERMINAL_STATUSES.has(dropped.status)) {
      // Nothing to revive: the binding's own session is alive.
      return options.client.verifyBoundSession(id);
    }
    await retire();
    const bootstrap = createSessionBootstrap({
      client: {
        register: async (request) => ({ id: (await options.client.registerSession(request)).id }),
        heartbeat: (sessionId) => options.client.heartbeat(sessionId),
        inspect: async (sessionId) => ({
          status: (await options.client.getSession(sessionId)).status,
        }),
        close: async (sessionId) => {
          await options.client.closeSession(sessionId);
        },
      },
      projectId: dropped.projectId,
      agentId: dropped.agentId,
      workingDirectory: dropped.workingDirectory,
      ...(binding.native === undefined ? {} : { native: binding.native }),
      metadata: { ...dropped.metadata, revivedFrom: id },
      // This reader binds only on join. A successor the runtime reaps before the
      // next join must not come back on its own — the join after that revives.
      recoverUnready: false,
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
      ...(options.clearInterval === undefined ? {} : { clearInterval: options.clearInterval }),
    });
    await bootstrap.start();
    const sessionId = bootstrap.sessionId;
    if (sessionId === undefined) {
      await bootstrap.stop();
      throw new McpDaemonError(
        'DAEMON_UNAVAILABLE',
        'The LUWI daemon did not register a successor session.',
        503,
      );
    }
    successor = { predecessorId: id, bootstrap };
    return options.client.verifyBoundSession(sessionId);
  };

  return {
    async resolveBoundSession() {
      const { attached: id } = await options.resolveBinding();
      if (successor?.predecessorId === id) {
        const currentId = successor.bootstrap.sessionId;
        if (currentId === undefined) {
          throw new McpDaemonError(
            'BOUND_SESSION_TERMINAL',
            'The revived LUWI session was dropped again; call luwi_join to re-attach.',
            409,
          );
        }
        return options.client.verifyBoundSession(currentId);
      }
      // A different id in the binding means a new attach superseded the successor.
      if (successor !== undefined) await retire();
      return options.client.verifyBoundSession(id);
    },
    revive,
    stop: retire,
  };
}
