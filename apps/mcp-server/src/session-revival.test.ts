import type { SessionView } from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import { McpDaemonError } from './daemon-client.js';
import { createSessionRevival } from './session-revival.js';

const timestamp = '2026-09-11T12:00:00.000Z';
const dropped: SessionView = {
  id: 'attached',
  agentId: 'claude-code',
  projectId: 'project-1',
  status: 'disconnected',
  workingDirectory: 'C:/work/app',
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  metadata: { model: 'model-x' },
  presence: 'offline',
};
const live: SessionView = { ...dropped, id: 'attached', status: 'idle', presence: 'online' };
/** The attach wrote the native reference into the binding; the view never carries it. */
const native = { adapterId: 'claude-code', nativeSessionId: 'native-1' };

function harness(fileIds: string[]) {
  const timers: Array<{ callback: () => void; intervalMs: number }> = [];
  const sessions = new Map<string, SessionView>();
  let registrations = 0;
  let lostHeartbeats = 0;
  const client = {
    verifyBoundSession: vi.fn(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new McpDaemonError('SESSION_NOT_FOUND', 'missing', 404);
      if (session.status === 'completed' || session.status === 'disconnected') {
        throw new McpDaemonError('BOUND_SESSION_TERMINAL', 'terminal', 409);
      }
      return session;
    }),
    getSession: vi.fn(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session === undefined) throw new McpDaemonError('SESSION_NOT_FOUND', 'missing', 404);
      return session;
    }),
    registerSession: vi.fn(async (request: { projectId: string; agentId: string }) => {
      registrations += 1;
      const registered: SessionView = {
        ...live,
        id: `revived-${String(registrations)}`,
        status: 'starting',
        projectId: request.projectId,
        agentId: request.agentId,
      };
      sessions.set(registered.id, registered);
      return registered;
    }),
    heartbeat: vi.fn(async () => {
      if (lostHeartbeats > 0) {
        lostHeartbeats -= 1;
        throw new McpDaemonError('SESSION_TERMINAL', 'reaped', 409);
      }
    }),
    closeSession: vi.fn(async (sessionId: string) => sessions.get(sessionId) ?? live),
  };
  const resolveBinding = vi.fn(async () => ({ attached: fileIds[0] ?? 'attached', native }));
  const revival = createSessionRevival({
    client,
    resolveBinding,
    heartbeatIntervalMs: 5_000,
    setInterval: ((callback: () => void, intervalMs: number) => {
      timers.push({ callback, intervalMs });
      return timers.length as unknown as NodeJS.Timeout;
    }) as never,
    clearInterval: (() => undefined) as never,
  });
  return {
    client,
    revival,
    sessions,
    timers,
    setFileId: (id: string) => {
      fileIds[0] = id;
    },
    loseNextHeartbeats: (count: number) => {
      lostHeartbeats = count;
    },
    async tick() {
      for (const timer of timers) timer.callback();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('session revival', () => {
  it('passes a live binding through and registers nothing', async () => {
    const { client, revival, sessions } = harness(['attached']);
    sessions.set('attached', live);

    await expect(revival.resolveBoundSession()).resolves.toEqual(live);
    await expect(revival.revive()).resolves.toEqual(live);
    expect(client.registerSession).not.toHaveBeenCalled();
  });

  it('registers a successor copied from the dropped record and keeps it alive', async () => {
    const { client, revival, sessions, timers, tick } = harness(['attached']);
    sessions.set('attached', dropped);

    await expect(revival.resolveBoundSession()).rejects.toMatchObject({
      code: 'BOUND_SESSION_TERMINAL',
    });
    const revived = await revival.revive();

    expect(revived.id).toBe('revived-1');
    expect(client.registerSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      agentId: 'claude-code',
      workingDirectory: 'C:/work/app',
      native: { adapterId: 'claude-code', nativeSessionId: 'native-1' },
      metadata: { model: 'model-x', revivedFrom: 'attached' },
    });
    // The reader owns presence now: a heartbeat timer is armed and beats.
    expect(timers.some(({ intervalMs }) => intervalMs === 5_000)).toBe(true);
    await tick();
    expect(client.heartbeat).toHaveBeenCalledWith('revived-1');
    // Every later call binds to the successor while the file still names the dropped id.
    await expect(revival.resolveBoundSession()).resolves.toMatchObject({ id: 'revived-1' });
    // A second join does not register twice.
    await expect(revival.revive()).resolves.toMatchObject({ id: 'revived-1' });
    expect(client.registerSession).toHaveBeenCalledTimes(1);
  });

  it('a successor dropped again is reported terminal until the next join registers anew', async () => {
    const { client, revival, sessions, tick, loseNextHeartbeats } = harness(['attached']);
    sessions.set('attached', dropped);
    await revival.revive();

    // The runtime reaps the successor (still `starting`: nobody joined again).
    loseNextHeartbeats(1);
    await tick();
    await expect(revival.resolveBoundSession()).rejects.toMatchObject({
      code: 'BOUND_SESSION_TERMINAL',
    });
    expect(client.registerSession).toHaveBeenCalledTimes(1);

    const again = await revival.revive();
    expect(again.id).toBe('revived-2');
    expect(client.registerSession).toHaveBeenCalledTimes(2);
  });

  it('a new attach in the binding supersedes the successor, which is closed', async () => {
    const { client, revival, sessions, setFileId } = harness(['attached']);
    sessions.set('attached', dropped);
    await revival.revive();

    const fresh: SessionView = { ...live, id: 'attached-2' };
    sessions.set('attached-2', fresh);
    setFileId('attached-2');

    await expect(revival.resolveBoundSession()).resolves.toEqual(fresh);
    expect(client.closeSession).toHaveBeenCalledWith('revived-1');
  });

  it('reports the daemon when a successor could not be registered', async () => {
    const { client, revival, sessions } = harness(['attached']);
    sessions.set('attached', dropped);
    client.registerSession.mockRejectedValueOnce(new Error('daemon down'));

    await expect(revival.revive()).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
  });
});
