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

  it('sends AgentDefinition mutations only through the daemon HTTP API', async () => {
    let requestedUrl = '';
    let requestedInit: unknown;
    const agent = {
      id: 'codex-main',
      kind: 'codex',
      displayName: 'Codex',
      enabled: false,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['C:/fixture/.codex'],
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
      metadata: {},
    };

    await runCli(['agent', 'disable', agent.id], {
      fetch: async (url, init) => {
        requestedUrl = url;
        requestedInit = init;
        return response(agent);
      },
      stdout: { write: () => undefined },
    });

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/agents/codex-main');
    expect(requestedInit).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
  });

  it('builds bounded capability list filters', async () => {
    let requestedUrl = '';
    await runCli(
      [
        'capability',
        'list',
        '--kind',
        'skill',
        '--project',
        'project-1',
        '--agent',
        'codex-main',
        '--enabled',
        'true',
        '--limit',
        '25',
      ],
      {
        fetch: async (url) => {
          requestedUrl = url;
          return response({ capabilities: [], truncated: false });
        },
        stdout: { write: () => undefined },
      },
    );

    expect(requestedUrl).toContain('/api/v1/capabilities?');
    expect(requestedUrl).toContain('kind=skill');
    expect(requestedUrl).toContain('projectId=project-1');
    expect(requestedUrl).toContain('agentId=codex-main');
    expect(requestedUrl).toContain('limit=25');
  });

  it('refuses native config apply when interactive confirmation is declined', async () => {
    const fetch = vi.fn();
    await expect(
      runCli(['config', 'plan', 'apply', 'plan-1', '--approval-token', 'a'.repeat(43)], {
        fetch,
        confirm: async () => false,
        stdout: { write: () => undefined },
      }),
    ).rejects.toMatchObject({ code: 'CLI_CONFIRMATION_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies exactly one approved plan with --yes and preserves daemon safeguards', async () => {
    let requestedInit: unknown;
    const token = 'a'.repeat(43);
    await runCli(['config', 'plan', 'apply', 'plan-1', '--approval-token', token, '--yes'], {
      fetch: async (_url, init) => {
        requestedInit = init;
        return response({
          id: 'operation-1',
          planId: 'plan-1',
          agentId: 'codex-main',
          state: 'completed',
          targetPaths: ['C:/fixture/.codex/config.toml'],
          expectedHashes: { 'C:/fixture/.codex/config.toml': null },
          committedHashes: {
            'C:/fixture/.codex/config.toml':
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          startedAt: '2026-07-29T12:00:00.000Z',
          updatedAt: '2026-07-29T12:00:00.000Z',
        });
      },
      confirm: async () => {
        throw new Error('interactive confirmation must not run with --yes');
      },
      stdout: { write: () => undefined },
    });

    expect(requestedInit).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ approvalToken: token }),
    });
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

  it('creates a message with an idempotency header and can await its projection', async () => {
    const requests: Array<{
      url: string;
      init?: { headers?: Record<string, string>; body?: string };
    }> = [];
    let output = '';
    const message = {
      id: 'message-1',
      correlationId: 'correlation-1',
      projectId: 'project-1',
      sourceSessionId: 'source',
      sourceAgentId: 'claude-sim',
      targetSessionId: 'target',
      targetAgentId: 'gemini-sim',
      selectionReason: 'selected target',
      kind: 'question',
      content: 'Status?',
      evidenceRequirements: [],
      state: 'queued',
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
      deadlineAt: '2026-07-29T12:02:00.000Z',
    };
    await runCli(
      [
        'message',
        'ask',
        '--source',
        'source',
        '--target-agent',
        'gemini-sim',
        '--kind',
        'question',
        '--content',
        'Status?',
        '--idempotency-key',
        'retry-1',
        '--wait-ms',
        '25',
      ],
      {
        fetch: async (url, init) => {
          requests.push({ url, init });
          return url.includes('/wait?')
            ? response({ ...message, state: 'responded' })
            : response({
                message,
                selectedTargetSessionId: 'target',
                selectedTargetAgentId: 'gemini-sim',
                selectionReason: 'selected target',
                idempotent: false,
              });
        },
        stdout: { write: (text) => (output += text) },
      },
    );

    expect(requests[0]?.init?.headers).toMatchObject({
      'content-type': 'application/json',
      'idempotency-key': 'retry-1',
    });
    expect(requests[1]?.url).toContain('/api/v1/messages/correlation-1/wait?waitMs=25');
    expect(JSON.parse(output)).toMatchObject({ state: 'responded' });
  });

  it('claims inbox work and submits validated responder transitions', async () => {
    const requested: Array<{ url: string; body: unknown }> = [];
    let output = '';
    await runCli(
      ['inbox', 'claim', '--session', 'target', '--bridge-instance', 'bridge-1', '--block-ms', '0'],
      {
        fetch: async (url, init) => {
          requested.push({
            url,
            body: init?.body === undefined ? undefined : JSON.parse(init.body),
          });
          return response({ items: [] });
        },
        stdout: { write: (text) => (output += text) },
      },
    );
    expect(requested[0]).toMatchObject({
      url: 'http://127.0.0.1:4782/api/v1/sessions/target/inbox/claim',
      body: { bridgeInstanceId: 'bridge-1', blockMs: 0 },
    });
    expect(JSON.parse(output)).toEqual({ items: [] });
  });

  it('runs an echo bridge without closing the underlying session', async () => {
    const listeners = new Map<string, () => void>();
    const requested: Array<{ url: string; body: unknown }> = [];
    let claimCount = 0;
    let output = '';
    await runCli(
      [
        'session',
        'bridge',
        'simulate',
        '--session',
        'target',
        '--bridge-instance',
        'bridge-echo',
        '--mode',
        'echo',
        '--block-ms',
        '0',
      ],
      {
        fetch: async (url, init) => {
          requested.push({
            url,
            body: init?.body === undefined ? undefined : JSON.parse(init.body),
          });
          if (url.endsWith('/inbox/claim')) {
            claimCount += 1;
            if (claimCount === 1) {
              return response({
                items: [
                  {
                    streamId: '1-0',
                    itemKind: 'request',
                    messageId: 'message-1',
                    correlationId: 'correlation-1',
                    sourceSessionId: 'source',
                    targetSessionId: 'target',
                    createdAt: '2026-07-29T12:00:00.000Z',
                    payload: {
                      kind: 'question',
                      content: 'Hello',
                      evidenceRequirements: [],
                      deadlineAt: '2026-07-29T12:02:00.000Z',
                    },
                  },
                ],
              });
            }
            listeners.get('SIGINT')?.();
            return response({ items: [] });
          }
          return response({
            id: 'message-1',
            correlationId: 'correlation-1',
            projectId: 'project-1',
            sourceSessionId: 'source',
            sourceAgentId: 'claude-sim',
            targetSessionId: 'target',
            targetAgentId: 'gemini-sim',
            selectionReason: 'selected target',
            kind: 'question',
            content: 'Hello',
            evidenceRequirements: [],
            state: url.endsWith('/respond')
              ? 'responded'
              : url.endsWith('/processing')
                ? 'processing'
                : url.endsWith('/acknowledge')
                  ? 'acknowledged'
                  : 'delivered',
            createdAt: '2026-07-29T12:00:00.000Z',
            updatedAt: '2026-07-29T12:00:00.000Z',
            deadlineAt: '2026-07-29T12:02:00.000Z',
            ...(url.endsWith('/respond')
              ? {
                  response: JSON.parse(init?.body ?? '{}').response,
                  respondedAt: '2026-07-29T12:00:01.000Z',
                }
              : {}),
          });
        },
        stdout: { write: (text) => (output += text) },
        signals: {
          once: (signal, listener) => listeners.set(signal, listener),
          off: (signal) => listeners.delete(signal),
        },
      },
    );

    expect(requested.some(({ url }) => url.endsWith('/acknowledge'))).toBe(true);
    expect(requested.some(({ url }) => url.endsWith('/processing'))).toBe(true);
    const responded = requested.find(({ url }) => url.endsWith('/respond'));
    expect(responded?.body).toMatchObject({
      responderSessionId: 'target',
      response: {
        status: 'answered',
        answer: '[simulated echo] Hello',
        evidence: [],
      },
    });
    expect(requested.some(({ url }) => url.endsWith('/close'))).toBe(false);
    expect(output).not.toContain('Hello');
    expect(output).toContain('"redacted": true');
  });

  it('continues recovered processing work without repeating earlier transitions', async () => {
    const listeners = new Map<string, () => void>();
    const requested: Array<{ url: string; body: unknown }> = [];
    let claimCount = 0;
    await runCli(
      [
        'session',
        'bridge',
        'simulate',
        '--session',
        'target',
        '--bridge-instance',
        'bridge-recovered',
        '--mode',
        'echo',
        '--block-ms',
        '0',
        '--min-idle-ms',
        '0',
      ],
      {
        fetch: async (url, init) => {
          requested.push({
            url,
            body: init?.body === undefined ? undefined : JSON.parse(init.body),
          });
          if (url.endsWith('/inbox/claim')) {
            claimCount += 1;
            if (claimCount === 1) {
              return response({
                items: [
                  {
                    streamId: '1-0',
                    itemKind: 'request',
                    messageId: 'message-1',
                    correlationId: 'correlation-1',
                    sourceSessionId: 'source',
                    targetSessionId: 'target',
                    createdAt: '2026-07-29T12:00:00.000Z',
                    payload: {
                      kind: 'question',
                      content: 'Resume',
                      evidenceRequirements: [],
                      deadlineAt: '2026-07-29T12:02:00.000Z',
                    },
                  },
                ],
              });
            }
            listeners.get('SIGINT')?.();
            return response({ items: [] });
          }
          return response({
            id: 'message-1',
            correlationId: 'correlation-1',
            projectId: 'project-1',
            sourceSessionId: 'source',
            sourceAgentId: 'claude-sim',
            targetSessionId: 'target',
            targetAgentId: 'gemini-sim',
            selectionReason: 'selected target',
            kind: 'question',
            content: 'Resume',
            evidenceRequirements: [],
            state: url.endsWith('/respond') ? 'responded' : 'processing',
            createdAt: '2026-07-29T12:00:00.000Z',
            updatedAt: '2026-07-29T12:00:00.000Z',
            deadlineAt: '2026-07-29T12:02:00.000Z',
            ...(url.endsWith('/respond')
              ? {
                  response: JSON.parse(init?.body ?? '{}').response,
                  respondedAt: '2026-07-29T12:00:01.000Z',
                }
              : {}),
          });
        },
        stdout: { write: () => undefined },
        signals: {
          once: (signal, listener) => listeners.set(signal, listener),
          off: (signal) => listeners.delete(signal),
        },
      },
    );

    expect(requested.some(({ url }) => url.endsWith('/acknowledge'))).toBe(false);
    expect(requested.some(({ url }) => url.endsWith('/processing'))).toBe(false);
    expect(requested.some(({ url }) => url.endsWith('/respond'))).toBe(true);
  });
});

describe('lease commands', () => {
  const heldLease = {
    id: 'lease-1',
    projectId: 'p1',
    sessionId: 's1',
    agentId: 'codex-main',
    path: 'src/app.ts',
    matchPath: 'src/app.ts/',
    reason: 'editing the shell',
    state: 'held',
    acquiredAt: '2026-08-16T08:00:00.000Z',
    expiresAt: '2026-08-16T08:05:00.000Z',
  };

  it('acquires a lease through the daemon and prints the grant', async () => {
    let requestedUrl = '';
    let requestedBody: unknown;
    let output = '';
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url, init) => {
        requestedUrl = url;
        requestedBody = JSON.parse(init?.body ?? '{}');
        return response({ status: 'granted', lease: heldLease }, { status: 201 });
      },
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(
      [
        'lease',
        'acquire',
        '--project',
        'p1',
        '--session',
        's1',
        '--path',
        'src/app.ts',
        '--reason',
        'editing the shell',
      ],
      dependencies,
    );

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases');
    expect(requestedBody).toEqual({
      projectId: 'p1',
      sessionId: 's1',
      path: 'src/app.ts',
      reason: 'editing the shell',
    });
    expect(JSON.parse(output)).toEqual({ status: 'granted', lease: heldLease });
  });

  it('prints a denial as a successful answer, with the holder named', async () => {
    let output = '';
    const denied = {
      status: 'denied',
      conflict: {
        leaseId: 'lease-9',
        sessionId: 's2',
        agentId: 'claude-main',
        path: 'src',
        reason: 'refactoring the tree',
        expiresAt: '2026-08-16T08:10:00.000Z',
      },
    };
    const dependencies: Partial<CliDependencies> = {
      fetch: async () => response(denied),
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(
      [
        'lease',
        'acquire',
        '--project',
        'p1',
        '--session',
        's1',
        '--path',
        'src/app.ts',
        '--reason',
        'edit',
      ],
      dependencies,
    );

    expect(JSON.parse(output)).toEqual(denied);
  });

  it('passes an explicit duration through to the daemon', async () => {
    let requestedBody: unknown;
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url, init) => {
        requestedBody = JSON.parse(init?.body ?? '{}');
        return response({ status: 'granted', lease: heldLease }, { status: 201 });
      },
      stdout: { write: () => undefined },
    };

    await runCli(
      [
        'lease',
        'acquire',
        '--project',
        'p1',
        '--session',
        's1',
        '--path',
        'src/app.ts',
        '--reason',
        'edit',
        '--duration-ms',
        '60000',
      ],
      dependencies,
    );

    expect(requestedBody).toMatchObject({ durationMs: 60000 });
  });

  it('renews a lease for its holding session', async () => {
    let requestedUrl = '';
    let requestedBody: unknown;
    let output = '';
    const renewed = { ...heldLease, renewedAt: '2026-08-16T08:04:00.000Z' };
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url, init) => {
        requestedUrl = url;
        requestedBody = JSON.parse(init?.body ?? '{}');
        return response(renewed);
      },
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(['lease', 'renew', 'lease-1', '--session', 's1'], dependencies);

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases/lease-1/renew');
    expect(requestedBody).toEqual({ sessionId: 's1' });
    expect(JSON.parse(output)).toEqual(renewed);
  });

  it('releases a lease for its holding session', async () => {
    let requestedUrl = '';
    let requestedBody: unknown;
    const released = {
      ...heldLease,
      state: 'released',
      releasedAt: '2026-08-16T08:04:30.000Z',
    };
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url, init) => {
        requestedUrl = url;
        requestedBody = JSON.parse(init?.body ?? '{}');
        return response(released);
      },
      stdout: { write: () => undefined },
    };

    await runCli(['lease', 'release', 'lease-1', '--session', 's1'], dependencies);

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases/lease-1/release');
    expect(requestedBody).toEqual({ sessionId: 's1' });
  });

  it('lists leases with filters as query parameters', async () => {
    let requestedUrl = '';
    let output = '';
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url) => {
        requestedUrl = url;
        return response({ leases: [heldLease], truncated: false });
      },
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(['lease', 'list', '--project', 'p1', '--session', 's1'], dependencies);

    expect(requestedUrl).toBe(
      'http://127.0.0.1:4782/api/v1/leases?limit=100&projectId=p1&sessionId=s1',
    );
    expect(JSON.parse(output)).toEqual({ leases: [heldLease], truncated: false });
  });

  it('gets one lease by id', async () => {
    let requestedUrl = '';
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url) => {
        requestedUrl = url;
        return response(heldLease);
      },
      stdout: { write: () => undefined },
    };

    await runCli(['lease', 'get', 'lease-1'], dependencies);

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases/lease-1');
  });
});
