import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NodeTranscriptFileSystem,
  SpawnCommandRunner,
  resolveTrustedWindowsUtilities,
} from './node-collaborators.js';
import {
  NodeWindowsProcessTreeIo,
  WindowsOwnedProcessTreeCleaner,
  type WindowsProcessIdentity,
  type WindowsProcessCleanupResult,
  type WindowsProcessSnapshotSession,
} from './windows-process-cleanup.js';

const temporaryDirectories: string[] = [];
const emergencyProcessIds = new Set<number>();

function controllableChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

async function expectProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

async function emergencyStop(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The exact test-owned process is already absent.
  }
  await expectProcessToExit(pid);
  emergencyProcessIds.delete(pid);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sameProcessIdentity(
  expected: WindowsProcessIdentity,
  actual: WindowsProcessIdentity,
): boolean {
  return (
    expected.pid === actual.pid &&
    expected.creationTicks === actual.creationTicks &&
    expected.executableName.toLowerCase() === actual.executableName.toLowerCase() &&
    (expected.canonicalExecutablePath === undefined ||
      actual.canonicalExecutablePath === undefined ||
      expected.canonicalExecutablePath.toLowerCase() ===
        actual.canonicalExecutablePath.toLowerCase())
  );
}

async function probeIdentities(
  session: WindowsProcessSnapshotSession,
  identities: readonly WindowsProcessIdentity[],
): Promise<Map<number, WindowsProcessIdentity> | undefined> {
  const rootIdentity = identities[0];
  if (rootIdentity === undefined) return new Map();
  const snapshot = await session.snapshot({
    rootPid: rootIdentity.pid,
    rootIdentity,
    knownIdentities: identities,
    timeoutMs: 1_000,
  });
  if (snapshot.status !== 'ok') return undefined;
  return new Map(snapshot.processes.map((identity) => [identity.pid, identity] as const));
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the required Windows race condition.');
}

function renderFixture(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [token, value] of Object.entries(values)) {
    if (
      /["%!]/u.test(value) ||
      Array.from(value).some((character) => {
        const code = character.codePointAt(0);
        return code !== undefined && (code <= 0x1f || code === 0x7f);
      })
    ) {
      throw new Error(`Unsafe fixture token value for ${token}.`);
    }
    const expectedOccurrences = token === '__NODE_EXE__' ? 2 : 1;
    expect(rendered.split(token)).toHaveLength(expectedOccurrences + 1);
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

async function createWindowsUtilityFixture(options: { cmd?: boolean; taskkill?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'luwi-trusted-windows-'));
  temporaryDirectories.push(root);
  const systemDirectory = join(root, 'System32');
  const powershellDirectory = join(systemDirectory, 'WindowsPowerShell', 'v1.0');
  await mkdir(powershellDirectory, { recursive: true });
  if (options.cmd !== false) await writeFile(join(systemDirectory, 'cmd.exe'), 'fixture', 'utf8');
  if (options.taskkill !== false) {
    await writeFile(join(systemDirectory, 'taskkill.exe'), 'fixture', 'utf8');
  }
  await writeFile(join(powershellDirectory, 'powershell.exe'), 'fixture', 'utf8');
  return { root, systemDirectory, powershellDirectory };
}

afterEach(async () => {
  await Promise.all([...emergencyProcessIds].map(async (pid) => emergencyStop(pid)));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('NodeTranscriptFileSystem', () => {
  it('applies its read limit in bytes and drops a partial final line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luwi-transcript-read-'));
    temporaryDirectories.push(directory);
    const transcript = join(directory, 'session.jsonl');
    // Each accented character is two UTF-8 bytes. Four bytes include both
    // characters but not the newline, so no complete line is available.
    await writeFile(transcript, 'éé\nsecond\n', 'utf8');

    const result = await new NodeTranscriptFileSystem().readLines(transcript, 4);

    expect(result).toEqual({ lines: [], truncated: true });
  });
});

describe('SpawnCommandRunner', () => {
  it.skipIf(process.platform !== 'win32')(
    'resolves only canonical Windows utilities inside the validated System32 directory',
    async () => {
      const fixture = await createWindowsUtilityFixture();

      const resolved = await resolveTrustedWindowsUtilities({
        SystemRoot: fixture.root,
        windir: fixture.root,
        ComSpec: join(fixture.systemDirectory, 'cmd.exe'),
      });

      expect(resolved).toEqual({
        systemDirectory: await realpath(fixture.systemDirectory),
        cmdPath: await realpath(join(fixture.systemDirectory, 'cmd.exe')),
        taskkillPath: await realpath(join(fixture.systemDirectory, 'taskkill.exe')),
        powershellPath: await realpath(join(fixture.powershellDirectory, 'powershell.exe')),
      });
    },
  );

  it.skipIf(process.platform !== 'win32').each([
    ['relative', 'cmd.exe'],
    ['quoted', '"C:\\Windows\\System32\\cmd.exe"'],
    ['argument-bearing', 'C:\\Windows\\System32\\cmd.exe /d'],
  ])('rejects a %s ComSpec and uses canonical System32 cmd.exe', async (_label, comSpec) => {
    const fixture = await createWindowsUtilityFixture();

    const resolved = await resolveTrustedWindowsUtilities({
      SystemRoot: fixture.root,
      windir: fixture.root,
      ComSpec: comSpec,
    });

    expect(resolved.cmdPath).toBe(await realpath(join(fixture.systemDirectory, 'cmd.exe')));
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects ComSpec outside canonical System32 even when it is an existing cmd.exe',
    async () => {
      const fixture = await createWindowsUtilityFixture();
      const outside = join(fixture.root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'cmd.exe'), 'fixture', 'utf8');

      const resolved = await resolveTrustedWindowsUtilities({
        SystemRoot: fixture.root,
        windir: fixture.root,
        ComSpec: join(outside, 'cmd.exe'),
      });

      expect(resolved.cmdPath).toBe(await realpath(join(fixture.systemDirectory, 'cmd.exe')));
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'compares trusted utility basenames case-insensitively',
    async () => {
      const fixture = await createWindowsUtilityFixture();

      const resolved = await resolveTrustedWindowsUtilities({
        SystemRoot: fixture.root,
        windir: fixture.root,
        ComSpec: join(fixture.systemDirectory, 'CMD.EXE'),
      });

      expect(resolved.cmdPath).toBe(await realpath(join(fixture.systemDirectory, 'cmd.exe')));
      expect(resolved.taskkillPath).toBe(
        await realpath(join(fixture.systemDirectory, 'TASKKILL.EXE')),
      );
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'does not select an ambient taskkill when canonical System32 taskkill.exe is missing',
    async () => {
      const fixture = await createWindowsUtilityFixture({ taskkill: false });
      const ambient = join(fixture.root, 'ambient-taskkill');
      await mkdir(ambient);
      await writeFile(join(ambient, 'taskkill.exe'), 'ambient', 'utf8');

      const resolved = await resolveTrustedWindowsUtilities({
        SystemRoot: fixture.root,
        windir: fixture.root,
        PATH: ambient,
      });

      expect(resolved.taskkillPath).toBeUndefined();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'ignores ambient PATH utilities and fails closed when trusted cmd.exe is missing',
    async () => {
      const fixture = await createWindowsUtilityFixture({ cmd: false });
      const ambient = join(fixture.root, 'ambient');
      await mkdir(ambient);
      await writeFile(join(ambient, 'cmd.exe'), 'ambient', 'utf8');
      await writeFile(join(ambient, 'taskkill.exe'), 'ambient', 'utf8');
      const spawnProcess = vi.fn();
      const runner = new SpawnCommandRunner({
        environment: {
          SystemRoot: fixture.root,
          windir: fixture.root,
          ComSpec: 'cmd.exe',
          PATH: ambient,
        },
        spawnProcess,
      } as never);

      await expect(
        runner.run(join(tmpdir(), 'missing-trusted.cmd'), ['--version']),
      ).resolves.toEqual({ exitCode: 1, stdout: '', stderr: '', failure: 'unavailable' });
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );
  it('returns bounded version output for a normal executable', async () => {
    const runner = new SpawnCommandRunner({
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });

    const result = await runner.run(process.execPath, ['-e', 'process.stdout.write("1.2.3\\n")']);

    expect(result).toEqual({ exitCode: 0, stdout: '1.2.3\n', stderr: '' });
  });

  it('returns a spawn failure when the executable disappears', async () => {
    const runner = new SpawnCommandRunner({
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });

    const result = await runner.run(join(tmpdir(), 'luwi-missing-executable'), ['--version']);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: '',
      failure: 'spawn',
    });
  });

  it(
    'terminates a hanging executable within the configured bound',
    // The runner may legitimately spend timeoutMs + cleanupTimeoutMs before settling, which
    // already exceeds vitest's 5s default; the explicit timeout only guards against a hang.
    { timeout: 20_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'luwi-adapter-timeout-'));
      temporaryDirectories.push(directory);
      const pidPath = join(directory, 'pid.txt');
      const timeoutMs = 500;
      const cleanupTimeoutMs = 5_000;
      // Absorbs timer lateness on a saturated machine without hiding an unbounded hang.
      const schedulerSlackMs = 2_000;
      const runner = new SpawnCommandRunner({
        timeoutMs,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        cleanupTimeoutMs,
      });
      const startedAt = Date.now();

      const result = await runner.run(process.execPath, [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)',
        pidPath,
      ]);

      expect(result).toMatchObject({
        exitCode: 1,
        stdout: '',
        stderr: '',
      });
      expect(process.platform === 'win32' ? ['timeout', 'cleanup'] : ['timeout']).toContain(
        result.failure,
      );
      expect(Date.now() - startedAt).toBeLessThan(timeoutMs + cleanupTimeoutMs + schedulerSlackMs);
      const pid = Number(await readFile(pidPath, 'utf8'));
      await expectProcessToExit(pid);
    },
  );

  it.each([
    ['stdout', 'process.stdout.write("x".repeat(2048));setInterval(()=>{},1000)', 'stdout_limit'],
    ['stderr', 'process.stderr.write("x".repeat(2048));setInterval(()=>{},1000)', 'stderr_limit'],
  ] as const)(
    'terminates excessive %s without retaining the output',
    // Same worst case as the hanging-executable test above: the limit breach is
    // detected quickly, but the Windows owned-tree cleanup that follows spends a
    // PowerShell startup and an `Add-Type` C# compile, which under a saturated
    // suite run exceeds vitest's 5s default. The explicit bound only guards
    // against a genuine hang. The runner's own timeout is generous for the same
    // reason: the child writes its excess at startup, and a cold Node start on
    // a saturated machine can pass 1 s — then the runner reported `timeout`
    // where the limit breach was the real outcome. The limit still ends the
    // run the moment it is crossed; the timeout is only the hang guard.
    { timeout: 30_000 },
    async (_stream, script, failure) => {
      let cleanupEvidence: WindowsProcessCleanupResult | undefined;
      const cleaner = new WindowsOwnedProcessTreeCleaner(new NodeWindowsProcessTreeIo(spawn));
      const runner = new SpawnCommandRunner({
        timeoutMs: 10_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        windowsProcessCleanup: async (request) => {
          cleanupEvidence = await cleaner.cleanup(request);
          return cleanupEvidence.cleaned;
        },
      });

      const result = await runner.run(process.execPath, ['-e', script]);

      if (process.platform === 'win32') {
        expect(cleanupEvidence?.cleaned, JSON.stringify(cleanupEvidence)).toBe(true);
      }
      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: '',
        failure,
      });
    },
  );

  it('passes arguments literally with shell execution disabled', async () => {
    const runner = new SpawnCommandRunner({
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });

    const result = await runner.run(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      'literal & echo not-a-command',
    ]);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'literal & echo not-a-command',
      stderr: '',
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'executes a real Windows .cmd fixture through the bounded command-shim path (requires Windows)',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'luwi-adapter-command-shim-'));
      temporaryDirectories.push(directory);
      const fixture = join(directory, 'version fixture.cmd');
      await writeFile(
        fixture,
        `@echo off\r\n"${process.execPath}" -e "process.stdout.write('fixture-1.2.3')"\r\n`,
        'utf8',
      );
      const runner = new SpawnCommandRunner({
        timeoutMs: 1_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
      });

      const result = await runner.run(fixture, ['--version']);

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'fixture-1.2.3',
        stderr: '',
      });
    },
  );

  it('uses shell-free spawn options and detaches all listeners after successful settlement', async () => {
    const child = controllableChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const runner = new SpawnCommandRunner({ spawnProcess } as never);

    const result = await runner.run(process.execPath, ['--version']);

    expect(result.exitCode).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(child.listenerCount('error')).toBe(1);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
  });

  it('clears listeners and ignores late events after an asynchronous spawn failure', async () => {
    const child = controllableChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    });
    const runner = new SpawnCommandRunner({ spawnProcess } as never);

    const result = await runner.run(process.execPath, ['--version']);
    child.stdout.emit('data', Buffer.from('late output'));
    child.stderr.emit('data', Buffer.from('late error'));
    child.emit('close', 0);

    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: '',
      failure: 'spawn',
    });
    expect(child.listenerCount('error')).toBe(1);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')(
    'safely absorbs late child errors while bounded owned-tree cleanup is pending (requires Windows)',
    async () => {
      vi.useFakeTimers();
      const child = controllableChild();
      const spawnProcess = vi.fn().mockReturnValueOnce(child);
      let finishCleanup: ((cleaned: boolean) => void) | undefined;
      const windowsProcessCleanup = vi.fn(
        async () =>
          await new Promise<boolean>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      const runner = new SpawnCommandRunner({
        timeoutMs: 10,
        cleanupTimeoutMs: 100,
        spawnProcess,
        windowsProcessCleanup,
        trustedWindowsUtilities: { cmdPath: 'C:\\Windows\\System32\\cmd.exe' },
      } as never);

      const resultPromise = runner.run(join(tmpdir(), 'late-error.cmd'), ['--version']);
      await vi.advanceTimersByTimeAsync(10);
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      child.emit('error', new Error('kill raced with taskkill'));
      await Promise.resolve();
      expect(resolved).toBe(false);
      finishCleanup?.(true);
      const result = await resultPromise;

      expect(result.failure).toBe('timeout');
      expect(child.listenerCount('close')).toBe(0);
      expect(() => child.emit('error', new Error('late child error'))).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.skipIf(process.platform !== 'win32').each(['error', 'unproven'])(
    'classifies a bounded Windows tree-cleanup %s as cleanup failure (requires Windows)',
    async (outcome) => {
      vi.useFakeTimers();
      const child = controllableChild();
      const spawnProcess = vi.fn().mockReturnValueOnce(child);
      const windowsProcessCleanup = vi.fn(async () => {
        if (outcome === 'error') throw new Error('cleanup failed');
        return false;
      });
      const runner = new SpawnCommandRunner({
        timeoutMs: 10,
        cleanupTimeoutMs: 100,
        spawnProcess,
        windowsProcessCleanup,
        trustedWindowsUtilities: { cmdPath: 'C:\\Windows\\System32\\cmd.exe' },
      } as never);

      const resultPromise = runner.run(join(tmpdir(), 'cleanup-failure.cmd'), ['--version']);
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      await expect(resultPromise).resolves.toEqual({
        exitCode: 1,
        stdout: '',
        stderr: '',
        failure: 'cleanup',
      });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'does not settle while canonical Windows cleanup is still pending (requires Windows)',
    async () => {
      vi.useFakeTimers();
      const child = controllableChild();
      const spawnProcess = vi.fn().mockReturnValueOnce(child);
      let finishCleanup: ((cleaned: boolean) => void) | undefined;
      const windowsProcessCleanup = vi.fn(
        async () =>
          await new Promise<boolean>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      const runner = new SpawnCommandRunner({
        timeoutMs: 10,
        cleanupTimeoutMs: 100,
        spawnProcess,
        windowsProcessCleanup,
        trustedWindowsUtilities: { cmdPath: 'C:\\Windows\\System32\\cmd.exe' },
      } as never);

      const resultPromise = runner.run(join(tmpdir(), 'pending-cleanup.cmd'), ['--version']);
      let settled = false;
      void resultPromise.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(110);

      expect(settled).toBe(false);
      finishCleanup?.(false);
      await expect(resultPromise).resolves.toMatchObject({ failure: 'cleanup' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'does not treat root close as proof that Windows process-tree cleanup succeeded (requires Windows)',
    async () => {
      vi.useFakeTimers();
      const child = controllableChild();
      const spawnProcess = vi.fn().mockReturnValueOnce(child);
      let finishCleanup: ((cleaned: boolean) => void) | undefined;
      const windowsProcessCleanup = vi.fn(
        async () =>
          await new Promise<boolean>((resolve) => {
            finishCleanup = resolve;
          }),
      );
      const runner = new SpawnCommandRunner({
        timeoutMs: 10,
        cleanupTimeoutMs: 100,
        spawnProcess,
        windowsProcessCleanup,
        trustedWindowsUtilities: { cmdPath: 'C:\\Windows\\System32\\cmd.exe' },
      } as never);

      const resultPromise = runner.run(join(tmpdir(), 'closed-root.cmd'), ['--version']);
      await vi.advanceTimersByTimeAsync(10);
      child.emit('close', null);
      let resolved = false;
      void resultPromise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      finishCleanup?.(false);

      await expect(resultPromise).resolves.toMatchObject({ failure: 'cleanup' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'passes the complete spawn-bound root expectation into Windows cleanup (requires Windows)',
    async () => {
      const child = controllableChild();
      const spawnProcess = vi.fn().mockReturnValueOnce(child);
      const windowsProcessCleanup = vi.fn(async () => true);
      const runner = new SpawnCommandRunner({
        timeoutMs: 10,
        cleanupTimeoutMs: 100,
        spawnProcess,
        windowsProcessCleanup,
        trustedWindowsUtilities: {
          cmdPath: 'C:\\Windows\\System32\\cmd.exe',
          taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
          powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        },
      } as never);

      const resultPromise = runner.run(join(tmpdir(), 'root-evidence.cmd'), ['--version']);
      await expect(resultPromise).resolves.toMatchObject({ failure: 'timeout' });

      expect(windowsProcessCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          rootPid: child.pid,
          rootParentPid: process.pid,
          rootObservedBeforeMs: expect.any(Number),
          rootCanonicalExecutablePath: expect.stringMatching(/cmd\.exe$/i),
        }),
      );
    },
  );

  it('normalizes a synchronous spawn throw and clears its timeout state', async () => {
    vi.useFakeTimers();
    const spawnProcess = vi.fn(() => {
      throw new Error('spawn EINVAL');
    });
    const runner = new SpawnCommandRunner({ spawnProcess } as never);

    await expect(runner.run(process.execPath, ['--version'])).resolves.toEqual({
      exitCode: 1,
      stdout: '',
      stderr: '',
      failure: 'spawn',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')(
    'uses fixed shell-free command-processor arguments for Windows shims (requires Windows)',
    async () => {
      const child = controllableChild();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => child.emit('close', 0));
        return child;
      });
      const runner = new SpawnCommandRunner({ spawnProcess } as never);
      const shim = join(tmpdir(), 'literal shim.cmd');

      const result = await runner.run(shim, ['--version']);

      expect(result.exitCode).toBe(0);
      expect(isAbsolute(spawnProcess.mock.calls[0]?.[0] as string)).toBe(true);
      expect(spawnProcess).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        ['/d', '/s', '/c', `""${shim}" --version"`],
        expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
      );
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'rejects arbitrary command text instead of appending it to a Windows shim (requires Windows)',
    async () => {
      const spawnProcess = vi.fn();
      const runner = new SpawnCommandRunner({ spawnProcess } as never);

      await expect(
        runner.run(join(tmpdir(), 'literal shim.cmd'), ['--version & echo injected']),
      ).resolves.toMatchObject({ failure: 'spawn' });
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'observes root absent, descendant alive, and runner pending (requires Windows)',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'luwi-adapter-command-tree-'));
      temporaryDirectories.push(directory);
      const fixture = join(directory, 'early root close fixture.cmd');
      const pidPath = join(directory, 'owned-processes.json');
      const rootReleasePath = join(directory, 'release-root');
      const template = await readFile(
        join(
          process.cwd(),
          'packages',
          'adapters',
          'test-fixtures',
          'windows',
          'early-root-close.cmd',
        ),
        'utf8',
      );
      await writeFile(
        fixture,
        renderFixture(template, {
          __NODE_EXE__: process.execPath,
          __EVIDENCE_PATH__: pidPath,
          __ROOT_RELEASE_PATH__: rootReleasePath,
        }),
        'utf8',
      );
      const nodeIo = new NodeWindowsProcessTreeIo(spawn);
      const trustedUtilities = await resolveTrustedWindowsUtilities();
      let owned: { rootPid: number; descendantPid: number } | undefined;
      let rootIdentity: WindowsProcessIdentity | undefined;
      let descendantIdentity: WindowsProcessIdentity | undefined;
      let productionCleanupResult: WindowsProcessCleanupResult | undefined;
      let processCommandLines = '';
      let activeSnapshotSession: WindowsProcessSnapshotSession | undefined;
      const snapshotTrace: Array<{
        status: string;
        processes: WindowsProcessIdentity[];
      }> = [];
      let releaseTermination: (() => void) | undefined;
      let reachedTermination: (() => void) | undefined;
      const terminationReached = new Promise<void>((resolve) => {
        reachedTermination = resolve;
      });
      const terminationRelease = new Promise<void>((resolve) => {
        releaseTermination = resolve;
      });
      const observeSnapshot = <T extends { status: string; processes: WindowsProcessIdentity[] }>(
        result: T,
      ): T => {
        snapshotTrace.push({ status: result.status, processes: [...result.processes] });
        if (result.status === 'ok' && owned !== undefined) {
          rootIdentity ??= result.processes.find((item) => item.pid === owned!.rootPid);
          descendantIdentity ??= result.processes.find((item) => item.pid === owned!.descendantPid);
        }
        return result;
      };
      const cleaner = new WindowsOwnedProcessTreeCleaner({
        openSnapshotSession: async (request) => {
          const session = await nodeIo.openSnapshotSession(request);
          activeSnapshotSession = session;
          return session === undefined
            ? undefined
            : {
                snapshot: async (snapshotRequest) =>
                  observeSnapshot(await session.snapshot(snapshotRequest)),
                close: async (timeoutMs) => await session.close(timeoutMs),
              };
        },
        snapshot: async (request) => {
          return observeSnapshot(await nodeIo.snapshot(request));
        },
        terminateTree: async () => {
          processCommandLines = JSON.stringify({
            root: {
              executable: trustedUtilities.cmdPath,
              arguments: ['/d', '/s', '/c', `""${fixture}" --version"`],
            },
            descendant: {
              executable: process.execPath,
              arguments: [
                '-e',
                "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({rootPid:process.ppid,descendantPid:process.pid}));setInterval(()=>{},1000)",
                pidPath,
              ],
            },
          });
          await writeFile(rootReleasePath, '', 'utf8');
          reachedTermination?.();
          await terminationRelease;
          return 'nonzero';
        },
        terminateExact: (identity) => nodeIo.terminateExact(identity),
      });
      const runner = new SpawnCommandRunner({
        timeoutMs: 2_500,
        cleanupTimeoutMs: 5_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        windowsProcessCleanup: async (request) => {
          productionCleanupResult = await cleaner.cleanup(request);
          return productionCleanupResult.cleaned;
        },
      });

      let runnerSettled = false;
      const runnerStartedAtMs = Date.now();
      let raceObservedAtMs: number | undefined;
      let runnerResult: Awaited<ReturnType<SpawnCommandRunner['run']>> | undefined;
      let runnerPromise: ReturnType<SpawnCommandRunner['run']> | undefined;
      try {
        runnerPromise = runner.run(fixture, ['--version']).finally(() => {
          runnerSettled = true;
        });
        await waitForCondition(async () => {
          try {
            owned = JSON.parse(await readFile(pidPath, 'utf8')) as typeof owned;
            return owned !== undefined;
          } catch {
            return false;
          }
        }, 2_000);
        emergencyProcessIds.add(owned!.descendantPid);
        await Promise.race([
          terminationReached,
          runnerPromise.then(() => {
            throw new Error('Runner settled before reaching the termination gate.');
          }),
        ]);
        await waitForCondition(async () => {
          if (
            activeSnapshotSession === undefined ||
            rootIdentity === undefined ||
            descendantIdentity === undefined
          ) {
            return false;
          }
          const live = await probeIdentities(activeSnapshotSession, [
            rootIdentity,
            descendantIdentity,
          ]);
          const observed =
            live !== undefined &&
            !live.has(rootIdentity.pid) &&
            live.has(descendantIdentity.pid) &&
            sameProcessIdentity(descendantIdentity, live.get(descendantIdentity.pid)!);
          if (observed) raceObservedAtMs = Date.now();
          return observed;
        }, 2_000);

        process.stdout.write(
          `${JSON.stringify({ phase: 'canonical-orphan-race', rootPid: owned!.rootPid, descendantPid: owned!.descendantPid, processCommandLines, rootCloseAfterMs: raceObservedAtMs! - runnerStartedAtMs, descendantAliveAfterMs: raceObservedAtMs! - runnerStartedAtMs, runnerPending: !runnerSettled })}\n`,
        );

        expect(runnerSettled).toBe(false);
        expect(rootIdentity).toBeDefined();
        expect(descendantIdentity).toBeDefined();
        expect((rootIdentity as unknown as { creationTicks?: string }).creationTicks).toEqual(
          expect.any(String),
        );
        expect((descendantIdentity as unknown as { creationTicks?: string }).creationTicks).toEqual(
          expect.any(String),
        );
        releaseTermination?.();
        runnerResult = await runnerPromise;

        expect(runnerResult.failure).toBe('timeout');
        expect(productionCleanupResult?.cleaned).toBe(true);
        await expectProcessToExit(owned!.descendantPid);
        emergencyProcessIds.delete(owned!.descendantPid);
      } finally {
        releaseTermination?.();
        if (runnerResult === undefined && runnerPromise !== undefined) {
          runnerResult = await runnerPromise.catch(() => undefined);
        }
        const emergencyCleanupRequired = owned !== undefined && processExists(owned.descendantPid);
        if (owned !== undefined && processExists(owned.descendantPid)) {
          await emergencyStop(owned.descendantPid);
        }
        process.stdout.write(
          `${JSON.stringify({ phase: 'canonical-orphan-result', runnerResult, productionCleanupResult, snapshotTrace, emergencyCleanupRequired, emergencyCleanupResult: emergencyCleanupRequired ? 'verified_absent' : 'unused' })}\n`,
        );
      }
    },
    12_000,
  );

  it.skipIf(process.platform !== 'win32').each([
    [
      'stdout',
      "process.stdout.write('x'.repeat(70 * 1024));setInterval(()=>{},1000)",
      'stdout_limit',
    ],
    [
      'stderr',
      "process.stderr.write('x'.repeat(70 * 1024));setInterval(()=>{},1000)",
      'stderr_limit',
    ],
  ])(
    'terminates a Windows .cmd fixture that exceeds the %s bound (requires Windows)',
    async (_stream, script, failure) => {
      const directory = await mkdtemp(join(tmpdir(), 'luwi-adapter-command-output-'));
      temporaryDirectories.push(directory);
      const fixture = join(directory, `noisy-${String(_stream)}.cmd`);
      await writeFile(fixture, `@echo off\r\n"${process.execPath}" -e "${script}"\r\n`, 'utf8');
      const runner = new SpawnCommandRunner();

      const result = await runner.run(fixture, ['--version']);

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: '',
        failure,
      });
    },
  );
});
