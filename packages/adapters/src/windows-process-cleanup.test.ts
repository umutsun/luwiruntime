import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NodeWindowsProcessTreeIo,
  WindowsOwnedProcessTreeCleaner,
  type WindowsProcessIdentity,
  type WindowsProcessTreeIo,
} from './windows-process-cleanup.js';

function controllableUtility(pid = 4_242) {
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const TEST_NOW_MS = 1_700_000_000_000;
const WINDOWS_EPOCH_TICKS = 621_355_968_000_000_000n;
const creationTicks = (milliseconds: number): string =>
  (WINDOWS_EPOCH_TICKS + BigInt(milliseconds) * 10_000n).toString();

const root: WindowsProcessIdentity = {
  pid: 100,
  parentPid: 1,
  creationTicks: creationTicks(TEST_NOW_MS),
  executableName: 'cmd.exe',
  canonicalExecutablePath: 'C:\\Windows\\System32\\cmd.exe',
};
const child: WindowsProcessIdentity = {
  pid: 200,
  parentPid: 100,
  creationTicks: creationTicks(TEST_NOW_MS + 1),
  executableName: 'node.exe',
  canonicalExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
};
const grandchild: WindowsProcessIdentity = {
  pid: 300,
  parentPid: 200,
  creationTicks: creationTicks(TEST_NOW_MS + 2),
  executableName: 'node.exe',
  canonicalExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
};

const rootRequest = {
  rootPid: root.pid,
  rootParentPid: root.parentPid,
  rootExecutableName: root.executableName,
  rootSpawnedAtMs: TEST_NOW_MS - 1,
  rootObservedBeforeMs: TEST_NOW_MS + 1,
  rootCanonicalExecutablePath: root.canonicalExecutablePath,
};

function ioWithSnapshots(
  snapshots: Array<Awaited<ReturnType<WindowsProcessTreeIo['snapshot']>>>,
  treeResult: Awaited<ReturnType<WindowsProcessTreeIo['terminateTree']>> = 'success',
) {
  return {
    snapshot: vi.fn(async () => snapshots.shift() ?? { status: 'ok' as const, processes: [] }),
    terminateTree: vi.fn(async () => treeResult),
    terminateExact: vi.fn(() => true),
  } satisfies WindowsProcessTreeIo;
}

describe('WindowsOwnedProcessTreeCleaner', () => {
  it.each(['success', 'nonzero'] as const)(
    'accepts taskkill %s only after independent verification proves the owned tree absent',
    async (treeResult) => {
      const io = ioWithSnapshots(
        [
          { status: 'ok', processes: [root, child] },
          { status: 'ok', processes: [root, child] },
          { status: 'ok', processes: [] },
          { status: 'ok', processes: [] },
        ],
        treeResult,
      );
      const cleaner = new WindowsOwnedProcessTreeCleaner(io);

      await expect(
        cleaner.cleanup({
          ...rootRequest,
          taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
          powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({ cleaned: true });
      expect(io.terminateTree).toHaveBeenCalledOnce();
    },
  );

  it('fails closed when taskkill returns nonzero and a known descendant survives fallback', async () => {
    const io = ioWithSnapshots(
      [
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [child] },
        { status: 'ok', processes: [child] },
      ],
      'nonzero',
    );
    io.terminateExact.mockReturnValue(false);
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false });
  });

  it.each(['error', 'timeout'] as const)(
    'uses exact-PID fallback deepest-first and verifies absence after taskkill %s',
    async (treeResult) => {
      const io = ioWithSnapshots(
        [
          { status: 'ok', processes: [root, child, grandchild] },
          { status: 'ok', processes: [root, child, grandchild] },
          { status: 'ok', processes: [root, child, grandchild] },
          { status: 'ok', processes: [] },
        ],
        treeResult,
      );
      const cleaner = new WindowsOwnedProcessTreeCleaner(io);

      await expect(
        cleaner.cleanup({
          ...rootRequest,
          taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
          powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({ cleaned: true });
      expect(io.terminateExact.mock.calls.map(([process]) => process.pid)).toEqual([300, 200, 100]);
    },
  );

  it('fails closed without killing when the root is absent at first discovery', async () => {
    const io = ioWithSnapshots([
      { status: 'ok', processes: [child] },
      { status: 'ok', processes: [child] },
      { status: 'ok', processes: [] },
    ]);
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false });
    expect(io.terminateTree).not.toHaveBeenCalled();
    expect(io.terminateExact).not.toHaveBeenCalled();
  });

  it.each(['error', 'timeout', 'malformed', 'limit'] as const)(
    'fails closed when descendant discovery returns %s',
    async (status) => {
      const io = ioWithSnapshots([{ status, processes: [] }], 'success');
      const cleaner = new WindowsOwnedProcessTreeCleaner(io);

      await expect(
        cleaner.cleanup({
          ...rootRequest,
          taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
          powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          timeoutMs: 500,
        }),
      ).resolves.toMatchObject({ cleaned: false });
      expect(io.terminateTree).not.toHaveBeenCalled();
      expect(io.terminateExact).not.toHaveBeenCalled();
    },
  );

  it('retries transient unproven identity evidence inside the shared snapshot budget', async () => {
    const io = ioWithSnapshots([
      { status: 'unproven', processes: [] },
      { status: 'ok', processes: [root, child] },
      { status: 'ok', processes: [root, child] },
      { status: 'ok', processes: [] },
      { status: 'ok', processes: [] },
    ]);
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: true });
    expect(io.snapshot).toHaveBeenCalledTimes(5);
  });

  it('fails closed without a kill when transient evidence exhausts the global budget', async () => {
    const io = ioWithSnapshots(
      Array.from({ length: 8 }, () => ({ status: 'unproven' as const, processes: [] as [] })),
    );
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false, diagnostic: 'snapshot_limit' });
    expect(io.snapshot).toHaveBeenCalledTimes(8);
    expect(io.terminateTree).not.toHaveBeenCalled();
    expect(io.terminateExact).not.toHaveBeenCalled();
  });

  it('does not kill a PID whose creation identity changed after discovery', async () => {
    const reused = { ...child, creationTicks: creationTicks(TEST_NOW_MS + 9_999) };
    const io = ioWithSnapshots(
      [
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [reused] },
      ],
      'nonzero',
    );
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false });
    expect(io.terminateExact).not.toHaveBeenCalled();
  });

  it('keeps the same creation identity owned when Windows reparents it', async () => {
    const reparentedChild = { ...child, parentPid: 0 };
    const io = ioWithSnapshots(
      [
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [reparentedChild] },
        { status: 'ok', processes: [] },
      ],
      'success',
    );
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: true, diagnostic: 'verified_fallback' });
    expect(io.terminateExact).toHaveBeenCalledWith(reparentedChild);
  });

  it('keeps a descendant owned when its canonical path becomes temporarily unreadable', async () => {
    const pathUnavailable = { ...child, canonicalExecutablePath: undefined };
    const io = ioWithSnapshots(
      [
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [pathUnavailable] },
        { status: 'ok', processes: [] },
      ],
      'success',
    );
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: true, diagnostic: 'verified_fallback' });
    expect(io.terminateExact).toHaveBeenCalledWith(pathUnavailable);
  });

  it('does not terminate a root PID that already belongs to another executable', async () => {
    const reusedRoot = { ...root, executableName: 'unrelated.exe' };
    const io = ioWithSnapshots([
      { status: 'ok', processes: [reusedRoot, child] },
      { status: 'ok', processes: [reusedRoot, child] },
      { status: 'ok', processes: [] },
    ]);
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false, diagnostic: 'identity_changed' });
    expect(io.terminateTree).not.toHaveBeenCalled();
    expect(io.terminateExact).not.toHaveBeenCalled();
  });

  it('returns cleanup failure without ambient fallback when trusted taskkill is unavailable', async () => {
    const io = ioWithSnapshots([
      { status: 'ok', processes: [root, child] },
      { status: 'ok', processes: [root, child] },
      { status: 'ok', processes: [] },
    ]);
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false });
    expect(io.terminateTree).not.toHaveBeenCalled();
  });

  it('remains bounded when a utility call never settles', async () => {
    vi.useFakeTimers();
    const io = {
      snapshot: vi.fn(async () => await new Promise<never>(() => undefined)),
      terminateTree: vi.fn(async () => 'success' as const),
      terminateExact: vi.fn(() => true),
    } satisfies WindowsProcessTreeIo;
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);
    const result = cleaner.cleanup({
      ...rootRequest,
      taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      timeoutMs: 500,
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({ cleaned: false });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('reaches a fixed point from a dead known parent before destructive cleanup', async () => {
    let call = 0;
    const terminateTree = vi.fn(async () => 'success' as const);
    const snapshot = vi.fn(
      async (request: { knownIdentities: readonly WindowsProcessIdentity[] }) => {
        call += 1;
        if (call === 1) return { status: 'ok' as const, processes: [root, child] };
        if (call <= 3) expect(terminateTree).not.toHaveBeenCalled();
        if (call > 3) return { status: 'ok' as const, processes: [] };
        return request.knownIdentities.some((identity) => identity.pid === child.pid)
          ? { status: 'ok' as const, processes: [root, grandchild] }
          : { status: 'ok' as const, processes: [root] };
      },
    );
    const io = {
      snapshot,
      terminateTree,
      terminateExact: vi.fn(() => true),
    } satisfies WindowsProcessTreeIo;
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await cleaner.cleanup({
      ...rootRequest,
      taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      timeoutMs: 500,
    });

    expect(snapshot.mock.calls[1]?.[0].knownIdentities).toContainEqual(child);
    expect(terminateTree).toHaveBeenCalledOnce();
  });

  it('uses one cleanup-wide snapshot budget and fails when snapshot eight adds an identity', async () => {
    const processes = Array.from({ length: 8 }, (_, index) => ({
      pid: root.pid + index,
      parentPid: index === 0 ? root.parentPid : root.pid + index - 1,
      creationTicks: creationTicks(TEST_NOW_MS + index),
      executableName: index === 0 ? 'cmd.exe' : 'node.exe',
      ...(index === 0 ? { canonicalExecutablePath: root.canonicalExecutablePath } : {}),
    }));
    let snapshotCount = 0;
    const io = {
      snapshot: vi.fn(async () => {
        snapshotCount += 1;
        return {
          status: 'ok' as const,
          processes: processes.slice(0, snapshotCount),
        };
      }),
      terminateTree: vi.fn(async () => 'success' as const),
      terminateExact: vi.fn(() => true),
    } satisfies WindowsProcessTreeIo;
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false, diagnostic: 'snapshot_limit' });
    expect(io.snapshot).toHaveBeenCalledTimes(8);
    expect(io.terminateTree).not.toHaveBeenCalled();
    expect(io.terminateExact).not.toHaveBeenCalled();
  });

  it('fails closed before destructive cleanup when a 257th identity is discovered', async () => {
    const identities = Array.from({ length: 257 }, (_, index) => ({
      pid: index + 100,
      parentPid: index === 0 ? 1 : index + 99,
      creationTicks: creationTicks(TEST_NOW_MS + index),
      executableName: index === 0 ? 'cmd.exe' : 'node.exe',
      ...(index === 0 ? { canonicalExecutablePath: root.canonicalExecutablePath } : {}),
    }));
    const io = ioWithSnapshots([{ status: 'ok', processes: identities }]);
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false, diagnostic: 'identity_limit' });
    expect(io.terminateTree).not.toHaveBeenCalled();
    expect(io.terminateExact).not.toHaveBeenCalled();
  });

  it('does not treat taskkill success as cleanup while a verified descendant survives', async () => {
    const io = ioWithSnapshots(
      [
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [child] },
        { status: 'ok', processes: [child] },
      ],
      'success',
    );
    io.terminateExact.mockReturnValue(false);
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: false });
  });

  it('waits within the shared budget for a successfully terminated identity to become absent', async () => {
    const io = ioWithSnapshots(
      [
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [root, child] },
        { status: 'ok', processes: [child] },
        { status: 'ok', processes: [child] },
        { status: 'ok', processes: [] },
      ],
      'success',
    );
    const cleaner = new WindowsOwnedProcessTreeCleaner(io);

    await expect(
      cleaner.cleanup({
        ...rootRequest,
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({ cleaned: true, diagnostic: 'verified_fallback' });
    expect(io.snapshot).toHaveBeenCalledTimes(5);
  });
});

describe('NodeWindowsProcessTreeIo trusted helper lifecycle', () => {
  it('rejects a snapshot that omits the strict helper identity header', async () => {
    const child = controllableUtility();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(JSON.stringify({ version: 1, status: 'ok', processes: [root] }), 'utf8'),
        );
        child.emit('close', 0);
      });
      return child;
    });
    const io = new NodeWindowsProcessTreeIo(spawnProcess as never);

    await expect(
      io.snapshot({
        rootPid: root.pid,
        rootIdentity: undefined,
        knownIdentities: [],
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        timeoutMs: 100,
      }),
    ).resolves.toMatchObject({ status: 'malformed' });
  });

  it('does not settle a timed-out helper before close and absence are proven', async () => {
    vi.useFakeTimers();
    const child = controllableUtility();
    const io = new NodeWindowsProcessTreeIo(vi.fn(() => child) as never);
    const result = io.snapshot({
      rootPid: root.pid,
      rootIdentity: undefined,
      knownIdentities: [],
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      timeoutMs: 50,
    });
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(45);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    child.emit('close', null);
    await expect(result).resolves.toMatchObject({ status: 'error' });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('routes stderr overflow through the same one-kill helper cleanup path', async () => {
    const child = controllableUtility();
    const io = new NodeWindowsProcessTreeIo(vi.fn(() => child) as never);
    const result = io.snapshot({
      rootPid: root.pid,
      rootIdentity: undefined,
      knownIdentities: [],
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      timeoutMs: 100,
    });

    child.stderr.emit('data', Buffer.alloc(65_537));
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', null);
    await expect(result).resolves.toMatchObject({ status: 'error' });
  });
});
