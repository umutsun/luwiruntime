import { ApplicationError } from '@luwi/runtime';
import { describe, expect, it, vi } from 'vitest';

import { runCli, type CliDependencies, type CliWebSocket, type HttpResponseLike } from './cli.js';
import { DeepSeekBridgeStartupCancelledError, type DeepSeekAcpFactory } from './deepseek-bridge.js';
import type { LifecycleService } from './lifecycle.js';
import type { ProjectDiscoveryService } from './project-discovery.js';

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
  it('registers the CLI-first lifecycle command surface with stable arguments', async () => {
    const status = {
      daemon: { state: 'ready' as const, managed: true, ownership: 'owned' as const, pid: 42 },
      redis: { state: 'connected' as const, compose: 'running' as const },
      endpoints: {
        daemon: 'http://127.0.0.1:4782',
        redis: 'redis://127.0.0.1:6379',
      },
    };
    const lifecycle: LifecycleService = {
      doctor: vi.fn(async () => ({
        ready: true,
        checks: [{ id: 'node', status: 'ok', summary: 'Node.js 22' }],
        endpoints: {
          daemon: 'http://127.0.0.1:4782',
          redis: 'redis://127.0.0.1:6379',
        },
        roots: {
          luwiHome: 'C:/fixture/.luwi',
          claude: 'C:/fixture/.claude',
          codex: 'C:/fixture/.codex',
          gemini: 'C:/fixture/.gemini',
        },
      })),
      setup: vi.fn(async () => ({
        changed: true,
        target: 'C:/fixture/.luwi/runtime/config.json',
        hooks: ['luwi agent run codex -- <native arguments>'],
      })),
      start: vi.fn(async () => status),
      status: vi.fn(async () => status),
      stop: vi.fn(async () => ({
        ...status,
        daemon: { state: 'stopped', managed: false, ownership: 'none' },
      })),
      resetRuntimeState: vi.fn(async () => ({
        namespace: 'luwi:v1:' as const,
        matched: 12,
        deleted: 0,
        status: 'confirmation_required' as const,
      })),
    };
    let output = '';
    const dependencies: Partial<CliDependencies> = {
      lifecycle,
      stdout: { write: (text) => (output += text) },
    };

    await runCli(['doctor', '--json'], dependencies);
    expect(JSON.parse(output)).toMatchObject({ ready: true });
    output = '';
    await runCli(['setup', '--yes', '--print-hooks'], dependencies);
    // No autostart flag: neither enable nor disable is requested, so setup just
    // reports the current state (ADR 0027 — autostart is never silently changed).
    expect(lifecycle.setup).toHaveBeenCalledWith({
      approved: true,
      printHooks: true,
      autostart: false,
      noAutostart: false,
    });
    (lifecycle.setup as ReturnType<typeof vi.fn>).mockClear();
    await runCli(['setup', '--yes', '--autostart'], dependencies);
    expect(lifecycle.setup).toHaveBeenCalledWith({
      approved: true,
      printHooks: false,
      autostart: true,
      noAutostart: false,
    });
    (lifecycle.setup as ReturnType<typeof vi.fn>).mockClear();
    await runCli(['setup', '--yes', '--no-autostart'], dependencies);
    expect(lifecycle.setup).toHaveBeenCalledWith({
      approved: true,
      printHooks: false,
      autostart: false,
      noAutostart: true,
    });
    output = '';
    await runCli(['start'], dependencies);
    expect(lifecycle.start).toHaveBeenCalledWith({});
    output = '';
    await runCli(['status', '--json'], dependencies);
    expect(JSON.parse(output)).toMatchObject({ daemon: { state: 'ready' } });
    output = '';
    await runCli(['stop', '--with-redis'], dependencies);
    expect(lifecycle.stop).toHaveBeenCalledWith({ withRedis: true });
    output = '';
    await runCli(['reset', '--runtime-state', '--json'], dependencies);
    expect(lifecycle.resetRuntimeState).toHaveBeenCalledWith({
      approved: false,
      interactive: false,
    });
    expect(JSON.parse(output)).toMatchObject({
      namespace: 'luwi:v1:',
      status: 'confirmation_required',
    });
  });

  it('renders concise human diagnostics without requiring JSON parsing', async () => {
    let output = '';
    await runCli(['doctor'], {
      lifecycle: {
        doctor: vi.fn(async () => ({
          ready: false,
          checks: [
            { id: 'node', status: 'ok', summary: 'Node.js 22' },
            {
              id: 'daemon',
              status: 'warning',
              summary: 'The daemon is not running.',
              hint: 'Run luwi start.',
            },
          ],
          endpoints: {
            daemon: 'http://127.0.0.1:4782',
            redis: 'redis://127.0.0.1:6379',
          },
          roots: {
            luwiHome: 'C:/fixture/.luwi',
            claude: 'C:/fixture/.claude',
            codex: 'C:/fixture/.codex',
            gemini: 'C:/fixture/.gemini',
          },
        })),
        setup: vi.fn(),
        start: vi.fn(),
        status: vi.fn(),
        stop: vi.fn(),
      } as unknown as LifecycleService,
      stdout: { write: (text) => (output += text) },
    });

    expect(output).toContain('[ok] node: Node.js 22');
    expect(output).toContain('[warning] daemon: The daemon is not running.');
    expect(output).toContain('Run luwi start.');
  });

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

  it('prints passive capability scan diagnostics instead of a catalogue-shaped guess', async () => {
    let output = '';
    let requestedInit: unknown;
    const scan = {
      capabilities: [],
      diagnostics: {
        rootsScanned: 3,
        rootsUnavailable: 4,
        malformedManifests: 2,
        ignoredEntries: 1,
        conflictsSkipped: 0,
        truncated: false,
      },
    };
    const dependencies: Partial<CliDependencies> = {
      fetch: async (_url, init) => {
        requestedInit = init;
        return response(scan);
      },
      stdout: { write: (text) => (output += text) },
    };

    await runCli(['capability', 'scan'], dependencies);

    expect(requestedInit).toMatchObject({ method: 'POST', body: '{}' });
    expect(JSON.parse(output)).toEqual(scan);
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

  it('discovers projects as a read-only dry run by default', async () => {
    let output = '';
    const requests: Array<{ url: string; method: string }> = [];
    const projectDiscovery: ProjectDiscoveryService = {
      createPlan: vi.fn(async () => ({
        root: 'C:\\xampp\\htdocs',
        selected: [
          {
            directoryName: 'luwiruntime',
            displayName: 'LUWI Runtime',
            localPath: 'C:\\xampp\\htdocs\\luwiruntime',
            canonicalPath: 'C:\\xampp\\htdocs\\luwiruntime',
            existingProjectId: 'project-1',
          },
        ],
        excluded: [],
        invalid: [],
      })),
    };

    await runCli(['project', 'discover', 'C:\\xampp\\htdocs', '--json'], {
      projectDiscovery,
      fetch: async (url, init) => {
        requests.push({ url, method: init?.method ?? 'GET' });
        return response({
          projects: [
            {
              id: 'project-1',
              name: 'LUWI Runtime',
              localPath: 'C:\\xampp\\htdocs\\luwiruntime',
              canonicalPath: 'C:\\xampp\\htdocs\\luwiruntime',
              createdAt: '2026-08-25T12:00:00.000Z',
              updatedAt: '2026-08-25T12:00:00.000Z',
            },
          ],
        });
      },
      stdout: { write: (text) => (output += text) },
    });

    expect(requests).toEqual([{ url: 'http://127.0.0.1:4782/api/v1/projects', method: 'GET' }]);
    expect(JSON.parse(output)).toMatchObject({
      mode: 'dry_run',
      plan: { root: 'C:\\xampp\\htdocs' },
    });
  });

  it('applies discovery idempotently and classifies a non-Git project', async () => {
    let output = '';
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const projectDiscovery: ProjectDiscoveryService = {
      createPlan: vi.fn(async () => ({
        root: 'C:\\xampp\\htdocs',
        selected: [
          {
            directoryName: 'luwiruntime',
            displayName: 'LUWI Runtime',
            localPath: 'C:\\xampp\\htdocs\\luwiruntime',
            canonicalPath: 'C:\\xampp\\htdocs\\luwiruntime',
            existingProjectId: 'project-1',
          },
          {
            directoryName: 'glasshouse',
            displayName: 'Glasshouse',
            localPath: 'C:\\xampp\\htdocs\\glasshouse',
            canonicalPath: 'C:\\xampp\\htdocs\\glasshouse',
          },
        ],
        excluded: [],
        invalid: [],
      })),
    };

    await runCli(['project', 'discover', 'C:\\xampp\\htdocs', '--apply', '--json'], {
      projectDiscovery,
      fetch: async (url, init) => {
        requests.push({
          url,
          method: init?.method ?? 'GET',
          ...(init?.body === undefined ? {} : { body: init.body }),
        });
        if (url.endsWith('/api/v1/projects')) {
          if (init?.method === 'POST') {
            return response({
              id: 'project-2',
              name: 'Glasshouse',
              localPath: 'C:\\xampp\\htdocs\\glasshouse',
              canonicalPath: 'C:\\xampp\\htdocs\\glasshouse',
              createdAt: '2026-08-25T12:00:00.000Z',
              updatedAt: '2026-08-25T12:00:00.000Z',
            });
          }
          return response({
            projects: [
              {
                id: 'project-1',
                name: 'LUWI Runtime',
                localPath: 'C:\\xampp\\htdocs\\luwiruntime',
                canonicalPath: 'C:\\xampp\\htdocs\\luwiruntime',
                createdAt: '2026-08-25T12:00:00.000Z',
                updatedAt: '2026-08-25T12:00:00.000Z',
              },
            ],
          });
        }
        if (url.includes('/project-1/git/scan')) {
          expect(init).toMatchObject({
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          return response({
            id: 'git-1',
            projectId: 'project-1',
            repositoryRoot: 'C:\\xampp\\htdocs\\luwiruntime',
            clean: true,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            branches: [],
            tags: [],
            worktrees: [],
            recentCommits: [],
            observedAt: '2026-08-25T12:00:00.000Z',
            repositoryStateHash: 'a'.repeat(64),
          });
        }
        expect(init).toMatchObject({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        return response(
          { error: { code: 'GIT_REPOSITORY_NOT_FOUND', message: 'Not a Git repository.' } },
          { ok: false, status: 404 },
        );
      },
      stdout: { write: (text) => (output += text) },
    });

    expect(requests.filter(({ url }) => url.endsWith('/api/v1/projects'))).toEqual([
      { url: 'http://127.0.0.1:4782/api/v1/projects', method: 'GET' },
      {
        url: 'http://127.0.0.1:4782/api/v1/projects',
        method: 'POST',
        body: JSON.stringify({ name: 'Glasshouse', localPath: 'C:\\xampp\\htdocs\\glasshouse' }),
      },
    ]);
    expect(JSON.parse(output)).toMatchObject({
      mode: 'applied',
      registered: [{ directoryName: 'glasshouse', projectId: 'project-2' }],
      unchanged: [{ directoryName: 'luwiruntime', projectId: 'project-1' }],
      conflict: [],
      failed: [],
      git: [
        { directoryName: 'luwiruntime', projectId: 'project-1', status: 'observed' },
        { directoryName: 'glasshouse', projectId: 'project-2', status: 'not_git' },
      ],
    });
  });

  it('captures discovery registration conflicts and failures without attempting Git scans', async () => {
    let output = '';
    const requestedUrls: string[] = [];
    const projectDiscovery: ProjectDiscoveryService = {
      createPlan: vi.fn(async () => ({
        root: 'C:\\xampp\\htdocs',
        selected: ['conflict', 'failed'].map((directoryName) => ({
          directoryName,
          displayName: directoryName,
          localPath: `C:\\xampp\\htdocs\\${directoryName}`,
          canonicalPath: `C:\\xampp\\htdocs\\${directoryName}`,
        })),
        excluded: [],
        invalid: [],
      })),
    };

    await runCli(['project', 'discover', 'C:\\xampp\\htdocs', '--apply', '--json'], {
      projectDiscovery,
      fetch: async (url, init) => {
        requestedUrls.push(url);
        if (init?.method !== 'POST') return response({ projects: [] });
        const body = JSON.parse(init.body ?? '{}') as { name?: string };
        return body.name === 'conflict'
          ? response(
              { error: { code: 'PROJECT_PATH_CONFLICT', message: 'Path already registered.' } },
              { ok: false, status: 409 },
            )
          : response(
              { error: { code: 'PROJECT_REGISTRATION_FAILED', message: 'Registration failed.' } },
              { ok: false, status: 500 },
            );
      },
      stdout: { write: (text) => (output += text) },
    });

    expect(requestedUrls.some((url) => url.includes('/git/scan'))).toBe(false);
    expect(JSON.parse(output)).toMatchObject({
      registered: [],
      unchanged: [],
      conflict: [{ directoryName: 'conflict', code: 'PROJECT_PATH_CONFLICT' }],
      failed: [{ directoryName: 'failed', code: 'PROJECT_REGISTRATION_FAILED' }],
      git: [],
    });
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

  it('sends an optional native reference with session registration', async () => {
    let body: unknown;
    let output = '';
    const session = {
      id: 'session-1',
      agentId: 'claude-sim',
      projectId: 'project-1',
      status: 'starting',
      workingDirectory: 'C:/workspace/luwi',
      startedAt: '2026-07-28T12:00:00.000Z',
      lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
      metadata: {},
      presence: 'online',
    };

    await runCli(
      [
        'session',
        'register',
        '--project',
        'project-1',
        '--agent',
        'claude-sim',
        '--working-directory',
        'C:/workspace/luwi',
        '--native-adapter',
        'claude-code',
        '--native-session',
        '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
      ],
      {
        fetch: async (_url, init) => {
          body = init?.body === undefined ? undefined : JSON.parse(init.body);
          return response(session, { status: 201 });
        },
        stdout: { write: (text) => (output += text) },
      },
    );

    expect(body).toMatchObject({
      projectId: 'project-1',
      native: {
        adapterId: 'claude-code',
        nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
      },
    });
    expect(JSON.parse(output).id).toBe('session-1');
  });

  it('registers without a native block when no native option is given', async () => {
    let body: Record<string, unknown> | undefined;

    await runCli(
      [
        'session',
        'register',
        '--project',
        'project-1',
        '--agent',
        'claude-sim',
        '--working-directory',
        'C:/workspace/luwi',
      ],
      {
        fetch: async (_url, init) => {
          body = init?.body === undefined ? undefined : JSON.parse(init.body);
          return response(
            {
              id: 'session-1',
              agentId: 'claude-sim',
              projectId: 'project-1',
              status: 'starting',
              workingDirectory: 'C:/workspace/luwi',
              startedAt: '2026-07-28T12:00:00.000Z',
              lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
              metadata: {},
              presence: 'online',
            },
            { status: 201 },
          );
        },
        stdout: { write: () => undefined },
      },
    );

    expect(body).toBeDefined();
    expect(body?.native).toBeUndefined();
  });

  it('refuses a half-supplied native reference before any request is made', async () => {
    const fetch = vi.fn();

    await expect(
      runCli(
        [
          'session',
          'register',
          '--project',
          'project-1',
          '--agent',
          'claude-sim',
          '--working-directory',
          'C:/workspace/luwi',
          '--native-adapter',
          'claude-code',
        ],
        { fetch, stdout: { write: () => undefined } },
      ),
    ).rejects.toMatchObject({ code: 'CLI_OPTION_INVALID' });
    expect(fetch).not.toHaveBeenCalled();
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
        '--native-adapter',
        'claude-code',
        '--native-session',
        '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
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
    const registration = requests.find(({ url }) => url.endsWith('/sessions'));
    expect(registration?.body).toMatchObject({
      native: {
        adapterId: 'claude-code',
        nativeSessionId: '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34',
      },
    });
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

  it('runs an opt-in DeepSeek ACP bridge without adding DeepSeek behavior to the daemon', async () => {
    const listeners = new Map<string, () => void>();
    const requests: Array<{ url: string; body: unknown }> = [];
    let output = '';
    let factoryOptions: unknown;
    let startInput: unknown;
    const acpFactory: DeepSeekAcpFactory = {
      start: vi.fn(async (input) => {
        startInput = input;
        return {
          sessionId: 'deepseek-native-1',
          closed: new Promise<void>(() => undefined),
          prompt: vi.fn(async () => ({ text: 'Done.', stopReason: 'end_turn' })),
          cancel: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
        };
      }),
    };
    const session = {
      id: 'luwi-deepseek-1',
      agentId: 'deepseek-agent',
      projectId: 'project-1',
      status: 'idle',
      workingDirectory: 'C:/workspace',
      startedAt: '2026-08-24T00:00:00.000Z',
      lastHeartbeatAt: '2026-08-24T00:00:00.000Z',
      metadata: { bridge: 'deepseek-harness-acp', experimental: true },
      presence: 'online',
    };
    const createFactory = vi.fn((options: unknown) => {
      factoryOptions = options;
      return acpFactory;
    });

    await runCli(
      [
        'session',
        'bridge',
        'deepseek',
        '--project',
        'project-1',
        '--agent',
        'deepseek-agent',
        '--working-directory',
        'C:/workspace',
        '--bridge-instance',
        'deepseek-bridge-1',
        '--command',
        'node',
        '--args-json',
        '["acp-agent.mjs"]',
        '--block-ms',
        '0',
      ],
      {
        createDeepSeekAcpFactory: createFactory,
        fetch: async (url, init) => {
          const body = init?.body === undefined ? undefined : JSON.parse(init.body);
          requests.push({ url, body });
          if (url.endsWith('/inbox/claim')) {
            listeners.get('SIGINT')?.();
            return response({ items: [] });
          }
          if (url.endsWith('/native')) {
            return response({
              outcome: 'created',
              binding: {
                id: 'binding-1',
                adapterId: 'deepseek-harness-acp-v1',
                nativeSessionId: 'deepseek-native-1',
                kind: 'main',
                openLinkId: 'link-1',
                version: 1,
                linkCount: 1,
                trimmedLinkCount: 0,
                firstLinkedAt: '2026-08-24T00:00:00.000Z',
                lastLinkedAt: '2026-08-24T00:00:00.000Z',
              },
              link: {
                id: 'link-1',
                bindingId: 'binding-1',
                sessionId: 'luwi-deepseek-1',
                linkedAt: '2026-08-24T00:00:00.000Z',
              },
            });
          }
          if (url.endsWith('/heartbeat')) {
            return response({ status: 'renewed', eventEmitted: false });
          }
          if (url.endsWith('/status')) {
            return response({ ...session, status: (body as { status: string }).status });
          }
          if (url.endsWith('/close')) {
            return response({ ...session, status: 'completed', presence: 'offline' });
          }
          return response(session, { status: 201 });
        },
        signals: {
          once: (signal, listener) => listeners.set(signal, listener),
          off: (signal) => listeners.delete(signal),
        },
        stdout: { write: (text) => (output += text) },
      },
    );

    expect(factoryOptions).toMatchObject({
      command: 'node',
      args: ['acp-agent.mjs'],
      permission: 'reject',
    });
    expect(startInput).toEqual({
      workingDirectory: 'C:/workspace',
      signal: expect.any(AbortSignal),
      environment: {
        LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
        LUWI_SESSION_ID: 'luwi-deepseek-1',
      },
    });
    expect(requests.find(({ url }) => url.endsWith('/native'))?.body).toEqual({
      native: {
        adapterId: 'deepseek-harness-acp-v1',
        nativeSessionId: 'deepseek-native-1',
      },
    });
    expect(requests.filter(({ url }) => url.endsWith('/close'))).toHaveLength(1);
    expect(output).toContain('luwi-deepseek-1');
    expect(output).not.toContain('Done.');
  });

  it('handles a termination signal during DeepSeek ACP startup and rolls back the LUWI session', async () => {
    const listeners = new Map<string, () => void>();
    const requested: string[] = [];
    const session = {
      id: 'luwi-deepseek-starting',
      agentId: 'deepseek-agent',
      projectId: 'project-1',
      status: 'starting',
      workingDirectory: 'C:/workspace',
      startedAt: '2026-08-24T00:00:00.000Z',
      lastHeartbeatAt: '2026-08-24T00:00:00.000Z',
      metadata: { bridge: 'deepseek-harness-acp', experimental: true },
      presence: 'online',
    };
    const acpFactory: DeepSeekAcpFactory = {
      start: vi.fn(
        async (input) =>
          await new Promise((_resolve, reject) => {
            expect(listeners.has('SIGINT')).toBe(true);
            input.signal.addEventListener(
              'abort',
              () => reject(new DeepSeekBridgeStartupCancelledError()),
              { once: true },
            );
            listeners.get('SIGINT')?.();
          }),
      ),
    };

    await expect(
      runCli(
        [
          'session',
          'bridge',
          'deepseek',
          '--project',
          'project-1',
          '--agent',
          'deepseek-agent',
          '--working-directory',
          'C:/workspace',
          '--bridge-instance',
          'deepseek-bridge-startup',
          '--command',
          'node',
        ],
        {
          createDeepSeekAcpFactory: () => acpFactory,
          fetch: async (url) => {
            requested.push(url);
            return response(
              url.endsWith('/close')
                ? { ...session, status: 'completed', presence: 'offline' }
                : session,
              { status: url.endsWith('/sessions') ? 201 : 200 },
            );
          },
          signals: {
            once: (signal, listener) => listeners.set(signal, listener),
            off: (signal) => listeners.delete(signal),
          },
          stdout: { write: () => undefined },
        },
      ),
    ).resolves.toBeUndefined();

    expect(requested.filter((url) => url.endsWith('/close'))).toHaveLength(1);
    expect(listeners.size).toBe(0);
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

/** A minimal in-memory Codex rollout tree for the disk-fallback attach tests. */
function rolloutFileSystem(
  files: Record<string, { content: string; modifiedAtMs: number }>,
): CliDependencies['transcriptFileSystem'] {
  const norm = (path: string): string => path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const map = new Map(Object.entries(files).map(([path, file]) => [norm(path), file]));
  return {
    async listDirectory(path) {
      const prefix = `${norm(path)}/`;
      const children = new Map<string, boolean>();
      let exists = false;
      for (const filePath of map.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        exists = true;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) children.set(rest, false);
        else children.set(rest.slice(0, slash), true);
      }
      return exists
        ? [...children.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
        : undefined;
    },
    async stat(path) {
      const file = map.get(norm(path));
      return file === undefined
        ? undefined
        : { modifiedAtMs: file.modifiedAtMs, sizeBytes: Buffer.byteLength(file.content, 'utf8') };
    },
    async readLines(path) {
      const file = map.get(norm(path));
      return file === undefined ? undefined : { lines: file.content.split('\n'), truncated: false };
    },
  };
}

function codexRollout(sessionId: string, cwd: string): string {
  const meta = { type: 'session_meta', payload: { session_id: sessionId, id: sessionId, cwd } };
  return `${JSON.stringify(meta)}\n${JSON.stringify({ type: 'response_item', payload: {} })}\n`;
}

describe('session attach', () => {
  const registered = {
    id: 'session-attached',
    agentId: 'claude-code',
    projectId: 'project-1',
    status: 'starting',
    workingDirectory: 'C:/work',
    startedAt: '2026-08-17T12:00:00.000Z',
    lastHeartbeatAt: '2026-08-17T12:00:00.000Z',
    metadata: {},
    presence: 'online',
  };

  it('declares the identity the environment carries, then heartbeats', async () => {
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const timers: Array<() => void> = [];
    let signalListener: (() => void) | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: {
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: '64c3e219-18aa-4539-9104-89d3d2ac5629',
      },
      // No real filesystem: the default realpath is genuine IO that, under full
      // suite load, can outlast the single tick this test waits for registration.
      canonicalizePath: async (path: string) => path,
      fetch: async (url, init) => {
        urls.push(url);
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return response(registered);
      },
      setInterval: ((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as NodeJS.Timeout;
      }) as never,
      clearInterval: (() => undefined) as never,
      signals: {
        once: (_signal: string, listener: () => void) => {
          signalListener = listener;
          return undefined;
        },
        off: () => undefined,
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    };

    const run = runCli(
      ['session', 'attach', '--project', 'project-1', '--agent', 'claude-code'],
      dependencies,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    // Registration carried the native reference resolved from the environment.
    expect(bodies[0]).toMatchObject({
      projectId: 'project-1',
      agentId: 'claude-code',
      native: {
        adapterId: 'claude-code',
        nativeSessionId: '64c3e219-18aa-4539-9104-89d3d2ac5629',
      },
    });

    // A beat goes to the registered session, not a guessed id.
    timers[0]?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(urls.some((url) => url.endsWith('/api/v1/sessions/session-attached/heartbeat'))).toBe(
      true,
    );

    signalListener?.();
    await run;
    expect(urls.some((url) => url.endsWith('/api/v1/sessions/session-attached/close'))).toBe(true);
  });

  it('registers without a native block when the environment carries no identity', async () => {
    // Honest: the session is visible but unattributed, rather than bound to a
    // reference that was invented for it.
    const bodies: unknown[] = [];
    let signalListener: (() => void) | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: {},
      canonicalizePath: async (path: string) => path,
      fetch: async (_url, init) => {
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return response(registered);
      },
      setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
      clearInterval: (() => undefined) as never,
      signals: {
        once: (_signal: string, listener: () => void) => {
          signalListener = listener;
          return undefined;
        },
        off: () => undefined,
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    };

    const run = runCli(
      ['session', 'attach', '--project', 'project-1', '--agent', 'codex'],
      dependencies,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    signalListener?.();
    await run;

    expect(bodies[0]).toMatchObject({ projectId: 'project-1', agentId: 'codex' });
    expect((bodies[0] as Record<string, unknown>)['native']).toBeUndefined();
  });

  const CODEX_NOW = 1_756_000_000_000;

  it('recovers a Codex identity from the rollout tree when the environment carries none', async () => {
    // Codex Desktop and the VSCode extension export no session-id variable, so the
    // environment resolver finds nothing and the disk fallback (ADR 0028) recovers
    // the id from a fresh, cwd-matching rollout.
    const bodies: unknown[] = [];
    let signalListener: (() => void) | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: { USERPROFILE: 'C:\\Users\\umuts' },
      platform: 'win32',
      now: () => new Date(CODEX_NOW),
      canonicalizePath: async (path: string) => path,
      transcriptFileSystem: rolloutFileSystem({
        'C:/Users/umuts/.codex/sessions/2026/09/01/rollout-x.jsonl': {
          content: codexRollout('01a05c7d-d90a-7a62-8856-ebd3bf43f1c7', 'C:\\work'),
          modifiedAtMs: CODEX_NOW - 1_000,
        },
      }),
      fetch: async (_url, init) => {
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return response(registered);
      },
      setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
      clearInterval: (() => undefined) as never,
      signals: {
        once: (_signal: string, listener: () => void) => {
          signalListener = listener;
          return undefined;
        },
        off: () => undefined,
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    };

    const run = runCli(
      [
        'session',
        'attach',
        '--project',
        'project-1',
        '--agent',
        'codex-agent',
        '--agent-kind',
        'codex',
        '--working-directory',
        'C:/work',
      ],
      dependencies,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    signalListener?.();
    await run;

    expect(bodies[0]).toMatchObject({
      projectId: 'project-1',
      agentId: 'codex-agent',
      native: { adapterId: 'codex', nativeSessionId: '01a05c7d-d90a-7a62-8856-ebd3bf43f1c7' },
    });
  });

  it('lets the environment win over a disk rollout and never reads disk when CODEX_SESSION_ID is set', async () => {
    // ADR 0028 guard #1: the environment resolver is deterministic and preferred,
    // so a present CODEX_SESSION_ID is declared and the rollout tree is never read.
    const bodies: unknown[] = [];
    let signalListener: (() => void) | undefined;
    const diskCalls: string[] = [];
    const recordingFileSystem: CliDependencies['transcriptFileSystem'] = {
      listDirectory: async (path) => {
        diskCalls.push(`listDirectory:${path}`);
        return undefined;
      },
      stat: async (path) => {
        diskCalls.push(`stat:${path}`);
        return undefined;
      },
      readLines: async (path) => {
        diskCalls.push(`readLines:${path}`);
        return undefined;
      },
    };
    const dependencies: Partial<CliDependencies> = {
      environment: { CODEX_SESSION_ID: 'env-session-uuid', USERPROFILE: 'C:\\Users\\umuts' },
      platform: 'win32',
      now: () => new Date(CODEX_NOW),
      canonicalizePath: async (path: string) => path,
      transcriptFileSystem: recordingFileSystem,
      fetch: async (_url, init) => {
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return response(registered);
      },
      setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
      clearInterval: (() => undefined) as never,
      signals: {
        once: (_signal: string, listener: () => void) => {
          signalListener = listener;
          return undefined;
        },
        off: () => undefined,
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    };

    const run = runCli(
      [
        'session',
        'attach',
        '--project',
        'project-1',
        '--agent',
        'codex-agent',
        '--agent-kind',
        'codex',
        '--working-directory',
        'C:/work',
      ],
      dependencies,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    signalListener?.();
    await run;

    expect(bodies[0]).toMatchObject({
      native: { adapterId: 'codex', nativeSessionId: 'env-session-uuid' },
    });
    expect(diskCalls).toEqual([]);
  });

  it('canonicalizes an aliased working directory before the Codex cwd-match', async () => {
    // A junction/subst alias (P:\\luwi) resolves to the path the rollout recorded,
    // so attach must canonicalize before comparing or it would lose attribution.
    const bodies: unknown[] = [];
    let signalListener: (() => void) | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: { USERPROFILE: 'C:\\Users\\umuts' },
      platform: 'win32',
      now: () => new Date(CODEX_NOW),
      canonicalizePath: async (path: string) => (path === 'P:/luwi' ? 'C:/work' : path),
      transcriptFileSystem: rolloutFileSystem({
        'C:/Users/umuts/.codex/sessions/2026/09/01/rollout-x.jsonl': {
          content: codexRollout('aliased-session', 'C:\\work'),
          modifiedAtMs: CODEX_NOW - 1_000,
        },
      }),
      fetch: async (_url, init) => {
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return response(registered);
      },
      setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
      clearInterval: (() => undefined) as never,
      signals: {
        once: (_signal: string, listener: () => void) => {
          signalListener = listener;
          return undefined;
        },
        off: () => undefined,
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    };

    const run = runCli(
      [
        'session',
        'attach',
        '--project',
        'project-1',
        '--agent',
        'codex-agent',
        '--agent-kind',
        'codex',
        '--working-directory',
        'P:/luwi',
      ],
      dependencies,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    signalListener?.();
    await run;

    expect(bodies[0]).toMatchObject({
      native: { adapterId: 'codex', nativeSessionId: 'aliased-session' },
    });
  });

  it('declares no native block when the only Codex rollout is stale', async () => {
    // A dead session in the same directory must not be bound: absence over a wrong id.
    const bodies: unknown[] = [];
    let signalListener: (() => void) | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: { USERPROFILE: 'C:\\Users\\umuts' },
      platform: 'win32',
      now: () => new Date(CODEX_NOW),
      canonicalizePath: async (path: string) => path,
      transcriptFileSystem: rolloutFileSystem({
        'C:/Users/umuts/.codex/sessions/2026/09/01/rollout-old.jsonl': {
          content: codexRollout('dead-session', 'C:\\work'),
          modifiedAtMs: CODEX_NOW - 900_001,
        },
      }),
      fetch: async (_url, init) => {
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return response(registered);
      },
      setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
      clearInterval: (() => undefined) as never,
      signals: {
        once: (_signal: string, listener: () => void) => {
          signalListener = listener;
          return undefined;
        },
        off: () => undefined,
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    };

    const run = runCli(
      [
        'session',
        'attach',
        '--project',
        'project-1',
        '--agent',
        'codex-agent',
        '--agent-kind',
        'codex',
        '--working-directory',
        'C:/work',
      ],
      dependencies,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    signalListener?.();
    await run;

    expect(bodies[0]).toMatchObject({ projectId: 'project-1', agentId: 'codex-agent' });
    expect((bodies[0] as Record<string, unknown>)['native']).toBeUndefined();
  });

  it('attaches with no arguments: project from the working directory, kind from the identity present', async () => {
    const project = {
      id: 'project-1',
      name: 'Work',
      localPath: 'C:/work',
      canonicalPath: 'C:/work',
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z',
    };
    const attachWith = async (
      environment: Record<string, string>,
      transcriptFileSystem: CliDependencies['transcriptFileSystem'],
    ) => {
      const bodies: unknown[] = [];
      let signalListener: (() => void) | undefined;
      const run = runCli(['session', 'attach', '--working-directory', 'C:/work/app'], {
        environment,
        platform: 'win32',
        now: () => new Date(CODEX_NOW),
        canonicalizePath: async (path: string) => path,
        transcriptFileSystem,
        fetch: async (url, init) => {
          if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
          if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
          return response(registered);
        },
        setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
        clearInterval: (() => undefined) as never,
        signals: {
          once: (_signal: string, listener: () => void) => {
            signalListener = listener;
            return undefined;
          },
          off: () => undefined,
        },
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      signalListener?.();
      await run;
      return bodies[0];
    };

    // A Claude session: the environment names it, so the project comes from the
    // directory and the kind from the identity — nothing typed.
    expect(
      await attachWith(
        { CLAUDE_CODE_SESSION_ID: '64c3e219-18aa-4539-9104-89d3d2ac5629' },
        rolloutFileSystem({}),
      ),
    ).toMatchObject({
      projectId: 'project-1',
      agentId: 'claude-code',
      native: { adapterId: 'claude-code' },
    });

    // No environment identity, but a fresh Codex rollout for this directory:
    // the disk resolver names the kind.
    expect(
      await attachWith(
        { USERPROFILE: 'C:\\Users\\umuts' },
        rolloutFileSystem({
          'C:/Users/umuts/.codex/sessions/2026/09/01/rollout-x.jsonl': {
            content: codexRollout('01a0577b-9555-7741-b8f1-395df30a7003', 'C:\\work\\app'),
            modifiedAtMs: CODEX_NOW - 1_000,
          },
        }),
      ),
    ).toMatchObject({
      projectId: 'project-1',
      agentId: 'codex',
      native: { adapterId: 'codex', nativeSessionId: '01a0577b-9555-7741-b8f1-395df30a7003' },
    });
  });

  it('records --model as session metadata without inventing one otherwise', async () => {
    const bodies: unknown[] = [];
    let signalListener: (() => void) | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: { CLAUDE_CODE_SESSION_ID: '64c3e219-18aa-4539-9104-89d3d2ac5629' },
      canonicalizePath: async (path: string) => path,
      fetch: async (_url, init) => {
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return response(registered);
      },
      setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
      clearInterval: (() => undefined) as never,
      signals: {
        once: (_signal: string, listener: () => void) => {
          signalListener = listener;
          return undefined;
        },
        off: () => undefined,
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    };

    const run = runCli(
      [
        'session',
        'attach',
        '--project',
        'project-1',
        '--agent',
        'claude-code',
        '--model',
        'claude-opus-4-8',
      ],
      dependencies,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    signalListener?.();
    await run;

    expect(bodies[0]).toMatchObject({ metadata: { model: 'claude-opus-4-8' } });
  });

  it('prints what it would declare and exits under --dry-run', async () => {
    let output = '';
    let called = false;
    const dependencies: Partial<CliDependencies> = {
      environment: { CLAUDE_CODE_SESSION_ID: 'abc-123' },
      fetch: async () => {
        called = true;
        return response(registered);
      },
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(
      ['session', 'attach', '--project', 'project-1', '--agent', 'claude-code', '--dry-run'],
      dependencies,
    );

    expect(called).toBe(false);
    expect(JSON.parse(output)).toMatchObject({
      native: { adapterId: 'claude-code', nativeSessionId: 'abc-123' },
    });
  });
});

describe('agent run', () => {
  const timestamp = '2026-08-24T12:00:00.000Z';
  const project = {
    id: 'project-app',
    name: 'App',
    localPath: 'C:/work/app',
    canonicalPath: 'C:/work/app',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const agent = {
    id: 'codex-main',
    kind: 'codex',
    displayName: 'Codex',
    executable: 'C:/tools/codex.exe',
    enabled: true,
    adapterId: 'codex',
    nativeConfigRoots: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
  const binding = {
    id: 'binding-codex',
    projectId: project.id,
    agentId: agent.id,
    enabled: true,
    profileIds: [],
    capabilityBindingIds: [],
    overrides: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const session = {
    id: 'session-codex',
    projectId: project.id,
    agentId: agent.id,
    status: 'starting',
    workingDirectory: 'C:/work/app',
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
    metadata: {},
    presence: 'online',
  };

  it('passes native arguments and the initial LUWI session through inherited environment', async () => {
    const processRunner = { run: vi.fn(async () => ({ exitCode: 0 })) };
    const setExitCode = vi.fn();
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools', EXISTING: 'preserved' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: processRunner,
      setExitCode,
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      fetch: async (url, init) => {
        requests.push({
          url,
          method: init?.method,
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
        });
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [agent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [binding] });
        }
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(session, { status: 201 });
        }
        if (url.endsWith(`/api/v1/sessions/${session.id}/close`)) {
          return response({ ...session, status: 'completed', presence: 'offline' });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(
      ['agent', 'run', 'codex', '--working-directory', 'C:/work/app', '--', '--model', 'gpt-5'],
      dependencies,
    );

    expect(processRunner.run).toHaveBeenCalledWith({
      executable: 'C:/tools/codex.exe',
      args: ['--model', 'gpt-5'],
      workingDirectory: 'C:/work/app',
      environment: {
        PATH: 'C:/tools',
        EXISTING: 'preserved',
        LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
        LUWI_SESSION_ID: 'session-codex',
      },
      signals: dependencies.signals ?? expect.anything(),
      onDiagnostic: expect.any(Function),
    });
    expect(requests).toContainEqual({
      url: 'http://127.0.0.1:4782/api/v1/sessions',
      method: 'POST',
      body: {
        projectId: 'project-app',
        agentId: 'codex-main',
        workingDirectory: 'C:/work/app',
      },
    });
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it('launches the native agent in degraded mode when session registration is unavailable', async () => {
    const processRunner = { run: vi.fn(async () => ({ exitCode: 3 })) };
    const setExitCode = vi.fn();
    let diagnostics = '';
    const dependencies: Partial<CliDependencies> = {
      environment: {
        PATH: 'C:/tools',
        LUWI_DAEMON_URL: 'http://127.0.0.1:9999',
        LUWI_SESSION_ID: 'stale-parent-session',
      },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: processRunner,
      setExitCode,
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((callback) => {
        queueMicrotask(callback);
        return 2 as unknown as NodeJS.Timeout;
      }),
      clearTimeout: vi.fn(),
      stderr: { write: (text) => (diagnostics += text) },
      fetch: () => new Promise(() => undefined),
    };

    await runCli(
      [
        'agent',
        'run',
        'claude',
        '--project',
        'project-app',
        '--agent-id',
        'claude-main',
        '--',
        '--resume',
      ],
      dependencies,
    );

    expect(processRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: 'claude',
        args: ['--resume'],
        environment: {
          PATH: 'C:/tools',
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
        },
      }),
    );
    expect(diagnostics).toContain('LUWI_OBSERVATION_DEGRADED');
    expect(diagnostics).toContain('DAEMON_REQUEST_TIMEOUT');
    expect(setExitCode).toHaveBeenCalledWith(3);
  });

  it('reports recovered observation without claiming the running child environment changed', async () => {
    const intervalCallbacks: Array<() => void> = [];
    let finishProcess: ((result: { exitCode: number }) => void) | undefined;
    const processRunner = {
      run: vi.fn(
        () =>
          new Promise<{ exitCode: number }>((resolve) => {
            finishProcess = resolve;
          }),
      ),
    };
    let diagnostics = '';
    let registrations = 0;
    let heartbeatAttempted = false;
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: processRunner,
      setExitCode: vi.fn(),
      setInterval: vi.fn((callback) => {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length as unknown as NodeJS.Timeout;
      }),
      clearInterval: vi.fn(),
      stderr: { write: (text) => (diagnostics += text) },
      fetch: async (url, init) => {
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          registrations += 1;
          return response({
            ...session,
            id: `session-${registrations}`,
            agentId: 'codex-main',
          });
        }
        if (url.endsWith('/api/v1/sessions/session-1/heartbeat')) {
          heartbeatAttempted = true;
          return response(
            { error: { code: 'SESSION_TERMINAL', message: 'The session is terminal.' } },
            { ok: false, status: 409 },
          );
        }
        if (url.endsWith('/api/v1/sessions/session-2/close')) {
          return response({
            ...session,
            id: 'session-2',
            agentId: 'codex-main',
            status: 'completed',
            presence: 'offline',
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    const running = runCli(
      ['agent', 'run', 'codex', '--project', 'project-app', '--agent-id', 'codex-main'],
      dependencies,
    );
    await vi.waitFor(() => expect(processRunner.run).toHaveBeenCalledTimes(1));

    intervalCallbacks[0]?.();
    await vi.waitFor(() => expect(heartbeatAttempted).toBe(true));
    await vi.waitFor(() => expect(diagnostics).toContain('SESSION_TERMINAL'));
    intervalCallbacks[0]?.();
    await vi.waitFor(() => expect(registrations).toBe(2));

    expect(processRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({ LUWI_SESSION_ID: 'session-1' }),
      }),
    );
    await vi.waitFor(() => expect(diagnostics).toContain('LUWI_SESSION_RECOVERED'));

    finishProcess?.({ exitCode: 0 });
    await running;
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
