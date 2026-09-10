import { ApplicationError } from '@luwi/runtime';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { runCli, type CliDependencies, type CliWebSocket, type HttpResponseLike } from './cli.js';
import { DeepSeekBridgeStartupCancelledError, type DeepSeekAcpFactory } from './deepseek-bridge.js';
import type { LifecycleService } from './lifecycle.js';
import type { ProjectDiscoveryService } from './project-discovery.js';
import type { WakeLifecycleService } from './wake-lifecycle.js';

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
        autostart: 'disabled' as const,
        wakeAutostart: 'disabled' as const,
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
      wakeAutostart: false,
      noWakeAutostart: false,
    });
    (lifecycle.setup as ReturnType<typeof vi.fn>).mockClear();
    await runCli(['setup', '--yes', '--autostart'], dependencies);
    expect(lifecycle.setup).toHaveBeenCalledWith({
      approved: true,
      printHooks: false,
      autostart: true,
      noAutostart: false,
      wakeAutostart: false,
      noWakeAutostart: false,
    });
    (lifecycle.setup as ReturnType<typeof vi.fn>).mockClear();
    await runCli(['setup', '--yes', '--no-autostart'], dependencies);
    expect(lifecycle.setup).toHaveBeenCalledWith({
      approved: true,
      printHooks: false,
      autostart: false,
      noAutostart: true,
      wakeAutostart: false,
      noWakeAutostart: false,
    });
    (lifecycle.setup as ReturnType<typeof vi.fn>).mockClear();
    await runCli(['setup', '--yes', '--wake-autostart'], dependencies);
    expect(lifecycle.setup).toHaveBeenCalledWith({
      approved: true,
      printHooks: false,
      autostart: false,
      noAutostart: false,
      wakeAutostart: true,
      noWakeAutostart: false,
    });
    (lifecycle.setup as ReturnType<typeof vi.fn>).mockClear();
    await runCli(['setup', '--yes', '--no-wake-autostart'], dependencies);
    expect(lifecycle.setup).toHaveBeenCalledWith({
      approved: true,
      printHooks: false,
      autostart: false,
      noAutostart: false,
      wakeAutostart: false,
      noWakeAutostart: true,
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
      metadata: { harness: 'deepseek-acp', experimental: true },
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
      metadata: { harness: 'deepseek-acp', experimental: true },
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

function controlledDeadlineTimers() {
  let nextId = 0;
  const callbacks = new Map<NodeJS.Timeout, () => void>();
  return {
    callbacks,
    setTimeout: ((callback: () => void) => {
      const timer = ++nextId as unknown as NodeJS.Timeout;
      callbacks.set(timer, callback);
      return timer;
    }) as CliDependencies['setTimeout'],
    clearTimeout: ((timer: NodeJS.Timeout) => {
      callbacks.delete(timer);
    }) as CliDependencies['clearTimeout'],
    fireNext() {
      const next = callbacks.entries().next().value as [NodeJS.Timeout, () => void] | undefined;
      if (next === undefined) throw new Error('No request deadline is armed.');
      callbacks.delete(next[0]);
      next[1]();
    },
  };
}

function controlledCliSignals() {
  const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
  return {
    listeners,
    signals: {
      once(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
        listeners.set(signal, listener);
      },
      off(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    } satisfies CliDependencies['signals'],
  };
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
  const heldAttachLease = {
    id: 'lease-attach',
    projectId: 'project-1',
    sessionId: registered.id,
    agentId: registered.agentId,
    path: 'src',
    matchPath: 'src/',
    reason: 'active edit',
    state: 'held' as const,
    acquiredAt: '2026-08-17T12:00:00.000Z',
    expiresAt: '2026-08-17T12:05:00.000Z',
  };

  it.each(['99', '30001', 'not-an-integer'])(
    'rejects an unsafe attach request timeout of %s',
    async (value) => {
      await expect(
        runCli(
          [
            'session',
            'attach',
            '--project',
            'project-1',
            '--connect-timeout-ms',
            value,
            '--dry-run',
          ],
          {
            fetch: async () => {
              throw new Error('must not fetch');
            },
            stdout: { write: () => undefined },
            stderr: { write: () => undefined },
          },
        ),
      ).rejects.toMatchObject({
        code: 'CLI_OPTION_INVALID',
        message: expect.stringContaining('--connect-timeout-ms'),
      });
    },
  );

  it('installs stop handling before a bounded initial registration', async () => {
    const deadlines = controlledDeadlineTimers();
    const controlled = controlledCliSignals();
    const intervals: NodeJS.Timeout[] = [];
    const seenSignals: AbortSignal[] = [];
    let stderr = '';
    const run = runCli(
      [
        'session',
        'attach',
        '--project',
        'project-1',
        '--agent',
        'claude-code',
        '--connect-timeout-ms',
        '100',
      ],
      {
        environment: {},
        canonicalizePath: async (path) => path,
        fetch: (_url, init) => {
          if (init?.signal !== undefined) seenSignals.push(init.signal);
          return new Promise<HttpResponseLike>(() => undefined);
        },
        setInterval: ((callback: () => void) => {
          const timer = { callback } as unknown as NodeJS.Timeout;
          intervals.push(timer);
          return timer;
        }) as never,
        clearInterval: vi.fn(),
        setTimeout: deadlines.setTimeout,
        clearTimeout: deadlines.clearTimeout,
        signals: controlled.signals,
        stdout: { write: () => undefined },
        stderr: { write: (text) => void (stderr += text) },
      },
    );

    await vi.waitFor(() => expect(seenSignals).toHaveLength(1));
    expect(controlled.listeners.size).toBe(2);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);

    deadlines.fireNext();
    await vi.waitFor(() => expect(stderr).toContain('exceeded its bounded timeout'));
    controlled.listeners.get('SIGTERM')?.();

    await expect(run).resolves.toBeUndefined();
    expect(intervals).toHaveLength(2);
  });

  it('puts an AbortSignal on every attach-side daemon request', async () => {
    const project = {
      id: 'project-1',
      name: 'Work',
      localPath: 'C:/work',
      canonicalPath: 'C:/work',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
    };
    const requests: Array<{ url: string; signal?: AbortSignal }> = [];
    const intervals: Array<{ callback: () => void; intervalMs: number }> = [];
    const controlled = controlledCliSignals();
    const run = runCli(['session', 'attach', '--working-directory', 'C:/work/app'], {
      environment: {},
      platform: 'win32',
      canonicalizePath: async (path) => path,
      fetch: async (url, init) => {
        requests.push({ url, signal: init?.signal });
        if (url.endsWith('/api/v1/projects')) {
          return response({ projects: [project] });
        }
        if (url.endsWith('/api/v1/sessions')) {
          return response(registered, { status: 201 });
        }
        if (url.endsWith('/heartbeat')) {
          return response({ status: 'renewed', eventEmitted: false });
        }
        if (url.includes('/api/v1/leases?sessionId=')) {
          return response({ leases: [heldAttachLease], truncated: false });
        }
        if (url.endsWith('/api/v1/leases/lease-attach/renew')) {
          return response(heldAttachLease);
        }
        if (url.endsWith('/close')) {
          return response(registered);
        }
        throw new Error('Unexpected request: ' + url);
      },
      setInterval: ((callback: () => void, intervalMs: number) => {
        intervals.push({ callback, intervalMs });
        return intervals.length as unknown as NodeJS.Timeout;
      }) as never,
      clearInterval: vi.fn(),
      signals: controlled.signals,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    await vi.waitFor(() =>
      expect(requests.some(({ url }) => url.endsWith('/api/v1/sessions'))).toBe(true),
    );

    intervals.find(({ intervalMs }) => intervalMs === 5_000)?.callback();
    await vi.waitFor(() =>
      expect(requests.some(({ url }) => url.endsWith('/heartbeat'))).toBe(true),
    );

    intervals.find(({ intervalMs }) => intervalMs === 150_000)?.callback();
    await vi.waitFor(() =>
      expect(requests.some(({ url }) => url.endsWith('/api/v1/leases/lease-attach/renew'))).toBe(
        true,
      ),
    );

    controlled.listeners.get('SIGTERM')?.();
    await run;

    expect(requests.some(({ url }) => url.endsWith('/close'))).toBe(true);
    expect(requests).toHaveLength(6);
    for (const request of requests) {
      expect(request.signal, request.url).toBeInstanceOf(AbortSignal);
    }
  });

  it('clears local timers and exits when remote close times out', async () => {
    const deadlines = controlledDeadlineTimers();
    const controlled = controlledCliSignals();
    const order: string[] = [];
    let closeSignal: AbortSignal | undefined;
    let stderr = '';
    const run = runCli(
      [
        'session',
        'attach',
        '--project',
        'project-1',
        '--agent',
        'claude-code',
        '--connect-timeout-ms',
        '100',
      ],
      {
        environment: {},
        canonicalizePath: async (path) => path,
        fetch: (url, init) => {
          if (url.endsWith('/close')) {
            order.push('close');
            closeSignal = init?.signal;
            return new Promise<HttpResponseLike>(() => undefined);
          }
          return Promise.resolve(response(registered, { status: 201 }));
        },
        setInterval: vi.fn(() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout),
        clearInterval: vi.fn(() => void order.push('clear')),
        setTimeout: deadlines.setTimeout,
        clearTimeout: deadlines.clearTimeout,
        signals: controlled.signals,
        stdout: { write: () => undefined },
        stderr: { write: (text) => void (stderr += text) },
      },
    );

    await vi.waitFor(() => expect(controlled.listeners.size).toBe(2));
    controlled.listeners.get('SIGTERM')?.();
    await vi.waitFor(() => expect(closeSignal).toBeInstanceOf(AbortSignal));

    expect(order.slice(0, 3)).toEqual(['clear', 'clear', 'close']);
    deadlines.fireNext();

    await expect(run).resolves.toBeUndefined();
    expect(closeSignal?.aborted).toBe(true);
    expect(stderr).toContain('exceeded its bounded timeout');
  });

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

  it('publishes exact Codex launcher proof only after the daemon assigns the LUWI session', async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const probes: Array<{
      executable: string;
      args: readonly string[];
      environment: Readonly<Record<string, string | undefined>>;
    }> = [];
    let signalListener: (() => void) | undefined;
    const nativeSessionId = 'exact-codex-session';
    const measuredCodex = {
      id: 'codex-agent',
      kind: 'codex',
      displayName: 'Codex',
      executable: '/detected/codex',
      detectedVersion: 'codex-cli 1.2.3',
      enabled: true,
      adapterId: 'codex',
      nativeConfigRoots: [],
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
      metadata: {},
    };
    const nativeResponse = {
      outcome: 'created',
      binding: {
        id: 'native-binding-1',
        adapterId: 'codex-native-v1',
        nativeSessionId,
        kind: 'main',
        openLinkId: 'native-link-1',
        version: 1,
        linkCount: 1,
        trimmedLinkCount: 0,
        firstLinkedAt: '2026-08-17T12:00:00.000Z',
        lastLinkedAt: '2026-08-17T12:00:00.000Z',
      },
      link: {
        id: 'native-link-1',
        bindingId: 'native-binding-1',
        sessionId: registered.id,
        linkedAt: '2026-08-17T12:00:00.000Z',
      },
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
      {
        environment: {
          CODEX_SESSION_ID: nativeSessionId,
          CODEX_THREAD_ID: nativeSessionId,
          REDIS_URL: 'redis://private',
          LUWI_TEST_REDIS_URL: 'redis://test-private',
          LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS: 'true',
          USERPROFILE: 'C:\\Users\\umuts',
        },
        platform: 'win32',
        now: () => new Date(CODEX_NOW),
        canonicalizePath: async (path) =>
          path === measuredCodex.executable ? '/canonical/codex' : path,
        agentProcessRunner: {
          run: vi.fn(async (input) => {
            probes.push(input);
            input.captureOutput?.(
              input.args[0] === '--version'
                ? `${measuredCodex.detectedVersion}\n`
                : 'Usage: codex queue --thread <THREAD> --message <TEXT>\n',
            );
            return { exitCode: 0 };
          }),
        },
        transcriptFileSystem: rolloutFileSystem({
          'C:/Users/umuts/.codex/sessions/2026/09/01/rollout-exact.jsonl': {
            content: codexRollout(nativeSessionId, 'C:\\work'),
            modifiedAtMs: CODEX_NOW - 1_000,
          },
        }),
        fetch: async (url, init) => {
          requests.push({
            url,
            ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
          });
          if (url.endsWith('/api/v1/agents')) {
            return response({
              agents: [
                measuredCodex,
                {
                  ...measuredCodex,
                  id: 'other-codex-agent',
                  executable: '/detected/other-codex',
                  detectedVersion: 'codex-cli 9.9.9',
                },
              ],
            });
          }
          if (url.endsWith(`/api/v1/sessions/${registered.id}/native`)) {
            return response(nativeResponse);
          }
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
      },
    );

    await vi.waitFor(() =>
      expect(requests.some(({ url }) => url.endsWith(`/${registered.id}/native`))).toBe(true),
    );

    const registration = requests.find(({ url }) => url.endsWith('/api/v1/sessions'));
    expect(registration).toMatchObject({
      url: expect.stringMatching(/\/api\/v1\/sessions$/u),
      body: { projectId: 'project-1', agentId: 'codex-agent', workingDirectory: 'C:/work' },
    });
    expect(registration?.body).not.toHaveProperty('native');
    expect(registration?.body).not.toHaveProperty('nativeIdentityProvenance');
    expect(registration?.body).not.toHaveProperty('hostWake');
    expect(requests.find(({ url }) => url.endsWith(`/${registered.id}/native`))).toEqual({
      url: `http://127.0.0.1:4782/api/v1/sessions/${registered.id}/native`,
      body: {
        native: { adapterId: 'codex-native-v1', nativeSessionId },
        identityProvenance: { source: 'host_launcher', launcherInstanceId: nativeSessionId },
        hostWake: { adapter: 'codex-queue-v1', mcpSessionId: registered.id },
      },
    });
    expect(requests.filter(({ url }) => url.endsWith('/api/v1/agents'))).toHaveLength(2);
    expect(probes.map(({ executable, args }) => ({ executable, args }))).toEqual([
      { executable: '/canonical/codex', args: ['--version'] },
      { executable: '/canonical/codex', args: ['queue', '--help'] },
    ]);
    for (const probe of probes) {
      expect(probe.environment).not.toHaveProperty('REDIS_URL');
      expect(probe.environment).not.toHaveProperty('LUWI_TEST_REDIS_URL');
      expect(probe.environment).not.toHaveProperty('LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS');
    }

    signalListener?.();
    await run;
  });

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
      native: {
        adapterId: 'codex-native-v1',
        nativeSessionId: '01a05c7d-d90a-7a62-8856-ebd3bf43f1c7',
      },
    });
  });

  it('fails closed without a native declaration when Codex launcher proof is incomplete', async () => {
    // Automatic Codex wake requires both launcher ids plus exact rollout proof.
    // One environment id alone must not fall back to a heuristic disk identity.
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

    expect((bodies[0] as Record<string, unknown>)['native']).toBeUndefined();
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
      native: { adapterId: 'codex-native-v1', nativeSessionId: 'aliased-session' },
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
      native: {
        adapterId: 'codex-native-v1',
        nativeSessionId: '01a0577b-9555-7741-b8f1-395df30a7003',
      },
    });
  });

  it('declares an explicit native reference outright and resolves nothing on its behalf', async () => {
    const project = {
      id: 'project-1',
      name: 'Work',
      localPath: 'C:/work',
      canonicalPath: 'C:/work',
      createdAt: '2026-07-28T12:00:00.000Z',
      updatedAt: '2026-07-28T12:00:00.000Z',
    };
    const printed: string[] = [];
    await runCli(
      [
        'session',
        'attach',
        '--working-directory',
        'C:/work/app',
        '--agent',
        'antigravity',
        '--native-adapter',
        'antigravity',
        '--native-session',
        'ec33ebf9-0cba-4100-8142-c61503f6c587',
        '--dry-run',
      ],
      {
        // A Claude identity is present in the environment and must not win.
        environment: { CLAUDE_CODE_SESSION_ID: '64c3e219-18aa-4539-9104-89d3d2ac5629' },
        platform: 'win32',
        canonicalizePath: async (path: string) => path,
        fetch: async (url) => {
          if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
          throw new Error(`unexpected request ${url}`);
        },
        stdout: { write: (chunk: string) => void printed.push(chunk) },
        stderr: { write: () => undefined },
      },
    );

    expect(JSON.parse(printed.join(''))).toMatchObject({
      projectId: 'project-1',
      agentId: 'antigravity',
      native: { adapterId: 'antigravity', nativeSessionId: 'ec33ebf9-0cba-4100-8142-c61503f6c587' },
    });

    // Half a reference is refused before any request leaves the process.
    await expect(
      runCli(['session', 'attach', '--native-adapter', 'antigravity', '--dry-run'], {
        canonicalizePath: async (path: string) => path,
        fetch: async () => {
          throw new Error('must not be called');
        },
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      }),
    ).rejects.toMatchObject({ code: 'CLI_OPTION_INVALID' });
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

describe('session bridge native', () => {
  const timestamp = '2026-09-08T00:00:00.000Z';
  const project = {
    id: 'project-app',
    name: 'App',
    localPath: 'C:/work/app',
    canonicalPath: 'C:/work/app',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const agent = {
    id: 'claude-code',
    kind: 'claude-code',
    displayName: 'Claude Code',
    executable: 'C:/tools/claude.exe',
    enabled: true,
    adapterId: 'claude-code',
    nativeConfigRoots: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
  const binding = {
    id: 'binding-claude',
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
    id: 'session-1',
    projectId: project.id,
    agentId: agent.id,
    status: 'starting',
    workingDirectory: 'C:/work/app',
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
    metadata: { bridge: 'native-headless', provider: 'claude' },
    presence: 'online',
  };
  const slotId = 'a'.repeat(64);
  const slot = {
    id: slotId,
    workspaceId: 'local',
    projectId: project.id,
    agentId: agent.id,
    provider: 'claude-code',
    executionProfile: 'workspace-write',
    state: 'active',
    revision: 1,
    expiresAt: '2026-09-08T00:00:15.000Z',
  };
  /** The slot routes every bridge talks to before and after its session. */
  const slotRoutes = (url: string, init?: { method?: string }) => {
    if (url.endsWith('/api/v1/bridge-slots/acquire') && init?.method === 'POST') {
      return response({ status: 'acquired', slot }, { status: 201 });
    }
    if (url.endsWith(`/api/v1/bridge-slots/${slotId}/renew`)) {
      return response({ status: 'renewed', slot });
    }
    if (url.endsWith(`/api/v1/bridge-slots/${slotId}/release`)) {
      return response({ status: 'released', slot: { ...slot, state: 'standby' } });
    }
    return undefined;
  };
  const message = (state: string) => ({
    id: 'message-1',
    correlationId: 'correlation-1',
    projectId: project.id,
    sourceSessionId: 'source-1',
    sourceAgentId: 'codex',
    targetSessionId: session.id,
    targetAgentId: agent.id,
    selectionReason: 'direct target session session-1',
    kind: 'instruction',
    subject: 'ALB-1',
    content: 'Inspect and report.',
    evidenceRequirements: [],
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
    deadlineAt: '2026-09-08T02:00:00.000Z',
  });
  const requestItem = {
    streamId: '1-0',
    itemKind: 'request',
    messageId: 'message-1',
    correlationId: 'correlation-1',
    sourceSessionId: 'source-1',
    targetSessionId: session.id,
    createdAt: timestamp,
    payload: {
      kind: 'instruction',
      subject: 'ALB-1',
      content: 'Inspect and report.',
      evidenceRequirements: [],
      deadlineAt: '2026-09-08T02:00:00.000Z',
    },
  };

  it('registers, claims, runs the native CLI headless, and closes on signal', async () => {
    const signalSource = new EventEmitter();
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    let getMessageCalls = 0;
    let claims = 0;
    let recorded: unknown;
    const processRunner = {
      run: vi.fn(async (input: unknown) => {
        recorded = input;
        signalSource.emit('SIGINT');
        return { exitCode: 0 };
      }),
    };
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: processRunner as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          signalSource.once(signal, listener);
        },
        off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          signalSource.off(signal, listener);
        },
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2 as unknown as NodeJS.Timeout) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      wait: async () => undefined,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
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
        const slotResponse = slotRoutes(url, init);
        if (slotResponse !== undefined) return slotResponse;
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(session, { status: 201 });
        }
        if (url.includes('/inbox/claim')) {
          claims += 1;
          return response({ items: claims === 1 ? [requestItem] : [] });
        }
        if (url.includes('/status')) return response(session);
        if (url.includes('/heartbeat')) return response({ acknowledgedAt: timestamp });
        if (url.includes('/close')) {
          return response({ ...session, status: 'completed', presence: 'offline' });
        }
        if (url.includes('/leases')) return response({ leases: [], truncated: false });
        if (url.endsWith('/api/v1/messages/correlation-1/acknowledge')) {
          return response(message('acknowledged'));
        }
        if (url.endsWith('/api/v1/messages/correlation-1/processing')) {
          return response(message('processing'));
        }
        if (url.endsWith('/api/v1/messages/correlation-1')) {
          getMessageCalls += 1;
          return response(message(getMessageCalls === 1 ? 'delivered' : 'responded'));
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(
      [
        'session',
        'bridge',
        'native',
        'claude',
        '--working-directory',
        'C:/work/app',
        '--',
        '--allowedTools',
        'mcp__luwi-runtime',
      ],
      dependencies,
    );

    const runInput = recorded as {
      executable: string;
      args: string[];
      environment: Record<string, string>;
    };
    expect(runInput.executable).toBe('C:/tools/claude.exe');
    expect(runInput.args[0]).toBe('--print');
    expect(runInput.args.slice(-2)).toEqual(['--allowedTools', 'mcp__luwi-runtime']);
    expect(runInput.environment.LUWI_SESSION_ID).toBe('session-1');
    expect(runInput.environment.LUWI_DAEMON_URL).toBe('http://127.0.0.1:4782');

    // The slot is owned before the session exists, declared on registration so
    // the daemon writes the reserved bridge metadata itself, and released after
    // the session is closed.
    const acquireIndex = requests.findIndex((entry) =>
      entry.url.endsWith('/api/v1/bridge-slots/acquire'),
    );
    const registerIndex = requests.findIndex(
      (entry) => entry.url.endsWith('/api/v1/sessions') && entry.method === 'POST',
    );
    expect(acquireIndex).toBeGreaterThanOrEqual(0);
    expect(acquireIndex).toBeLessThan(registerIndex);
    const acquire = requests[acquireIndex]!.body as Record<string, unknown>;
    expect(acquire).toMatchObject({
      projectId: 'project-app',
      agentId: 'claude-code',
      provider: 'claude-code',
      executionProfile: 'workspace-write',
    });
    expect(typeof acquire['ownerToken']).toBe('string');
    const register = requests[registerIndex];
    expect(register?.body).toMatchObject({
      projectId: 'project-app',
      agentId: 'claude-code',
      bridgeOwner: {
        slotId,
        ownerToken: acquire['ownerToken'],
        provider: 'claude-code',
        executionProfile: 'workspace-write',
      },
    });
    expect(register?.body).not.toHaveProperty('metadata.bridge');
    const closeIndex = requests.findIndex((entry) => entry.url.includes('/close'));
    const releaseIndex = requests.findIndex((entry) =>
      entry.url.endsWith(`/api/v1/bridge-slots/${slotId}/release`),
    );
    expect(releaseIndex).toBeGreaterThan(closeIndex);
    const claim = requests.find((entry) => entry.url.includes('/inbox/claim'));
    expect(claim?.body).toMatchObject({
      bridgeInstanceId: 'native-bridge',
      limit: 1,
      blockMs: 30_000,
    });
    expect(requests.some((entry) => entry.url.includes('/close'))).toBe(true);
    expect(
      requests.some((entry) => entry.url.endsWith('/respond') || entry.url.endsWith('/fail')),
    ).toBe(false);
  });

  it('bounds a stalled non-claim daemon read during bridge shutdown', async () => {
    const signalSource = new EventEmitter();
    let getMessageStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      getMessageStarted = resolve;
    });
    let claims = 0;
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async () => ({ exitCode: 0 })),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          signalSource.once(signal, listener);
        },
        off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          signalSource.off(signal, listener);
        },
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch: async (url, init) => {
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [agent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [binding] });
        }
        const slotResponse = slotRoutes(url, init);
        if (slotResponse !== undefined) return slotResponse;
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(session, { status: 201 });
        }
        if (url.includes('/inbox/claim')) {
          claims += 1;
          return response({ items: claims === 1 ? [requestItem] : [] });
        }
        if (url.includes('/status')) return response(session);
        if (url.includes('/heartbeat')) return response({ acknowledgedAt: timestamp });
        if (url.includes('/close')) {
          return response({ ...session, status: 'completed', presence: 'offline' });
        }
        if (url.includes('/leases')) return response({ leases: [], truncated: false });
        if (url.endsWith('/api/v1/messages/correlation-1')) {
          getMessageStarted();
          return await new Promise(() => undefined);
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    const operation = runCli(
      [
        'session',
        'bridge',
        'native',
        'claude',
        '--working-directory',
        'C:/work/app',
        '--connect-timeout-ms',
        '100',
      ],
      dependencies,
    );
    await started;
    signalSource.emit('SIGINT');

    const outcome = await Promise.race([
      operation.then(
        () => 'resolved',
        (error: unknown) => (error as { code?: string }).code ?? 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('test_timeout'), 750)),
    ]);
    expect(outcome).toBe('DAEMON_REQUEST_TIMEOUT');
  });

  it('keeps a blocking claim bounded while preserving cooperative shutdown', async () => {
    const signalSource = new EventEmitter();
    const timeoutBudgets: number[] = [];
    let claimSignal: AbortSignal | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async () => ({ exitCode: 0 })),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          signalSource.once(signal, listener);
        },
        off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
          signalSource.off(signal, listener);
        },
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      setTimeout: vi.fn((_callback: () => void, milliseconds: number) => {
        timeoutBudgets.push(milliseconds);
        return timeoutBudgets.length as unknown as NodeJS.Timeout;
      }) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      wait: async () => undefined,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch: async (url, init) => {
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [agent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [binding] });
        }
        const slotResponse = slotRoutes(url, init);
        if (slotResponse !== undefined) return slotResponse;
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(session, { status: 201 });
        }
        if (url.includes('/inbox/claim')) {
          claimSignal = init?.signal;
          queueMicrotask(() => signalSource.emit('SIGINT'));
          return await new Promise<HttpResponseLike>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        }
        if (url.includes('/status')) return response(session);
        if (url.includes('/heartbeat')) return response({ acknowledgedAt: timestamp });
        if (url.includes('/close')) {
          return response({ ...session, status: 'completed', presence: 'offline' });
        }
        if (url.includes('/leases')) return response({ leases: [], truncated: false });
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(
      [
        'session',
        'bridge',
        'native',
        'claude',
        '--working-directory',
        'C:/work/app',
        '--block-ms',
        '1000',
        '--connect-timeout-ms',
        '100',
      ],
      dependencies,
    );

    expect(claimSignal?.aborted).toBe(true);
    expect(timeoutBudgets).toContain(1_100);
  });

  it('injects the LUWI MCP session binding and auto-approval into a codex child', async () => {
    const codexAgent = { ...agent, id: 'codex', kind: 'codex', adapterId: 'codex' };
    const codexBinding = { ...binding, id: 'binding-codex', agentId: 'codex' };
    const codexSession = { ...session, id: 'codex-session-1', agentId: 'codex' };
    const signalSource = new EventEmitter();
    let recorded: { args: string[] } | undefined;
    let claims = 0;
    let getMessageCalls = 0;
    const managedProcess = {
      state: 'running' as const,
      managed: true,
      ownership: 'owned' as const,
      pid: 4242,
      instanceId: 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b',
      startedAt: timestamp,
      heartbeatAt: timestamp,
    };
    const dependencies: Partial<CliDependencies> = {
      environment: {
        PATH: 'C:/tools',
        LUWI_WAKE_CONTROL_TOKEN: '6ccfd2c0-e424-4a21-91db-30dc72092a01',
        LUWI_WAKE_INSTANCE_ID: managedProcess.instanceId,
      },
      wakeLifecycle: {
        start: vi.fn(async () => managedProcess),
        stop: vi.fn(async () => ({
          state: 'stopped' as const,
          managed: false,
          ownership: 'none' as const,
        })),
        status: vi.fn(async () => managedProcess),
        beginManagedServe: vi.fn(async () => ({
          stopRequested: new Promise<void>(() => undefined),
          close: vi.fn(async () => undefined),
        })),
      },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async (input: unknown) => {
          recorded = input as { args: string[] };
          signalSource.emit('SIGINT');
          return { exitCode: 0 };
        }),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.once(s, l),
        off: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.off(s, l),
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2 as unknown as NodeJS.Timeout) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      wait: async () => undefined,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch: async (url, init) => {
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [codexAgent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [codexBinding] });
        }
        const slotResponse = slotRoutes(url, init);
        if (slotResponse !== undefined) return slotResponse;
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(codexSession, { status: 201 });
        }
        if (url.includes('/inbox/claim')) {
          claims += 1;
          return response({
            items: claims === 1 ? [{ ...requestItem, targetSessionId: 'codex-session-1' }] : [],
          });
        }
        if (url.includes('/status')) return response(codexSession);
        if (url.includes('/heartbeat')) return response({ acknowledgedAt: timestamp });
        if (url.includes('/close'))
          return response({ ...codexSession, status: 'completed', presence: 'offline' });
        if (url.includes('/leases')) return response({ leases: [], truncated: false });
        if (url.endsWith('/acknowledge')) return response(message('acknowledged'));
        if (url.endsWith('/processing')) return response(message('processing'));
        if (url.endsWith('/api/v1/messages/correlation-1')) {
          getMessageCalls += 1;
          return response(message(getMessageCalls === 1 ? 'delivered' : 'responded'));
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(
      [
        'session',
        'bridge',
        'native',
        'codex',
        '--working-directory',
        'C:/work/app',
        '--',
        '--sandbox',
        'read-only',
      ],
      dependencies,
    );

    const args = recorded?.args ?? [];
    expect(args[0]).toBe('exec');
    expect(args).toContain('--approve-for-me');
    expect(args).toContain('mcp_servers.luwi-runtime.env.LUWI_SESSION_ID="codex-session-1"');
    expect(args.slice(-3)).toEqual([
      '--sandbox',
      'read-only',
      expect.stringContaining('LUWI message'),
    ]);
  });

  it('runs an antigravity child headless and binds the session through inherited env', async () => {
    const agyAgent = { ...agent, id: 'antigravity', kind: 'other', adapterId: 'antigravity' };
    const agyBinding = { ...binding, id: 'binding-agy', agentId: 'antigravity' };
    const agySession = { ...session, id: 'agy-session-1', agentId: 'antigravity' };
    const signalSource = new EventEmitter();
    let recorded: { args: string[]; environment: Record<string, string> } | undefined;
    let claims = 0;
    let getMessageCalls = 0;
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async (input: unknown) => {
          recorded = input as { args: string[]; environment: Record<string, string> };
          signalSource.emit('SIGINT');
          return { exitCode: 0 };
        }),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.once(s, l),
        off: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.off(s, l),
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2 as unknown as NodeJS.Timeout) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      wait: async () => undefined,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch: async (url, init) => {
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [agyAgent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [agyBinding] });
        }
        const slotResponse = slotRoutes(url, init);
        if (slotResponse !== undefined) return slotResponse;
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(agySession, { status: 201 });
        }
        if (url.includes('/inbox/claim')) {
          claims += 1;
          return response({
            items: claims === 1 ? [{ ...requestItem, targetSessionId: 'agy-session-1' }] : [],
          });
        }
        if (url.includes('/status')) return response(agySession);
        if (url.includes('/heartbeat')) return response({ acknowledgedAt: timestamp });
        if (url.includes('/close'))
          return response({ ...agySession, status: 'completed', presence: 'offline' });
        if (url.includes('/leases')) return response({ leases: [], truncated: false });
        if (url.endsWith('/acknowledge')) return response(message('acknowledged'));
        if (url.endsWith('/processing')) return response(message('processing'));
        if (url.endsWith('/api/v1/messages/correlation-1')) {
          getMessageCalls += 1;
          return response(message(getMessageCalls === 1 ? 'delivered' : 'responded'));
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(
      [
        'session',
        'bridge',
        'native',
        'antigravity',
        '--working-directory',
        'C:/work/app',
        '--',
        '--dangerously-skip-permissions',
      ],
      dependencies,
    );

    const args = recorded?.args ?? [];
    expect(args[0]).toBe('--print');
    expect(args[1]).toContain('LUWI message');
    expect(args).toContain('--dangerously-skip-permissions');
    // Antigravity binds through the inherited env like claude — no codex-style -c injection.
    expect(args.some((a) => a.includes('mcp_servers.luwi-runtime'))).toBe(false);
    expect(recorded?.environment.LUWI_SESSION_ID).toBe('agy-session-1');
  });

  /**
   * One bridge per project and agent. A held slot is refused before any
   * session exists, so a second operator start cannot become a second target.
   */
  it('stands down without registering when another bridge owns the slot', async () => {
    const requests: string[] = [];
    let acquireBody: Record<string, unknown> | undefined;
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      signals: {
        once: () => undefined,
        off: () => undefined,
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2 as unknown as NodeJS.Timeout) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      wait: async () => undefined,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch: async (url, init) => {
        requests.push(url);
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [agent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [binding] });
        }
        if (url.endsWith('/api/v1/bridge-slots/acquire')) {
          acquireBody = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
          return response({ status: 'held', slot: { ...slot, executionProfile: 'read-only' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await expect(
      runCli(
        [
          'session',
          'bridge',
          'native',
          'claude',
          '--working-directory',
          'C:/work/app',
          '--execution-profile',
          'read-only',
        ],
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'BRIDGE_SLOT_HELD' });

    expect(acquireBody).toMatchObject({ executionProfile: 'read-only' });
    expect(requests.some((url) => url.endsWith('/api/v1/sessions'))).toBe(false);
  });

  /**
   * A refused renewal means another owner took the tuple. The bridge stops
   * claiming, closes its session, and exits with the loss named — it never
   * keeps serving an inbox it no longer owns.
   */
  it('stops serving and closes its session when slot ownership is lost', async () => {
    const signalSource = new EventEmitter();
    const timers: Array<() => void> = [];
    const requests: string[] = [];
    let claims = 0;
    const dependencies: Partial<CliDependencies> = {
      environment: { PATH: 'C:/tools' },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async () => ({ exitCode: 0 })),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.once(s, l),
        off: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.off(s, l),
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn((callback: () => void) => {
        timers.push(callback);
        return timers.length as unknown as NodeJS.Timeout;
      }) as CliDependencies['setInterval'],
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2 as unknown as NodeJS.Timeout) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      wait: async () => undefined,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch: async (url, init) => {
        requests.push(url);
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [agent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [binding] });
        }
        if (url.endsWith(`/api/v1/bridge-slots/${slotId}/renew`)) {
          return response(
            { error: { code: 'BRIDGE_SLOT_NOT_OWNER', message: 'Another owner holds it.' } },
            { ok: false, status: 409 },
          );
        }
        const slotResponse = slotRoutes(url, init);
        if (slotResponse !== undefined) return slotResponse;
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(session, { status: 201 });
        }
        if (url.includes('/inbox/claim')) {
          claims += 1;
          // The renewal tick fires while the bridge is idle between claims.
          if (claims === 1) {
            for (const tick of timers) tick();
            await new Promise((resolve) => setImmediate(resolve));
          }
          // Safety valve: a bridge that ignores the loss must still end the test.
          if (claims === 3) signalSource.emit('SIGINT');
          return response({ items: [] });
        }
        if (url.includes('/status')) return response(session);
        if (url.includes('/heartbeat')) return response({ acknowledgedAt: timestamp });
        if (url.includes('/close')) {
          return response({ ...session, status: 'completed', presence: 'offline' });
        }
        if (url.includes('/leases')) return response({ leases: [], truncated: false });
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await expect(
      runCli(
        ['session', 'bridge', 'native', 'claude', '--working-directory', 'C:/work/app'],
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'BRIDGE_SLOT_LOST' });

    expect(requests.filter((url) => url.includes('/inbox/claim')).length).toBeLessThanOrEqual(2);
    expect(requests.some((url) => url.includes('/close'))).toBe(true);
    // Nothing is released: the token is already dead, and a release would be refused.
    expect(requests.some((url) => url.endsWith('/release'))).toBe(false);
  });
});

describe('wake lifecycle commands', () => {
  const running = {
    state: 'running' as const,
    managed: true,
    ownership: 'owned' as const,
    pid: 4242,
    instanceId: 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b',
    startedAt: '2026-09-10T08:00:00.000Z',
    heartbeatAt: '2026-09-10T08:00:01.000Z',
  };
  const stopped = {
    state: 'stopped' as const,
    managed: false,
    ownership: 'none' as const,
  };

  it('runs the real durable recover and blocking claim loop under wake serve', async () => {
    const signalSource = new EventEmitter();
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    let claimCount = 0;

    await runCli(['wake', 'serve'], {
      environment: {},
      signals: {
        once: (signal, listener) => signalSource.once(signal, listener),
        off: (signal, listener) => signalSource.off(signal, listener),
      },
      fetch: async (url, init) => {
        requests.push({
          url,
          method: init?.method,
          ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }),
        });
        if (url.endsWith('/api/v1/projects')) return response({ projects: [] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [] });
        if (url.endsWith('/api/v1/wake-intents/recover')) {
          return response({ items: [], recoveredDispatching: [], terminalAcknowledged: 0 });
        }
        if (url.endsWith('/api/v1/wake-intents/claim')) {
          claimCount += 1;
          queueMicrotask(() => signalSource.emit('SIGINT'));
          return response({ items: [], recoveredDispatching: [], terminalAcknowledged: 0 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    const recover = requests.find(({ url }) => url.endsWith('/api/v1/wake-intents/recover'));
    const claim = requests.find(({ url }) => url.endsWith('/api/v1/wake-intents/claim'));
    expect(recover).toMatchObject({ method: 'POST' });
    expect(claim).toMatchObject({ method: 'POST' });
    expect(recover?.body).toMatchObject({ limit: 1, minIdleMs: 15_000 });
    expect(claim?.body).toMatchObject({ limit: 1, blockMs: 5_000, minIdleMs: 15_000 });
    expect((recover?.body as Record<string, unknown>)['dispatcherInstanceId']).toBe(
      (claim?.body as Record<string, unknown>)['dispatcherInstanceId'],
    );
    expect(claimCount).toBe(1);
  });

  it('resolves each queued Codex wake through its exact source session agent', async () => {
    const signalSource = new EventEmitter();
    const timestamp = '2026-09-10T08:00:00.000Z';
    const sourceSession = {
      id: 'source-session-1',
      agentId: 'codex-source',
      projectId: 'project-1',
      status: 'idle',
      workingDirectory: 'C:/work',
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      metadata: {},
      presence: 'online',
      wakeCapable: true,
    };
    const intent = {
      id: 'wake-1',
      messageId: 'message-1',
      workflowId: 'workflow-1',
      sourceSessionId: sourceSession.id,
      correlationId: 'correlation-1',
      terminalState: 'responded',
      adapter: 'codex-queue-v1',
      state: 'claimed',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const agent = (id: string, executable: string) => ({
      id,
      kind: 'codex',
      displayName: id,
      executable,
      detectedVersion: 'codex-cli 1.2.3',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: {},
    });
    const probes: string[] = [];
    const requests: Array<{ url: string; body?: unknown }> = [];
    let claimCount = 0;

    await runCli(['wake', 'serve'], {
      environment: {},
      cwd: () => 'C:/runtime',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async ({ executable }: { executable: string }) => {
          probes.push(executable);
          return { exitCode: 1 };
        }),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (signal, listener) => signalSource.once(signal, listener),
        off: (signal, listener) => signalSource.off(signal, listener),
      },
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }),
        });
        if (url.endsWith('/api/v1/projects')) return response({ projects: [] });
        if (url.endsWith('/api/v1/agents')) {
          return response({
            agents: [
              agent('codex-other', 'C:/tools/other-codex.exe'),
              agent(sourceSession.agentId, 'C:/tools/source-codex.exe'),
            ],
          });
        }
        if (url.endsWith(`/api/v1/sessions/${sourceSession.id}`)) {
          return response(sourceSession);
        }
        if (url.endsWith('/api/v1/wake-intents/recover')) {
          return response({ items: [], recoveredDispatching: [], terminalAcknowledged: 0 });
        }
        if (url.endsWith('/api/v1/wake-intents/claim')) {
          claimCount += 1;
          return response({
            items:
              claimCount === 1
                ? [
                    {
                      intent,
                      claimId: 'claim-1',
                      target: {
                        adapter: 'codex-queue-v1',
                        nativeSessionId: 'native-session-1',
                      },
                    },
                  ]
                : [],
            recoveredDispatching: [],
            terminalAcknowledged: 0,
          });
        }
        if (url.endsWith('/api/v1/wake-intents/wake-1/complete')) {
          queueMicrotask(() => signalSource.emit('SIGINT'));
          return response({
            status: 'updated',
            intent: {
              ...intent,
              state: 'fallback_only',
              reasonCode: 'queue_capability_unavailable',
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    expect(probes).toEqual(['C:/tools/source-codex.exe']);
    expect(
      requests.find(({ url }) => url.endsWith('/api/v1/wake-intents/wake-1/complete'))?.body,
    ).toMatchObject({
      state: 'fallback_only',
      reasonCode: 'queue_capability_unavailable',
    });
  });

  it('cancels a pending executable canonicalization when wake serve stops', async () => {
    const signalSource = new EventEmitter();
    const timestamp = '2026-09-10T08:00:00.000Z';
    const sourceSession = {
      id: 'source-session-canonicalize',
      agentId: 'codex-source',
      projectId: 'project-1',
      status: 'idle',
      workingDirectory: 'C:/work',
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      metadata: {},
      presence: 'online',
      wakeCapable: true,
    };
    const intent = {
      id: 'wake-canonicalize',
      messageId: 'message-canonicalize',
      workflowId: 'workflow-canonicalize',
      sourceSessionId: sourceSession.id,
      correlationId: 'correlation-canonicalize',
      terminalState: 'responded',
      adapter: 'codex-queue-v1',
      state: 'claimed',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let claimCount = 0;
    let canonicalizationStarted = false;

    const serving = runCli(['wake', 'serve'], {
      environment: {},
      cwd: () => 'C:/runtime',
      canonicalizePath: async () => {
        canonicalizationStarted = true;
        queueMicrotask(() => signalSource.emit('SIGINT'));
        return await new Promise<string>(() => undefined);
      },
      signals: {
        once: (signal, listener) => signalSource.once(signal, listener),
        off: (signal, listener) => signalSource.off(signal, listener),
      },
      fetch: async (url) => {
        if (url.endsWith('/api/v1/projects')) return response({ projects: [] });
        if (url.endsWith('/api/v1/agents')) {
          return response({
            agents: [
              {
                id: sourceSession.agentId,
                kind: 'codex',
                displayName: 'Codex source',
                executable: 'C:/tools/codex.exe',
                detectedVersion: 'codex-cli 1.2.3',
                enabled: true,
                adapterId: 'codex-native-v1',
                nativeConfigRoots: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                metadata: {},
              },
            ],
          });
        }
        if (url.endsWith(`/api/v1/sessions/${sourceSession.id}`)) return response(sourceSession);
        if (url.endsWith('/api/v1/wake-intents/recover')) {
          return response({ items: [], recoveredDispatching: [], terminalAcknowledged: 0 });
        }
        if (url.endsWith('/api/v1/wake-intents/claim')) {
          claimCount += 1;
          return response({
            items:
              claimCount === 1
                ? [
                    {
                      intent,
                      claimId: 'claim-canonicalize',
                      target: {
                        adapter: 'codex-queue-v1',
                        nativeSessionId: 'native-session-canonicalize',
                      },
                    },
                  ]
                : [],
            recoveredDispatching: [],
            terminalAcknowledged: 0,
          });
        }
        if (url.endsWith('/api/v1/wake-intents/wake-canonicalize/complete')) {
          return response({
            status: 'updated',
            intent: {
              ...intent,
              state: 'fallback_only',
              reasonCode: 'dispatcher_stopped_before_spawn',
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    await expect(
      Promise.race([
        serving,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('wake serve did not stop')), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(canonicalizationStarted).toBe(true);
  });

  it('refuses a source session that goes offline after the dispatch fence', async () => {
    const signalSource = new EventEmitter();
    const timestamp = '2026-09-10T08:00:00.000Z';
    const sourceSession = {
      id: 'source-session-liveness',
      agentId: 'codex-source',
      projectId: 'project-1',
      status: 'idle',
      workingDirectory: 'C:/work',
      startedAt: timestamp,
      lastHeartbeatAt: timestamp,
      metadata: {},
      presence: 'online',
      wakeCapable: true,
    };
    const intent = {
      id: 'wake-liveness',
      messageId: 'message-liveness',
      workflowId: 'workflow-liveness',
      sourceSessionId: sourceSession.id,
      correlationId: 'correlation-liveness',
      terminalState: 'responded',
      adapter: 'codex-queue-v1',
      state: 'claimed',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let claimCount = 0;
    let sourceReads = 0;
    const requests: Array<{ url: string; body?: unknown }> = [];

    await runCli(['wake', 'serve'], {
      environment: {},
      cwd: () => 'C:/runtime',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async ({ args, captureOutput }) => {
          captureOutput?.(
            args[0] === '--version'
              ? 'codex-cli 1.2.3\n'
              : 'Usage: codex queue --thread <THREAD> --message <TEXT>\n',
          );
          return { exitCode: 0 };
        }),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (signal, listener) => signalSource.once(signal, listener),
        off: (signal, listener) => signalSource.off(signal, listener),
      },
      fetch: async (url, init) => {
        requests.push({
          url,
          ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }),
        });
        if (url.endsWith('/api/v1/projects')) return response({ projects: [] });
        if (url.endsWith('/api/v1/agents')) {
          return response({
            agents: [
              {
                id: sourceSession.agentId,
                kind: 'codex',
                displayName: 'Codex source',
                executable: 'C:/tools/codex.exe',
                detectedVersion: 'codex-cli 1.2.3',
                enabled: true,
                adapterId: 'codex-native-v1',
                nativeConfigRoots: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                metadata: {},
              },
            ],
          });
        }
        if (url.endsWith(`/api/v1/sessions/${sourceSession.id}`)) {
          sourceReads += 1;
          return response(
            sourceReads === 1 ? sourceSession : { ...sourceSession, presence: 'offline' },
          );
        }
        if (url.endsWith('/api/v1/wake-intents/recover')) {
          return response({ items: [], recoveredDispatching: [], terminalAcknowledged: 0 });
        }
        if (url.endsWith('/api/v1/wake-intents/claim')) {
          claimCount += 1;
          return response({
            items:
              claimCount === 1
                ? [
                    {
                      intent,
                      claimId: 'claim-liveness',
                      target: {
                        adapter: 'codex-queue-v1',
                        nativeSessionId: 'native-session-liveness',
                      },
                    },
                  ]
                : [],
            recoveredDispatching: [],
            terminalAcknowledged: 0,
          });
        }
        if (url.endsWith('/api/v1/wake-intents/wake-liveness/dispatching')) {
          return response({ status: 'updated', intent: { ...intent, state: 'dispatching' } });
        }
        if (url.endsWith('/api/v1/wake-intents/wake-liveness/complete')) {
          queueMicrotask(() => signalSource.emit('SIGINT'));
          return response({
            status: 'updated',
            intent: {
              ...intent,
              state: 'fallback_only',
              reasonCode: 'queue_capability_changed',
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    expect(sourceReads).toBe(2);
    expect(
      requests.find(({ url }) => url.endsWith('/api/v1/wake-intents/wake-liveness/complete'))?.body,
    ).toMatchObject({ state: 'fallback_only', reasonCode: 'queue_capability_changed' });
  });

  it('starts, stops, and reports process plus daemon slot state without exposing control data', async () => {
    const wakeLifecycle: WakeLifecycleService = {
      start: vi.fn(async () => running),
      stop: vi.fn(async () => stopped),
      status: vi.fn(async () => running),
      beginManagedServe: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    let output = '';
    const dependencies: Partial<CliDependencies> = {
      wakeLifecycle,
      stdout: { write: (text) => (output += text) },
      fetch: async (url) => {
        if (url.endsWith('/api/v1/bridge-slots?limit=100')) return response({ slots: [] });
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(['wake', 'start', '--json'], dependencies);
    expect(JSON.parse(output)).toEqual(running);
    output = '';
    await runCli(['wake', 'stop', '--json'], dependencies);
    expect(JSON.parse(output)).toEqual(stopped);
    output = '';
    await runCli(['wake', 'status', '--json'], dependencies);
    expect(JSON.parse(output)).toEqual({ process: running, slots: [], slotsAvailable: true });
    expect(output).not.toContain('token');
  });

  it('honors a managed cooperative stop and shuts dispatcher down before supervisor', async () => {
    const order: string[] = [];
    let requestStop!: () => void;
    const stopRequested = new Promise<void>((resolve) => {
      requestStop = resolve;
    });
    const lease = {
      stopRequested,
      close: vi.fn(async () => {
        order.push('lifecycle');
      }),
    };
    const wakeLifecycle: WakeLifecycleService = {
      start: vi.fn(async () => running),
      stop: vi.fn(async () => stopped),
      status: vi.fn(async () => running),
      beginManagedServe: vi.fn(async () => lease),
    };
    const signalSource = new EventEmitter();
    const wakeDispatcher = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        order.push('dispatcher');
      }),
    };
    let output = '';

    const run = runCli(['wake', 'serve'], {
      wakeLifecycle,
      wakeDispatcher,
      environment: {
        LUWI_WAKE_CONTROL_TOKEN: '6ccfd2c0-e424-4a21-91db-30dc72092a01',
        LUWI_WAKE_INSTANCE_ID: 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b',
      },
      signals: {
        once: (signal, listener) => signalSource.once(signal, listener),
        off: (signal, listener) => signalSource.off(signal, listener),
      },
      stdout: { write: (text) => (output += text) },
      stderr: { write: () => undefined },
      fetch: async (url) => {
        if (url.endsWith('/api/v1/projects')) return response({ projects: [] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [] });
        throw new Error(`Unexpected URL: ${url}`);
      },
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(() => {
        order.push('supervisor');
      }),
    });
    await vi.waitFor(() => expect(wakeDispatcher.start).toHaveBeenCalledTimes(1));
    requestStop();
    await run;

    expect(wakeLifecycle.beginManagedServe).toHaveBeenCalledTimes(1);
    expect(wakeDispatcher.start).toHaveBeenCalledWith({
      daemonUrl: 'http://127.0.0.1:4782',
      requestTimeoutMs: 2_000,
    });
    expect(order).toEqual(['dispatcher', 'supervisor', 'lifecycle']);
    expect(output).not.toContain('6ccfd2c0');
  });

  it('does not start the dispatcher when managed ownership stops during initial discovery', async () => {
    const order: string[] = [];
    let requestStop!: () => void;
    const stopRequested = new Promise<void>((resolve) => {
      requestStop = resolve;
    });
    let finishProjects!: (value: HttpResponseLike) => void;
    const projects = new Promise<HttpResponseLike>((resolve) => {
      finishProjects = resolve;
    });
    const wakeLifecycle: WakeLifecycleService = {
      start: vi.fn(async () => running),
      stop: vi.fn(async () => stopped),
      status: vi.fn(async () => running),
      beginManagedServe: vi.fn(async () => ({
        stopRequested,
        close: vi.fn(async () => {
          order.push('lifecycle');
        }),
      })),
    };
    const wakeDispatcher = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        order.push('dispatcher');
      }),
    };
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/projects')) return await projects;
      if (url.endsWith('/api/v1/agents')) return response({ agents: [] });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const run = runCli(['wake', 'serve'], {
      wakeLifecycle,
      wakeDispatcher,
      environment: {
        LUWI_WAKE_CONTROL_TOKEN: '6ccfd2c0-e424-4a21-91db-30dc72092a01',
        LUWI_WAKE_INSTANCE_ID: 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b',
      },
      signals: { once: () => undefined, off: () => undefined },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch,
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(() => {
        order.push('supervisor');
      }),
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    requestStop();
    finishProjects(response({ projects: [] }));

    await run;
    expect(wakeDispatcher.start).not.toHaveBeenCalled();
    expect(order).toEqual(['dispatcher', 'lifecycle']);
  });

  it('aborts initial discovery when an operator signal arrives before startup completes', async () => {
    const signalSource = new EventEmitter();
    const wakeDispatcher = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    let discoverySignal: AbortSignal | undefined;
    const fetch = vi.fn(async (url: string, init?: FetchInitLike) => {
      if (url.endsWith('/api/v1/agents')) return response({ agents: [] });
      if (url.endsWith('/api/v1/projects')) {
        discoverySignal = init?.signal;
        queueMicrotask(() => signalSource.emit('SIGTERM'));
        return await new Promise<HttpResponseLike>(() => undefined);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await runCli(['wake', 'serve'], {
      wakeDispatcher,
      environment: {},
      signals: {
        once: (signal, listener) => signalSource.once(signal, listener),
        off: (signal, listener) => signalSource.off(signal, listener),
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch,
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
    });

    expect(discoverySignal?.aborted).toBe(true);
    expect(wakeDispatcher.start).not.toHaveBeenCalled();
    expect(wakeDispatcher.stop).toHaveBeenCalledTimes(1);
  });
});

describe('wake serve', () => {
  const timestamp = '2026-09-09T00:00:00.000Z';
  const project = {
    id: 'project-app',
    name: 'App',
    localPath: 'C:/work/app',
    canonicalPath: 'C:/work/app',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const codexAgent = {
    id: 'codex',
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
  const claudeAgent = {
    ...codexAgent,
    id: 'claude-code',
    kind: 'claude-code',
    adapterId: 'claude-code',
  };
  const binding = (agentId: string) => ({
    id: `binding-${agentId}`,
    projectId: project.id,
    agentId,
    enabled: true,
    profileIds: [],
    capabilityBindingIds: [],
    overrides: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const effectiveConfig = (agentKind: string, settings: Record<string, unknown>) => ({
    projectId: project.id,
    agentId: agentKind,
    agentKind,
    valid: true,
    settings,
  });
  const slotId = 'b'.repeat(64);
  const slot = {
    id: slotId,
    workspaceId: 'local',
    projectId: project.id,
    agentId: 'codex',
    provider: 'codex',
    executionProfile: 'workspace-write',
    state: 'active',
    revision: 1,
    expiresAt: '2026-09-09T00:00:15.000Z',
  };
  const session = {
    id: 'codex-session-1',
    projectId: project.id,
    agentId: 'codex',
    status: 'starting',
    workingDirectory: 'C:/work/app',
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
    metadata: {},
    presence: 'online',
  };
  const message = (state: string) => ({
    id: 'message-1',
    correlationId: 'correlation-1',
    projectId: project.id,
    sourceSessionId: 'source-1',
    sourceAgentId: 'claude-code',
    targetSessionId: session.id,
    targetAgentId: 'codex',
    selectionReason: 'native-headless bridge preference',
    kind: 'instruction',
    content: 'Inspect and report.',
    evidenceRequirements: [],
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
    deadlineAt: '2026-09-09T02:00:00.000Z',
  });
  const requestItem = {
    streamId: '1-0',
    itemKind: 'request',
    messageId: 'message-1',
    correlationId: 'correlation-1',
    sourceSessionId: 'source-1',
    targetSessionId: session.id,
    createdAt: timestamp,
    payload: {
      kind: 'instruction',
      content: 'Inspect and report.',
      evidenceRequirements: [],
      deadlineAt: '2026-09-09T02:00:00.000Z',
    },
  };

  /**
   * The supervisor discovers the one enabled codex binding with a strict
   * `luwiNativeBridge` leaf, owns its slot, registers under it, and launches
   * the measured supervised argv — never the operator's free arguments. The
   * claude binding carries no leaf and gets no worker.
   */
  it('supervises a configured codex binding with a fixed no-shell profile launch', async () => {
    const signalSource = new EventEmitter();
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    let recorded:
      { executable: string; args: string[]; environment: Record<string, string> } | undefined;
    let claims = 0;
    let getMessageCalls = 0;
    const dependencies: Partial<CliDependencies> = {
      environment: {
        PATH: 'C:/tools',
        REDIS_URL: 'redis://private',
        LUWI_TEST_REDIS_URL: 'redis://test-private',
        LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS: 'true',
      },
      platform: 'win32',
      canonicalizePath: async (path) => path,
      agentProcessRunner: {
        run: vi.fn(async (input: unknown) => {
          recorded = input as typeof recorded;
          return { exitCode: 0 };
        }),
      } as unknown as CliDependencies['agentProcessRunner'],
      signals: {
        once: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.once(s, l),
        off: (s: 'SIGINT' | 'SIGTERM', l: () => void) => signalSource.off(s, l),
      } as unknown as CliDependencies['signals'],
      setInterval: vi.fn(() => 1 as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 2 as unknown as NodeJS.Timeout) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      wait: async () => undefined,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetch: async (url, init) => {
        requests.push({
          url,
          method: init?.method,
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
        });
        if (url.endsWith('/api/v1/projects')) return response({ projects: [project] });
        if (url.endsWith('/api/v1/agents')) return response({ agents: [codexAgent, claudeAgent] });
        if (url.endsWith(`/api/v1/projects/${project.id}/agents`)) {
          return response({ bindings: [binding('codex'), binding('claude-code')] });
        }
        if (url.endsWith(`/agents/codex/effective-config`)) {
          return response(
            effectiveConfig('codex', {
              luwiNativeBridge: {
                enabled: true,
                provider: 'codex',
                executionProfile: 'workspace-write',
              },
            }),
          );
        }
        if (url.endsWith(`/agents/claude-code/effective-config`)) {
          return response(effectiveConfig('claude-code', {}));
        }
        if (url.endsWith('/api/v1/bridge-slots/acquire')) {
          return response({ status: 'acquired', slot }, { status: 201 });
        }
        if (url.endsWith(`/api/v1/bridge-slots/${slotId}/release`)) {
          return response({ status: 'released', slot: { ...slot, state: 'standby' } });
        }
        if (url.endsWith('/api/v1/sessions') && init?.method === 'POST') {
          return response(session, { status: 201 });
        }
        if (url.includes('/inbox/claim')) {
          claims += 1;
          if (claims === 2) signalSource.emit('SIGINT');
          return response({ items: claims === 1 ? [requestItem] : [] });
        }
        if (url.includes('/status')) return response(session);
        if (url.includes('/heartbeat')) return response({ acknowledgedAt: timestamp });
        if (url.includes('/close')) {
          return response({ ...session, status: 'completed', presence: 'offline' });
        }
        if (url.includes('/leases')) return response({ leases: [], truncated: false });
        if (url.endsWith('/acknowledge')) return response(message('acknowledged'));
        if (url.endsWith('/processing')) return response(message('processing'));
        if (url.endsWith('/api/v1/messages/correlation-1')) {
          getMessageCalls += 1;
          return response(message(getMessageCalls === 1 ? 'delivered' : 'responded'));
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(['wake', 'serve'], dependencies);

    expect(recorded?.executable).toBe('C:/tools/codex.exe');
    expect(recorded?.args.slice(0, 3)).toEqual(['-a', 'never', 'exec']);
    expect(recorded?.args).toContain('--sandbox');
    expect(recorded?.args).toContain('workspace-write');
    expect(recorded?.args.slice(-1)[0]).toContain('LUWI message');
    expect(recorded?.environment.LUWI_SESSION_ID).toBe('codex-session-1');
    expect(recorded?.environment).not.toHaveProperty('LUWI_WAKE_CONTROL_TOKEN');
    expect(recorded?.environment).not.toHaveProperty('LUWI_WAKE_INSTANCE_ID');
    expect(recorded?.environment).not.toHaveProperty('REDIS_URL');
    expect(recorded?.environment).not.toHaveProperty('LUWI_TEST_REDIS_URL');
    expect(recorded?.environment).not.toHaveProperty('LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS');
    const acquires = requests.filter((entry) => entry.url.endsWith('/api/v1/bridge-slots/acquire'));
    expect(acquires).toHaveLength(1);
    expect(acquires[0]?.body).toMatchObject({
      projectId: 'project-app',
      agentId: 'codex',
      provider: 'codex',
      executionProfile: 'workspace-write',
    });
    const register = requests.find(
      (entry) => entry.url.endsWith('/api/v1/sessions') && entry.method === 'POST',
    );
    expect(register?.body).toMatchObject({ agentId: 'codex', bridgeOwner: { slotId } });
    expect(
      requests.some((entry) => entry.url.endsWith(`/api/v1/bridge-slots/${slotId}/release`)),
    ).toBe(true);
  });

  it('reports slot ownership through wake status', async () => {
    const lines: string[] = [];
    const processStatus = {
      state: 'running' as const,
      managed: true,
      ownership: 'owned' as const,
      pid: 4242,
      instanceId: 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b',
      startedAt: timestamp,
      heartbeatAt: timestamp,
    };
    const dependencies: Partial<CliDependencies> = {
      wakeLifecycle: {
        start: vi.fn(async () => processStatus),
        stop: vi.fn(async () => ({
          state: 'stopped' as const,
          managed: false,
          ownership: 'none' as const,
        })),
        status: vi.fn(async () => processStatus),
        beginManagedServe: vi.fn(async () => {
          throw new Error('not used');
        }),
      },
      stdout: { write: (text: string) => lines.push(text) },
      stderr: { write: () => undefined },
      setTimeout: vi.fn(() => 2 as unknown as NodeJS.Timeout) as CliDependencies['setTimeout'],
      clearTimeout: vi.fn() as CliDependencies['clearTimeout'],
      fetch: async (url) => {
        if (url.endsWith('/api/v1/bridge-slots?limit=100')) return response({ slots: [slot] });
        throw new Error(`Unexpected URL: ${url}`);
      },
    };

    await runCli(['wake', 'status', '--json'], dependencies);

    expect(JSON.parse(lines.join(''))).toEqual({
      process: processStatus,
      slots: [slot],
      slotsAvailable: true,
    });
  });

  it('preserves local wake status when the bounded daemon slot read times out', async () => {
    const lines: string[] = [];
    const deadlines = controlledDeadlineTimers();
    const timeoutBudgets: number[] = [];
    const processStatus = {
      state: 'running' as const,
      managed: true,
      ownership: 'owned' as const,
      pid: 4242,
      instanceId: 'f2e95fa4-f12d-4a42-92bb-fba0bb5f938b',
      startedAt: timestamp,
      heartbeatAt: timestamp,
    };
    let slotSignal: AbortSignal | undefined;
    const operation = runCli(['wake', 'status', '--json'], {
      wakeLifecycle: {
        start: vi.fn(async () => processStatus),
        stop: vi.fn(async () => ({
          state: 'stopped' as const,
          managed: false,
          ownership: 'none' as const,
        })),
        status: vi.fn(async () => processStatus),
        beginManagedServe: vi.fn(async () => {
          throw new Error('not used');
        }),
      },
      stdout: { write: (text: string) => lines.push(text) },
      stderr: { write: () => undefined },
      setTimeout: ((callback: () => void, milliseconds: number) => {
        timeoutBudgets.push(milliseconds);
        return deadlines.setTimeout(callback, milliseconds);
      }) as CliDependencies['setTimeout'],
      clearTimeout: deadlines.clearTimeout,
      fetch: (_url, init) => {
        slotSignal = init?.signal;
        return new Promise<HttpResponseLike>(() => undefined);
      },
    });

    await vi.waitFor(() => expect(slotSignal).toBeInstanceOf(AbortSignal));
    deadlines.fireNext();
    const outcome = await Promise.race([
      operation.then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('test_timeout'), 750)),
    ]);

    expect(outcome).toBe('resolved');
    expect(slotSignal?.aborted).toBe(true);
    expect(timeoutBudgets).toEqual([2_000]);
    expect(JSON.parse(lines.join(''))).toEqual({
      process: processStatus,
      slots: [],
      slotsAvailable: false,
      slotsErrorCode: 'DAEMON_REQUEST_TIMEOUT',
    });
  });
});
