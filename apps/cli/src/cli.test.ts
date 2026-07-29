import { ApplicationError } from '@luwi/runtime';
import { describe, expect, it, vi } from 'vitest';

import { runCli, type CliDependencies, type CliWebSocket, type HttpResponseLike } from './cli.js';

const runtimeResponse = {
  version: '0.1.0',
  protocolVersion: 1,
  runtimeState: 'ready',
  runtimeInstanceId: 'runtime-1',
  workspaceId: 'workspace-1',
  startedAt: '2026-07-28T08:00:00.000Z',
  uptimeMs: 2500,
  host: '127.0.0.1',
  port: 4782,
  redis: {
    connected: true,
    status: 'connected',
    latencyMs: 2,
  },
  endpoints: {
    health: '/health',
    runtime: '/api/v1/runtime',
  },
};

function response(
  body: unknown,
  options: {
    ok?: boolean;
    status?: number;
  } = {},
): HttpResponseLike {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
  };
}

class FakeWebSocket implements CliWebSocket {
  readyState = 1;
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, value: unknown = {}): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value);
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('LUWI CLI', () => {
  it('prints validated runtime status from the daemon', async () => {
    let requestedUrl = '';
    let output = '';
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url) => {
        requestedUrl = url;
        return response(runtimeResponse);
      },
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(['runtime', '--url', 'http://127.0.0.1:4782/'], dependencies);

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/runtime');
    expect(JSON.parse(output)).toEqual(runtimeResponse);
  });

  it('rejects an invalid daemon response instead of printing untrusted data', async () => {
    const dependencies: Partial<CliDependencies> = {
      fetch: async () => response({ version: 'unexpected' }),
      stdout: {
        write: () => undefined,
      },
    };

    await expect(runCli(['runtime'], dependencies)).rejects.toThrow();
  });

  it('raises a typed error for non-success daemon responses', async () => {
    const dependencies: Partial<CliDependencies> = {
      fetch: async () => response({}, { ok: false, status: 503 }),
      stdout: {
        write: () => undefined,
      },
    };

    await expect(runCli(['runtime'], dependencies)).rejects.toEqual(
      new ApplicationError('DAEMON_REQUEST_FAILED', 'Daemon request failed with status 503', 503),
    );
  });

  it('registers projects with a JSON POST and validates the response', async () => {
    let requestedUrl = '';
    let requestedInit: unknown;
    let output = '';
    await runCli(['project', 'register', '--name', 'LUWI', '--path', 'C:/workspace/luwi'], {
      fetch: async (url, init) => {
        requestedUrl = url;
        requestedInit = init;
        return response({
          id: 'project-1',
          name: 'LUWI',
          localPath: 'C:/workspace/luwi',
          canonicalPath: 'C:/workspace/luwi',
          createdAt: '2026-07-28T12:00:00.000Z',
          updatedAt: '2026-07-28T12:00:00.000Z',
        });
      },
      stdout: { write: (text) => (output += text) },
    });

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/projects');
    expect(requestedInit).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ name: 'LUWI', localPath: 'C:/workspace/luwi' }),
    });
    expect(JSON.parse(output)).toMatchObject({ id: 'project-1' });
  });

  it('filters validated session views to online in the CLI', async () => {
    let output = '';
    const session = {
      id: 'session-1',
      agentId: 'codex-sim',
      projectId: 'project-1',
      status: 'starting',
      workingDirectory: 'C:/workspace/luwi',
      startedAt: '2026-07-28T12:00:00.000Z',
      lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
      metadata: {},
    };
    await runCli(['session', 'list', '--online'], {
      fetch: async () =>
        response({
          sessions: [
            { ...session, presence: 'online' },
            { ...session, id: 'session-2', status: 'disconnected', presence: 'offline' },
          ],
        }),
      stdout: { write: (text) => (output += text) },
    });

    expect(JSON.parse(output).sessions).toEqual([
      expect.objectContaining({ id: 'session-1', presence: 'online' }),
    ]);
  });

  it('simulation heartbeats and sends exactly one graceful close across repeated signals', async () => {
    const listeners = new Map<string, () => void>();
    const unref = vi.fn();
    const requests: Array<{ url: string; body: unknown }> = [];
    let intervalCallback: (() => void) | undefined;
    const session = {
      id: 'session-1',
      agentId: 'codex-sim',
      projectId: 'project-1',
      status: 'starting',
      workingDirectory: 'C:/workspace/luwi',
      startedAt: '2026-07-28T12:00:00.000Z',
      lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
      metadata: {},
      presence: 'online',
    };
    const simulation = runCli(
      [
        'session',
        'simulate',
        '--project',
        'project-1',
        '--agent',
        'codex-sim',
        '--working-directory',
        'C:/workspace/luwi',
      ],
      {
        fetch: async (url, init) => {
          requests.push({
            url,
            body: init?.body === undefined ? undefined : JSON.parse(init.body),
          });
          if (url.endsWith('/heartbeat')) {
            return response({ status: 'renewed', eventEmitted: false });
          }
          if (url.endsWith('/close')) {
            return response({ ...session, status: 'completed', presence: 'offline' });
          }
          return response(session, { status: 201 });
        },
        stdout: { write: () => undefined },
        signals: {
          once: (signal, listener) => listeners.set(signal, listener),
          off: (signal) => listeners.delete(signal),
        },
        setInterval: (callback) => {
          intervalCallback = callback;
          return { unref } as unknown as NodeJS.Timeout;
        },
        clearInterval: () => undefined,
      },
    );
    await vi.waitFor(() => expect(listeners.has('SIGINT')).toBe(true));
    expect(unref).not.toHaveBeenCalled();
    intervalCallback?.();
    await vi.waitFor(() =>
      expect(requests.some(({ url }) => url.endsWith('/heartbeat'))).toBe(true),
    );
    listeners.get('SIGINT')?.();
    listeners.get('SIGTERM')?.();
    await simulation;

    expect(requests.filter(({ url }) => url.endsWith('/close'))).toHaveLength(1);
  });

  it('buffers realtime events until snapshots, sorts them, and deduplicates live delivery', async () => {
    const socket = new FakeWebSocket();
    const listeners = new Map<string, () => void>();
    let output = '';
    const event = {
      id: 'event-1',
      version: 1,
      type: 'project.registered',
      occurredAt: '2026-07-28T12:00:00.000Z',
      workspaceId: 'local',
      projectId: 'project-1',
      payload: {},
    };
    const watching = runCli(['events', 'watch'], {
      createWebSocket: () => socket,
      fetch: async (url) =>
        url.endsWith('/projects') ? response({ projects: [] }) : response({ sessions: [] }),
      stdout: { write: (text) => (output += text) },
      stderr: { write: () => undefined },
      signals: {
        once: (signal, listener) => listeners.set(signal, listener),
        off: (signal) => listeners.delete(signal),
      },
    });
    await vi.waitFor(() => expect(socket.listeners.has('open')).toBe(true));
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({ streamId: '2-0', event }),
    });
    await vi.waitFor(() => expect(output).toContain('"section":"live"'));
    socket.emit('message', {
      data: JSON.stringify({ streamId: '2-0', event }),
    });
    listeners.get('SIGINT')?.();
    await watching;

    const lines = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ section: 'snapshot', projects: [], sessions: [] });
    expect(lines.filter(({ section }) => section === 'live')).toHaveLength(1);
  });
});
