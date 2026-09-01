import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  NodeNativeAgentProcessRunner,
  agentProvider,
  resolveAgentRunContext,
  type NativeAgentChildProcess,
  type NativeAgentSignalSource,
} from './agent-runner.js';

class FakeSignals implements NativeAgentSignalSource {
  readonly emitter = new EventEmitter();

  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown {
    return this.emitter.once(signal, listener);
  }

  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown {
    return this.emitter.off(signal, listener);
  }

  emit(signal: 'SIGINT' | 'SIGTERM'): void {
    this.emitter.emit(signal);
  }
}

class FakeChild extends EventEmitter implements NativeAgentChildProcess {
  pid: number | undefined = 321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function processHarness(
  overrides: ConstructorParameters<typeof NodeNativeAgentProcessRunner>[0] = {},
) {
  const child = new FakeChild();
  const spawnProcess = vi.fn(() => child);
  const runner = new NodeNativeAgentProcessRunner({
    platform: 'linux',
    environment: { PATH: '/tools' },
    parentPid: 99,
    now: () => 1_000,
    resolveExecutable: vi.fn(async (name: string) => `/tools/${name}`),
    canonicalizeExecutable: vi.fn(async (path: string) => path),
    spawnProcess,
    wait: vi.fn(async () => undefined),
    ...overrides,
  });
  return { child, runner, spawnProcess };
}

describe('native agent process runner', () => {
  it.each([
    ['claude', { kind: 'claude-code', executable: 'claude' }],
    ['codex', { kind: 'codex', executable: 'codex' }],
    ['gemini', { kind: 'gemini-cli', executable: 'gemini' }],
  ] as const)('maps the explicit provider %s', (name, expected) => {
    expect(agentProvider(name)).toMatchObject({ name, ...expected });
  });

  it('rejects providers outside the three-agent MVP surface', () => {
    expect(() => agentProvider('kimi')).toThrow(/claude, codex, or gemini/);
  });

  it('inherits stdio, preserves native arguments and environment, and returns the exit code', async () => {
    const { child, runner, spawnProcess } = processHarness();
    const signals = new FakeSignals();
    const environment = { PATH: '/tools', LUWI_DAEMON_URL: 'http://127.0.0.1:4782' };

    const running = runner.run({
      executable: 'codex',
      args: ['--model', 'gpt-5'],
      workingDirectory: '/work/project',
      environment,
      signals,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnProcess).toHaveBeenCalledWith('/tools/codex', ['--model', 'gpt-5'], {
      cwd: '/work/project',
      env: environment,
      shell: false,
      stdio: 'inherit',
      windowsHide: false,
      windowsVerbatimArguments: false,
    });
    child.exit(7, null);
    await expect(running).resolves.toEqual({ exitCode: 7, signal: undefined });
  });

  it('normalizes an asynchronous spawn failure', async () => {
    const { child, runner } = processHarness();
    const running = runner.run({
      executable: 'codex',
      args: [],
      workingDirectory: '/work/project',
      environment: {},
      signals: new FakeSignals(),
    });
    await Promise.resolve();
    await Promise.resolve();
    child.emit('error', new Error('spawn ENOENT'));

    await expect(running).rejects.toMatchObject({ code: 'AGENT_SPAWN_FAILED' });
  });

  it('forwards SIGINT and returns its conventional exit status', async () => {
    const { child, runner } = processHarness();
    const signals = new FakeSignals();
    const running = runner.run({
      executable: 'codex',
      args: [],
      workingDirectory: '/work/project',
      environment: {},
      signals,
    });
    await Promise.resolve();
    await Promise.resolve();

    signals.emit('SIGINT');
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    child.exit(null, 'SIGINT');

    await expect(running).resolves.toEqual({ exitCode: 130, signal: 'SIGINT' });
  });

  it('uses spawn-bound ownership evidence for Windows process-tree cleanup', async () => {
    const cleanup = vi.fn(async () => true);
    const diagnostics: unknown[] = [];
    const { child, runner } = processHarness({
      platform: 'win32',
      resolveExecutable: vi.fn(async () => 'C:/tools/codex.exe'),
      canonicalizeExecutable: vi.fn(async () => 'C:/tools/codex.exe'),
      resolveWindowsUtilities: vi.fn(async () => ({
        taskkillPath: 'C:/Windows/System32/taskkill.exe',
        powershellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      })),
      windowsProcessCleanup: cleanup,
    });
    const signals = new FakeSignals();
    const running = runner.run({
      executable: 'codex',
      args: [],
      workingDirectory: 'C:/work/project',
      environment: {},
      signals,
      onDiagnostic: (error) => diagnostics.push(error),
    });
    await vi.waitFor(() => expect(child.listenerCount('exit')).toBe(1));

    signals.emit('SIGTERM');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(cleanup).toHaveBeenCalledWith({
      rootPid: 321,
      rootParentPid: 99,
      rootExecutableName: 'codex.exe',
      rootSpawnedAtMs: 1_000,
      rootObservedBeforeMs: 1_000,
      rootCanonicalExecutablePath: 'C:/tools/codex.exe',
      taskkillPath: 'C:/Windows/System32/taskkill.exe',
      powershellPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      timeoutMs: 5_000,
    });
    child.exit(null, 'SIGTERM');

    await expect(running).resolves.toEqual({ exitCode: 143, signal: 'SIGTERM' });
    expect(diagnostics).toEqual([]);
  });

  it('launches a Windows command shim through trusted cmd without shell mode', async () => {
    const { child, runner, spawnProcess } = processHarness({
      platform: 'win32',
      resolveExecutable: vi.fn(async () => 'C:/tools/gemini.cmd'),
      canonicalizeExecutable: vi.fn(async () => 'C:/tools/gemini.cmd'),
      resolveWindowsUtilities: vi.fn(async () => ({
        cmdPath: 'C:/Windows/System32/cmd.exe',
      })),
    });
    const running = runner.run({
      executable: 'gemini',
      args: ['--model', 'gemini 2.5'],
      workingDirectory: 'C:/work/project',
      environment: {},
      signals: new FakeSignals(),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnProcess).toHaveBeenCalledWith(
      'C:/Windows/System32/cmd.exe',
      ['/d', '/s', '/c', '""C:/tools/gemini.cmd" "--model" "gemini 2.5""'],
      expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
    );
    child.exit(0, null);
    await expect(running).resolves.toEqual({ exitCode: 0, signal: undefined });
  });

  it('refuses Windows command-shim arguments that cmd could expand', async () => {
    const { runner, spawnProcess } = processHarness({
      platform: 'win32',
      resolveExecutable: vi.fn(async () => 'C:/tools/gemini.cmd'),
      canonicalizeExecutable: vi.fn(async () => 'C:/tools/gemini.cmd'),
      resolveWindowsUtilities: vi.fn(async () => ({
        cmdPath: 'C:/Windows/System32/cmd.exe',
      })),
    });

    await expect(
      runner.run({
        executable: 'gemini',
        args: ['%PATH%'],
        workingDirectory: 'C:/work/project',
        environment: {},
        signals: new FakeSignals(),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_ARGUMENT_UNSAFE' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe('agent observation context', () => {
  const projects = [
    { id: 'project-root', localPath: 'C:/work' },
    { id: 'project-app', localPath: 'C:/work/app' },
  ];
  const agents = [
    { id: 'codex-main', kind: 'codex' as const, enabled: true, executable: 'C:/bin/codex.exe' },
    { id: 'claude-main', kind: 'claude-code' as const, enabled: true },
  ];
  const client = {
    listProjects: vi.fn(async () => projects),
    listAgents: vi.fn(async () => agents),
    listProjectAgentBindings: vi.fn(async () => [
      { agentId: 'codex-main', enabled: true },
      { agentId: 'claude-main', enabled: true },
    ]),
  };

  it('uses explicit IDs without discovery', async () => {
    const explicitClient = {
      listProjects: vi.fn(),
      listAgents: vi.fn(),
      listProjectAgentBindings: vi.fn(),
    };

    await expect(
      resolveAgentRunContext({
        provider: agentProvider('codex'),
        workingDirectory: 'C:/work/app',
        projectId: 'project-explicit',
        agentId: 'agent-explicit',
        executable: 'C:/custom/codex.exe',
        platform: 'win32',
        client: explicitClient,
      }),
    ).resolves.toEqual({
      projectId: 'project-explicit',
      agentId: 'agent-explicit',
      executable: 'C:/custom/codex.exe',
    });
    expect(explicitClient.listProjects).not.toHaveBeenCalled();
    expect(explicitClient.listAgents).not.toHaveBeenCalled();
  });

  it('selects the deepest containing project and one enabled matching binding', async () => {
    await expect(
      resolveAgentRunContext({
        provider: agentProvider('codex'),
        workingDirectory: 'C:/work/app/src',
        platform: 'win32',
        client,
      }),
    ).resolves.toEqual({
      projectId: 'project-app',
      agentId: 'codex-main',
      executable: 'C:/bin/codex.exe',
    });
    expect(client.listProjectAgentBindings).toHaveBeenCalledWith('project-app');
  });

  it('never guesses among multiple matching enabled bindings', async () => {
    const ambiguous = {
      ...client,
      listAgents: vi.fn(async () => [
        ...agents,
        { id: 'codex-second', kind: 'codex' as const, enabled: true },
      ]),
      listProjectAgentBindings: vi.fn(async () => [
        { agentId: 'codex-main', enabled: true },
        { agentId: 'codex-second', enabled: true },
      ]),
    };

    await expect(
      resolveAgentRunContext({
        provider: agentProvider('codex'),
        workingDirectory: 'C:/work/app',
        platform: 'win32',
        client: ambiguous,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_BINDING_UNRESOLVED' });
  });
});
