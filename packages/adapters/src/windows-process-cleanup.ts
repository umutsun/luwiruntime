import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

const MAX_SNAPSHOT_COUNT = 8;
const MAX_OWNED_PROCESS_COUNT = 256;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_EPOCH_TICKS = 621_355_968_000_000_000n;

export type WindowsProcessIdentity = {
  pid: number;
  creationTicks: string;
  parentPid: number;
  executableName: string;
  canonicalExecutablePath?: string;
};

export type WindowsProcessSnapshot =
  | {
      status: 'ok';
      processes: WindowsProcessIdentity[];
      helperIdentity?: WindowsProcessIdentity;
    }
  | {
      status: 'identity_changed';
      processes: WindowsProcessIdentity[];
      helperIdentity?: WindowsProcessIdentity;
    }
  | {
      status: 'error' | 'timeout' | 'malformed' | 'limit' | 'unproven';
      processes: [];
      helperIdentity?: WindowsProcessIdentity;
    };

export interface WindowsProcessSnapshotSession {
  snapshot(input: {
    rootPid: number;
    rootIdentity: WindowsProcessIdentity | undefined;
    knownIdentities: readonly WindowsProcessIdentity[];
    timeoutMs: number;
  }): Promise<WindowsProcessSnapshot>;
  close(timeoutMs: number): Promise<boolean>;
}

export interface WindowsProcessTreeIo {
  openSnapshotSession?(input: {
    powershellPath: string | undefined;
    timeoutMs: number;
  }): Promise<WindowsProcessSnapshotSession | undefined>;
  snapshot(input: {
    rootPid: number;
    rootIdentity: WindowsProcessIdentity | undefined;
    knownIdentities: readonly WindowsProcessIdentity[];
    powershellPath: string | undefined;
    timeoutMs: number;
  }): Promise<WindowsProcessSnapshot>;
  terminateTree(input: {
    rootIdentity: WindowsProcessIdentity;
    taskkillPath: string;
    powershellPath: string | undefined;
    timeoutMs: number;
  }): Promise<'success' | 'nonzero' | 'error' | 'timeout' | 'cleanup'>;
  terminateExact(identity: WindowsProcessIdentity): boolean;
}

export type WindowsProcessCleanupRequest = {
  rootPid: number;
  rootParentPid: number;
  rootExecutableName: string;
  rootSpawnedAtMs: number;
  rootObservedBeforeMs: number;
  rootCanonicalExecutablePath?: string | undefined;
  taskkillPath?: string | undefined;
  powershellPath?: string | undefined;
  timeoutMs: number;
};

export type WindowsProcessCleanupResult = {
  cleaned: boolean;
  diagnostic:
    | 'verified_absent'
    | 'verified_fallback'
    | 'trusted_taskkill_unavailable'
    | 'discovery_failed'
    | 'identity_changed'
    | 'snapshot_limit'
    | 'identity_limit'
    | 'helper_cleanup_failed'
    | 'survivor_remained'
    | 'deadline';
};

type CleanupFailure = Exclude<
  WindowsProcessCleanupResult['diagnostic'],
  'verified_absent' | 'verified_fallback' | 'trusted_taskkill_unavailable' | 'survivor_remained'
>;

type WindowsRootExpectation = {
  pid: number;
  parentPid: number;
  spawnedAfterMs: number;
  observedBeforeMs: number;
  executableName: string;
  canonicalExecutablePath?: string;
};

type WindowsCleanupContext = {
  rootExpectation: WindowsRootExpectation;
  rootIdentity: WindowsProcessIdentity | undefined;
  knownIdentities: Map<number, WindowsProcessIdentity>;
  snapshotCount: number;
  cleanupDeadline: number;
  maximumSnapshots: typeof MAX_SNAPSHOT_COUNT;
  maximumIdentities: typeof MAX_OWNED_PROCESS_COUNT;
};

type FixedPointResult =
  { status: 'stable'; current: Map<number, WindowsProcessIdentity> } | { status: CleanupFailure };

function isPositivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isControlFree(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  );
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function sameIdentity(left: WindowsProcessIdentity, right: WindowsProcessIdentity): boolean {
  return (
    left.pid === right.pid &&
    left.creationTicks === right.creationTicks &&
    left.executableName.toLowerCase() === right.executableName.toLowerCase() &&
    (left.canonicalExecutablePath === undefined ||
      right.canonicalExecutablePath === undefined ||
      sameWindowsPath(left.canonicalExecutablePath, right.canonicalExecutablePath))
  );
}

function ticksToUnixMilliseconds(ticks: string): number | undefined {
  try {
    const value = (BigInt(ticks) - WINDOWS_EPOCH_TICKS) / 10_000n;
    const milliseconds = Number(value);
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  } catch {
    return undefined;
  }
}

function validateIdentity(value: WindowsProcessIdentity): boolean {
  return (
    isPositivePid(value.pid) &&
    Number.isSafeInteger(value.parentPid) &&
    value.parentPid >= 0 &&
    /^\d+$/u.test(value.creationTicks) &&
    ticksToUnixMilliseconds(value.creationTicks) !== undefined &&
    isControlFree(value.executableName, 260) &&
    (value.canonicalExecutablePath === undefined ||
      (isControlFree(value.canonicalExecutablePath, 32_767) &&
        win32.isAbsolute(value.canonicalExecutablePath)))
  );
}

function validatedIdentities(
  identities: readonly WindowsProcessIdentity[],
):
  | { status: 'ok'; identities: WindowsProcessIdentity[] }
  | { status: 'malformed' }
  | { status: 'identity_limit' } {
  if (identities.length > MAX_OWNED_PROCESS_COUNT) return { status: 'identity_limit' };
  const seen = new Set<number>();
  const validated: WindowsProcessIdentity[] = [];
  for (const identity of identities) {
    if (!validateIdentity(identity) || seen.has(identity.pid)) return { status: 'malformed' };
    seen.add(identity.pid);
    validated.push(identity);
  }
  return { status: 'ok', identities: validated };
}

function processDepth(
  identity: WindowsProcessIdentity,
  known: ReadonlyMap<number, WindowsProcessIdentity>,
): number {
  let depth = 0;
  let current = identity;
  const visited = new Set<number>();
  while (!visited.has(current.pid)) {
    visited.add(current.pid);
    const parent = known.get(current.parentPid);
    if (parent === undefined) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

function rootMatchesExpectation(
  identity: WindowsProcessIdentity,
  expectation: WindowsRootExpectation,
): boolean {
  const createdAtMs = ticksToUnixMilliseconds(identity.creationTicks);
  return (
    identity.pid === expectation.pid &&
    identity.parentPid === expectation.parentPid &&
    identity.executableName.toLowerCase() === expectation.executableName.toLowerCase() &&
    createdAtMs !== undefined &&
    createdAtMs >= expectation.spawnedAfterMs &&
    createdAtMs <= expectation.observedBeforeMs &&
    (expectation.canonicalExecutablePath === undefined ||
      (identity.canonicalExecutablePath !== undefined &&
        sameWindowsPath(identity.canonicalExecutablePath, expectation.canonicalExecutablePath)))
  );
}

function mergeSnapshot(
  context: WindowsCleanupContext,
  identities: readonly WindowsProcessIdentity[],
):
  | { status: 'ok'; additions: number; current: Map<number, WindowsProcessIdentity> }
  | { status: 'discovery_failed' | 'identity_changed' | 'identity_limit' } {
  const validation = validatedIdentities(identities);
  if (validation.status === 'malformed') return { status: 'discovery_failed' };
  if (validation.status === 'identity_limit') return { status: 'identity_limit' };

  const rows = new Map(validation.identities.map((identity) => [identity.pid, identity] as const));
  for (const known of context.knownIdentities.values()) {
    const live = rows.get(known.pid);
    if (live !== undefined && !sameIdentity(known, live)) return { status: 'identity_changed' };
  }

  const childrenByParent = new Map<number, WindowsProcessIdentity[]>();
  for (const identity of validation.identities) {
    const children = childrenByParent.get(identity.parentPid) ?? [];
    children.push(identity);
    childrenByParent.set(identity.parentPid, children);
  }

  const current = new Map<number, WindowsProcessIdentity>();
  const queue = [...context.knownIdentities.values()];
  const queued = new Set(queue.map((identity) => identity.pid));
  let additions = 0;
  for (const known of queue) {
    const live = rows.get(known.pid);
    if (live !== undefined) current.set(live.pid, live);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    for (const child of childrenByParent.get(parent.pid) ?? []) {
      const prior = context.knownIdentities.get(child.pid);
      if (prior !== undefined && !sameIdentity(prior, child)) {
        return { status: 'identity_changed' };
      }
      if (prior === undefined) {
        if (context.knownIdentities.size >= context.maximumIdentities) {
          return { status: 'identity_limit' };
        }
        context.knownIdentities.set(child.pid, child);
        additions += 1;
      }
      current.set(child.pid, child);
      if (!queued.has(child.pid)) {
        queued.add(child.pid);
        queue.push(child);
      }
    }
  }

  if (validation.identities.some((identity) => !current.has(identity.pid))) {
    return { status: 'discovery_failed' };
  }
  return { status: 'ok', additions, current };
}

export class WindowsOwnedProcessTreeCleaner {
  constructor(
    private readonly io: WindowsProcessTreeIo,
    private readonly now: () => number = Date.now,
  ) {}

  async cleanup(input: WindowsProcessCleanupRequest): Promise<WindowsProcessCleanupResult> {
    if (
      !isPositivePid(input.rootPid) ||
      !Number.isSafeInteger(input.rootParentPid) ||
      input.rootParentPid < 0 ||
      !isControlFree(input.rootExecutableName, 260) ||
      !Number.isFinite(input.rootSpawnedAtMs) ||
      !Number.isFinite(input.rootObservedBeforeMs) ||
      input.rootObservedBeforeMs < input.rootSpawnedAtMs ||
      input.timeoutMs <= 0
    ) {
      return { cleaned: false, diagnostic: 'discovery_failed' };
    }

    const context: WindowsCleanupContext = {
      rootExpectation: {
        pid: input.rootPid,
        parentPid: input.rootParentPid,
        spawnedAfterMs: input.rootSpawnedAtMs,
        observedBeforeMs: input.rootObservedBeforeMs,
        executableName: input.rootExecutableName,
        ...(input.rootCanonicalExecutablePath === undefined
          ? {}
          : { canonicalExecutablePath: input.rootCanonicalExecutablePath }),
      },
      rootIdentity: undefined,
      knownIdentities: new Map(),
      snapshotCount: 0,
      cleanupDeadline: this.now() + input.timeoutMs,
      maximumSnapshots: MAX_SNAPSHOT_COUNT,
      maximumIdentities: MAX_OWNED_PROCESS_COUNT,
    };

    const runBounded = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      const remaining = context.cleanupDeadline - this.now();
      if (remaining <= 0) return undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), remaining);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const snapshotSession =
      this.io.openSnapshotSession === undefined
        ? undefined
        : await runBounded(() =>
            this.io.openSnapshotSession!({
              powershellPath: input.powershellPath,
              timeoutMs: Math.max(1, context.cleanupDeadline - this.now()),
            }),
          );
    if (this.io.openSnapshotSession !== undefined && snapshotSession === undefined) {
      return { cleaned: false, diagnostic: 'discovery_failed' };
    }

    const takeSnapshot = async (): Promise<WindowsProcessSnapshot | CleanupFailure> => {
      for (;;) {
        if (this.now() >= context.cleanupDeadline) return 'deadline';
        if (context.snapshotCount >= context.maximumSnapshots) return 'snapshot_limit';
        context.snapshotCount += 1;
        const timeoutMs = Math.max(1, context.cleanupDeadline - this.now());
        const snapshot = await runBounded(() =>
          snapshotSession === undefined
            ? this.io.snapshot({
                rootPid: input.rootPid,
                rootIdentity: context.rootIdentity,
                knownIdentities: [...context.knownIdentities.values()],
                powershellPath: input.powershellPath,
                timeoutMs,
              })
            : snapshotSession.snapshot({
                rootPid: input.rootPid,
                rootIdentity: context.rootIdentity,
                knownIdentities: [...context.knownIdentities.values()],
                timeoutMs,
              }),
        );
        if (snapshot === undefined) return 'deadline';
        if (snapshot.status === 'unproven') {
          if (context.snapshotCount >= context.maximumSnapshots) return 'snapshot_limit';
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 10);
            timer.unref();
          });
          continue;
        }
        if (snapshot.status === 'identity_changed') return 'identity_changed';
        if (snapshot.status === 'limit') return 'identity_limit';
        if (snapshot.status === 'timeout') return 'deadline';
        if (snapshot.status !== 'ok') return 'discovery_failed';
        return snapshot;
      }
    };

    const discoverToFixedPoint = async (
      firstSnapshot?: WindowsProcessSnapshot,
      firstAdditions = 0,
    ): Promise<FixedPointResult> => {
      let pending = firstSnapshot;
      let additions = firstAdditions;
      for (;;) {
        if (pending === undefined) {
          const captured = await takeSnapshot();
          if (typeof captured === 'string') return { status: captured };
          pending = captured;
        }
        if (pending.status !== 'ok') return { status: 'discovery_failed' };
        const merged = mergeSnapshot(context, pending.processes);
        if (merged.status !== 'ok') return { status: merged.status };
        additions += merged.additions;
        if (additions === 0) return { status: 'stable', current: merged.current };
        if (context.snapshotCount >= context.maximumSnapshots) {
          return { status: 'snapshot_limit' };
        }
        pending = undefined;
        additions = 0;
      }
    };

    const performCleanup = async (): Promise<WindowsProcessCleanupResult> => {
      const first = await takeSnapshot();
      if (typeof first === 'string') return { cleaned: false, diagnostic: first };
      if (first.status !== 'ok') return { cleaned: false, diagnostic: 'discovery_failed' };
      const firstValidation = validatedIdentities(first.processes);
      if (firstValidation.status === 'identity_limit') {
        return { cleaned: false, diagnostic: 'identity_limit' };
      }
      if (firstValidation.status !== 'ok') {
        return { cleaned: false, diagnostic: 'discovery_failed' };
      }
      const root = firstValidation.identities.find((identity) => identity.pid === input.rootPid);
      if (root === undefined) return { cleaned: false, diagnostic: 'discovery_failed' };
      if (!rootMatchesExpectation(root, context.rootExpectation)) {
        return { cleaned: false, diagnostic: 'identity_changed' };
      }
      context.rootIdentity = root;
      context.knownIdentities.set(root.pid, root);

      const initial = await discoverToFixedPoint(first, 1);
      if (initial.status !== 'stable') return { cleaned: false, diagnostic: initial.status };
      if (input.taskkillPath === undefined) {
        return { cleaned: false, diagnostic: 'trusted_taskkill_unavailable' };
      }

      const matchingRoot = initial.current.get(root.pid);
      if (matchingRoot !== undefined) {
        const treeResult = await runBounded(() =>
          this.io.terminateTree({
            rootIdentity: root,
            taskkillPath: input.taskkillPath!,
            powershellPath: input.powershellPath,
            timeoutMs: Math.max(1, context.cleanupDeadline - this.now()),
          }),
        );
        if (treeResult === undefined) return { cleaned: false, diagnostic: 'deadline' };
        if (treeResult === 'cleanup') {
          return { cleaned: false, diagnostic: 'helper_cleanup_failed' };
        }
      }

      const postTermination = await discoverToFixedPoint();
      if (postTermination.status !== 'stable') {
        return { cleaned: false, diagnostic: postTermination.status };
      }
      const survivors = [...postTermination.current.values()];
      let usedExactFallback = false;
      let everyExactTerminationRequested = true;
      if (survivors.length > 0) {
        survivors.sort(
          (left, right) =>
            processDepth(right, context.knownIdentities) -
            processDepth(left, context.knownIdentities),
        );
        for (const identity of survivors) {
          usedExactFallback = true;
          if (!this.io.terminateExact(identity)) everyExactTerminationRequested = false;
        }
      }

      let final = await discoverToFixedPoint();
      if (final.status !== 'stable') return { cleaned: false, diagnostic: final.status };
      while (final.current.size > 0 && everyExactTerminationRequested) {
        if (
          context.snapshotCount >= context.maximumSnapshots ||
          this.now() >= context.cleanupDeadline
        ) {
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10);
          timer.unref();
        });
        final = await discoverToFixedPoint();
        if (final.status !== 'stable') return { cleaned: false, diagnostic: final.status };
      }
      if (final.current.size > 0) return { cleaned: false, diagnostic: 'survivor_remained' };
      return {
        cleaned: true,
        diagnostic: usedExactFallback ? 'verified_fallback' : 'verified_absent',
      };
    };

    const result = await performCleanup();
    if (snapshotSession !== undefined) {
      const closed = await snapshotSession.close(Math.max(1, context.cleanupDeadline - this.now()));
      if (!closed) return { cleaned: false, diagnostic: 'helper_cleanup_failed' };
    }
    return result;
  }
}

type UtilityRunResult = {
  status: 'success' | 'nonzero' | 'error' | 'timeout' | 'helper_output_limit' | 'cleanup-unproven';
  stdout: string;
  stderr?: string;
};

function parseIdentityRecord(value: unknown): WindowsProcessIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record['pid'] !== 'number' ||
    typeof record['parentPid'] !== 'number' ||
    typeof record['creationTicks'] !== 'string' ||
    typeof record['executableName'] !== 'string' ||
    (record['canonicalExecutablePath'] !== undefined &&
      record['canonicalExecutablePath'] !== null &&
      typeof record['canonicalExecutablePath'] !== 'string')
  ) {
    return undefined;
  }
  const identity: WindowsProcessIdentity = {
    pid: record['pid'],
    parentPid: record['parentPid'],
    creationTicks: record['creationTicks'],
    executableName: record['executableName'],
    ...(typeof record['canonicalExecutablePath'] === 'string'
      ? { canonicalExecutablePath: record['canonicalExecutablePath'] }
      : {}),
  };
  return validateIdentity(identity) ? identity : undefined;
}

function parseHelperIdentity(value: string): WindowsProcessIdentity | undefined {
  const line = value.split(/\r?\n/u)[0];
  if (line === undefined || line.length === 0) return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== 1 || record['kind'] !== 'helper_identity') return undefined;
    return parseIdentityRecord(record['identity']);
  } catch {
    return undefined;
  }
}

function runUtility(
  spawnProcess: typeof spawn,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  captureOutput: boolean,
  expectedHelperPath?: string,
): Promise<UtilityRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnProcess(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', captureOutput ? 'pipe' : 'ignore'],
      });
    } catch {
      resolve({ status: 'error', stdout: '' });
      return;
    }

    let settled = false;
    let terminalCause: 'timeout' | 'helper_output_limit' | undefined;
    let killRequested = false;
    let closeObserved = false;
    let outputBytes = 0;
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    const reserveMs = Math.min(250, Math.max(10, Math.floor(timeoutMs / 10)));

    const stdoutText = (): string => Buffer.concat(output).toString('utf8');
    const stopAcceptingOutput = (): void => {
      child.stdout?.removeListener('data', collectStdout);
      child.stderr?.removeListener('data', collectStderr);
    };
    const finish = (result: UtilityRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(operationTimer);
      clearTimeout(finalTimer);
      stopAcceptingOutput();
      child.removeAllListeners('error');
      child.removeAllListeners('close');
      child.on('error', () => undefined);
      resolve(result);
    };
    const helperIdentityIsProven = (): boolean => {
      if (expectedHelperPath === undefined) return false;
      const identity = parseHelperIdentity(stdoutText());
      return (
        identity?.canonicalExecutablePath !== undefined &&
        sameWindowsPath(identity.canonicalExecutablePath, expectedHelperPath)
      );
    };
    const finishTerminated = (): void => {
      if (terminalCause === undefined || !closeObserved) return;
      finish({
        status: helperIdentityIsProven() ? terminalCause : 'cleanup-unproven',
        stdout: '',
      });
    };
    const requestTermination = (cause: 'timeout' | 'helper_output_limit'): void => {
      if (terminalCause !== undefined || settled) return;
      terminalCause = cause;
      stopAcceptingOutput();
      if (!killRequested) {
        killRequested = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Absence still requires the close event bound to this exact child handle.
        }
      }
      finishTerminated();
    };
    function collectStdout(chunk: Buffer): void {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        requestTermination('helper_output_limit');
        return;
      }
      output.push(chunk);
    }
    function collectStderr(chunk: Buffer): void {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        requestTermination('helper_output_limit');
        return;
      }
      errorOutput.push(chunk);
    }

    const operationTimer = setTimeout(
      () => requestTermination('timeout'),
      Math.max(1, timeoutMs - reserveMs),
    );
    operationTimer.unref();
    const finalTimer = setTimeout(() => {
      if (terminalCause === undefined) requestTermination('timeout');
      finish({ status: 'cleanup-unproven', stdout: '' });
    }, timeoutMs);
    finalTimer.unref();
    child.stdout?.on('data', collectStdout);
    child.stderr?.on('data', collectStderr);
    child.once('error', () => {
      if (terminalCause === undefined) finish({ status: 'error', stdout: '' });
    });
    child.once('close', (code) => {
      closeObserved = true;
      if (terminalCause !== undefined) {
        finishTerminated();
        return;
      }
      finish({
        status: code === 0 ? 'success' : 'nonzero',
        stdout: code === 0 ? stdoutText() : '',
        ...(code === 0 ? {} : { stderr: Buffer.concat(errorOutput).toString('utf8') }),
      });
    });
  });
}

const snapshotScript = (
  rootPid: number,
  rootIdentity: WindowsProcessIdentity | undefined,
  knownIdentities: readonly WindowsProcessIdentity[],
): string => {
  const seedPayload = Buffer.from(
    JSON.stringify({ rootPid, rootIdentity, knownIdentities }),
    'utf8',
  ).toString('base64');
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LuwiProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Entry {
    public uint size; public uint usage; public uint pid; public IntPtr heap; public uint module; public uint threads; public uint parentPid; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string executableName;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Entry[] Capture() {
    var result = new List<Entry>(); var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try { var entry = new Entry(); entry.size=(uint)Marshal.SizeOf(entry); if (!Process32FirstW(snapshot, ref entry)) return result.ToArray();
      do { result.Add(entry); entry.size=(uint)Marshal.SizeOf(entry); } while (Process32NextW(snapshot, ref entry)); return result.ToArray();
    } finally { CloseHandle(snapshot); }
  }
}
"@
function Convert-LuwiIdentity($row){
  try{$process=[System.Diagnostics.Process]::GetProcessById([int]$row.pid);$ticks=$process.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture);$path=$null;try{$path=[string]$process.MainModule.FileName}catch{};return @{pid=[int]$row.pid;parentPid=[int]$row.parentPid;creationTicks=$ticks;executableName=[string]$row.executableName;canonicalExecutablePath=$path}}catch{return $null}
}
function Test-LuwiIdentity($expected,$actual){
  if($null -eq $actual){return $false};if([int]$expected.pid -ne [int]$actual.pid -or [string]$expected.creationTicks -cne [string]$actual.creationTicks -or [string]$expected.executableName -ine [string]$actual.executableName){return $false};if($null -ne $expected.canonicalExecutablePath -and $null -ne $actual.canonicalExecutablePath){return [string]$expected.canonicalExecutablePath -ieq [string]$actual.canonicalExecutablePath};return $true
}
$seedJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${seedPayload}'))
$seedData=$seedJson|ConvertFrom-Json
$rows=[LuwiProcessSnapshot]::Capture()
$rowByPid=@{};$childrenByParent=@{}
foreach($row in $rows){$rowByPid[[uint32]$row.pid]=$row;$parentKey=[uint32]$row.parentPid;if(-not $childrenByParent.ContainsKey($parentKey)){$childrenByParent[$parentKey]=@()};$childrenByParent[$parentKey]=@($childrenByParent[$parentKey])+@($row)}
$selfRow=$rowByPid[[uint32]$PID];$selfIdentity=Convert-LuwiIdentity $selfRow
if($null -eq $selfIdentity){exit 2}
[Console]::Out.WriteLine((@{version=1;kind='helper_identity';identity=$selfIdentity}|ConvertTo-Json -Compress -Depth 4))
$seeds=New-Object 'System.Collections.Generic.List[object]'
if($null -ne $seedData.rootIdentity){$seeds.Add($seedData.rootIdentity)}else{$seeds.Add(@{pid=[int]$seedData.rootPid})}
foreach($known in @($seedData.knownIdentities)){$seeds.Add($known)}
$owned=New-Object 'System.Collections.Generic.HashSet[uint32]'
$queue=New-Object 'System.Collections.Generic.Queue[uint32]'
foreach($seed in $seeds){$pidValue=[uint32]$seed.pid;if($null -ne $seed.creationTicks){$liveRow=$rowByPid[$pidValue];$liveIdentity=if($null -eq $liveRow){$null}else{Convert-LuwiIdentity $liveRow};if($null -ne $liveRow -and $null -eq $liveIdentity){[Console]::Out.Write((@{version=1;kind='process_snapshot';status='unproven';processes=@()}|ConvertTo-Json -Compress -Depth 5));exit 0};if($null -ne $liveIdentity -and -not (Test-LuwiIdentity $seed $liveIdentity)){[Console]::Out.Write((@{version=1;kind='process_snapshot';status='identity_changed';processes=@($liveIdentity)}|ConvertTo-Json -Compress -Depth 5));exit 0}};if($owned.Add($pidValue)){$queue.Enqueue($pidValue)}}
while($queue.Count -gt 0){$parent=$queue.Dequeue();$childRows=$childrenByParent[$parent];if($null -ne $childRows){foreach($childRow in $childRows){if($owned.Add([uint32]$childRow.pid)){$queue.Enqueue([uint32]$childRow.pid);if($owned.Count -gt ${String(MAX_OWNED_PROCESS_COUNT)}){[Console]::Out.Write((@{version=1;kind='process_snapshot';status='limit';processes=@()}|ConvertTo-Json -Compress -Depth 4));exit 0}}}}}
[object[]]$result=@()
foreach($row in $rows){if($owned.Contains([uint32]$row.pid)){$identity=Convert-LuwiIdentity $row;if($null -ne $identity){$result+=@($identity)}}}
[Console]::Out.Write((@{version=1;kind='process_snapshot';status='ok';processes=$result}|ConvertTo-Json -Compress -Depth 5))`;
};

const snapshotServerScript = (): string => `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LuwiProcessSnapshotServer {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Entry {
    public uint size; public uint usage; public uint pid; public IntPtr heap; public uint module; public uint threads; public uint parentPid; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string executableName;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Entry[] Capture() {
    var result = new List<Entry>(); var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try { var entry = new Entry(); entry.size=(uint)Marshal.SizeOf(entry); if (!Process32FirstW(snapshot, ref entry)) return result.ToArray();
      do { result.Add(entry); entry.size=(uint)Marshal.SizeOf(entry); } while (Process32NextW(snapshot, ref entry)); return result.ToArray();
    } finally { CloseHandle(snapshot); }
  }
}
"@
function Convert-LuwiIdentity($row){
  try{$process=[System.Diagnostics.Process]::GetProcessById([int]$row.pid);$ticks=$process.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture);$path=$null;try{$path=[string]$process.MainModule.FileName}catch{};return @{pid=[int]$row.pid;parentPid=[int]$row.parentPid;creationTicks=$ticks;executableName=[string]$row.executableName;canonicalExecutablePath=$path}}catch{return $null}
}
function Test-LuwiIdentity($expected,$actual){
  if($null -eq $actual){return $false};if([int]$expected.pid -ne [int]$actual.pid -or [string]$expected.creationTicks -cne [string]$actual.creationTicks -or [string]$expected.executableName -ine [string]$actual.executableName){return $false};if($null -ne $expected.canonicalExecutablePath -and $null -ne $actual.canonicalExecutablePath){return [string]$expected.canonicalExecutablePath -ieq [string]$actual.canonicalExecutablePath};return $true
}
function New-LuwiResult($status,$processes){return (@{version=1;kind='process_snapshot';status=$status;processes=@($processes)}|ConvertTo-Json -Compress -Depth 5)}
function Invoke-LuwiSnapshot($seedData){
  $rows=[LuwiProcessSnapshotServer]::Capture();$rowByPid=@{};$childrenByParent=@{}
  foreach($row in $rows){$rowByPid[[uint32]$row.pid]=$row;$parentKey=[uint32]$row.parentPid;if(-not $childrenByParent.ContainsKey($parentKey)){$childrenByParent[$parentKey]=@()};$childrenByParent[$parentKey]=@($childrenByParent[$parentKey])+@($row)}
  $seeds=New-Object 'System.Collections.Generic.List[object]'
  if($null -ne $seedData.rootIdentity){$seeds.Add($seedData.rootIdentity)}else{$seeds.Add(@{pid=[int]$seedData.rootPid})}
  foreach($known in @($seedData.knownIdentities)){$seeds.Add($known)}
  $owned=New-Object 'System.Collections.Generic.HashSet[uint32]';$queue=New-Object 'System.Collections.Generic.Queue[uint32]'
  foreach($seed in $seeds){$pidValue=[uint32]$seed.pid;if($null -ne $seed.creationTicks){$liveRow=$rowByPid[$pidValue];$liveIdentity=if($null -eq $liveRow){$null}else{Convert-LuwiIdentity $liveRow};if($null -ne $liveRow -and $null -eq $liveIdentity){return (New-LuwiResult 'unproven' @())};if($null -ne $liveIdentity -and -not (Test-LuwiIdentity $seed $liveIdentity)){return (New-LuwiResult 'identity_changed' @($liveIdentity))}};if($owned.Add($pidValue)){$queue.Enqueue($pidValue)}}
  while($queue.Count -gt 0){$parent=$queue.Dequeue();$childRows=$childrenByParent[$parent];if($null -ne $childRows){foreach($childRow in $childRows){if($owned.Add([uint32]$childRow.pid)){$queue.Enqueue([uint32]$childRow.pid);if($owned.Count -gt ${String(MAX_OWNED_PROCESS_COUNT)}){return (New-LuwiResult 'limit' @())}}}}}
  [object[]]$result=@();foreach($row in $rows){if($owned.Contains([uint32]$row.pid)){$identity=Convert-LuwiIdentity $row;if($null -ne $identity){$result+=@($identity)}}}
  return (New-LuwiResult 'ok' $result)
}
$initialRows=[LuwiProcessSnapshotServer]::Capture();$selfRow=$initialRows|Where-Object {$_.pid -eq [uint32]$PID}|Select-Object -First 1;$selfIdentity=Convert-LuwiIdentity $selfRow
if($null -eq $selfIdentity){exit 2}
[Console]::Out.WriteLine((@{version=1;kind='helper_identity';identity=$selfIdentity}|ConvertTo-Json -Compress -Depth 4));[Console]::Out.Flush()
while($true){
  $line=[Console]::In.ReadLine();if($null -eq $line -or $line -eq 'close'){break}
  try{$seedJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line));$seedData=$seedJson|ConvertFrom-Json;$response=Invoke-LuwiSnapshot $seedData}catch{$response=New-LuwiResult 'error' @()}
  [Console]::Out.WriteLine($response);[Console]::Out.Flush()
}`;

class NodeWindowsProcessSnapshotSession implements WindowsProcessSnapshotSession {
  readonly #child: ReturnType<typeof spawn>;
  readonly #expectedHelperPath: string;
  readonly #ready: Promise<boolean>;
  readonly #closed: Promise<void>;
  #resolveReady: ((ready: boolean) => void) | undefined;
  #resolveClosed: (() => void) | undefined;
  #helperLine: string | undefined;
  #buffer = '';
  #outputBytes = 0;
  #didClose = false;
  #killRequested = false;
  #pending:
    | {
        resolve: (snapshot: WindowsProcessSnapshot) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(child: ReturnType<typeof spawn>, expectedHelperPath: string) {
    this.#child = child;
    this.#expectedHelperPath = expectedHelperPath;
    this.#ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    this.#closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    child.stdout?.on('data', (chunk: Buffer) => this.#acceptOutput(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.#acceptErrorOutput(chunk));
    child.once('error', () => this.#handleClose());
    child.once('close', () => this.#handleClose());
  }

  async initialize(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const ready = await Promise.race([
      this.#ready,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (ready) return true;
    await this.close(Math.max(1, Math.min(250, timeoutMs)));
    return false;
  }

  async snapshot(input: {
    rootPid: number;
    rootIdentity: WindowsProcessIdentity | undefined;
    knownIdentities: readonly WindowsProcessIdentity[];
    timeoutMs: number;
  }): Promise<WindowsProcessSnapshot> {
    if (
      this.#didClose ||
      this.#pending !== undefined ||
      !isPositivePid(input.rootPid) ||
      input.knownIdentities.length > MAX_OWNED_PROCESS_COUNT ||
      input.knownIdentities.some((identity) => !validateIdentity(identity)) ||
      (input.rootIdentity !== undefined && !validateIdentity(input.rootIdentity)) ||
      this.#child.stdin === null
    ) {
      return { status: 'malformed', processes: [] };
    }
    const payload = Buffer.from(
      JSON.stringify({
        rootPid: input.rootPid,
        rootIdentity: input.rootIdentity,
        knownIdentities: input.knownIdentities,
      }),
      'utf8',
    ).toString('base64');
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending === undefined) return;
        this.#pending = undefined;
        void this.#terminate().then((closed) =>
          resolve({ status: closed ? 'timeout' : 'error', processes: [] }),
        );
      }, input.timeoutMs);
      timer.unref();
      this.#pending = { resolve, timer };
      this.#child.stdin!.write(`${payload}\n`, (error) => {
        if (error === null || this.#pending === undefined) return;
        clearTimeout(this.#pending.timer);
        this.#pending = undefined;
        resolve({ status: 'error', processes: [] });
      });
    });
  }

  async close(timeoutMs: number): Promise<boolean> {
    if (this.#didClose) return this.#helperLine !== undefined;
    const deadline = Date.now() + timeoutMs;
    try {
      this.#child.stdin?.end('close\n');
    } catch {
      // Fall through to exact handle termination.
    }
    if (await this.#waitForClose(Math.max(1, Math.floor(timeoutMs / 2)))) {
      return this.#helperLine !== undefined;
    }
    const closed = await this.#terminate(Math.max(1, deadline - Date.now()));
    return closed && this.#helperLine !== undefined;
  }

  #acceptOutput(chunk: Buffer): void {
    this.#outputBytes += chunk.byteLength;
    if (this.#outputBytes > MAX_HELPER_OUTPUT_BYTES) {
      void this.#terminate();
      this.#settlePending({ status: 'error', processes: [] });
      return;
    }
    this.#buffer += chunk.toString('utf8');
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (this.#helperLine === undefined) {
        const identity = parseHelperIdentity(line);
        if (
          identity?.canonicalExecutablePath === undefined ||
          !sameWindowsPath(identity.canonicalExecutablePath, this.#expectedHelperPath)
        ) {
          this.#resolveReady?.(false);
          this.#resolveReady = undefined;
          void this.#terminate();
          return;
        }
        this.#helperLine = line;
        this.#resolveReady?.(true);
        this.#resolveReady = undefined;
        continue;
      }
      if (this.#pending !== undefined) {
        this.#settlePending(
          parseSnapshot(`${this.#helperLine}\n${line}`, this.#expectedHelperPath),
        );
      }
    }
  }

  #acceptErrorOutput(chunk: Buffer): void {
    this.#outputBytes += chunk.byteLength;
    if (this.#outputBytes > MAX_HELPER_OUTPUT_BYTES) {
      void this.#terminate();
      this.#settlePending({ status: 'error', processes: [] });
    }
  }

  #settlePending(snapshot: WindowsProcessSnapshot): void {
    if (this.#pending === undefined) return;
    const pending = this.#pending;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(snapshot);
  }

  #handleClose(): void {
    if (this.#didClose) return;
    this.#didClose = true;
    this.#resolveReady?.(false);
    this.#resolveReady = undefined;
    this.#settlePending({ status: 'error', processes: [] });
    this.#resolveClosed?.();
    this.#resolveClosed = undefined;
  }

  async #terminate(timeoutMs = 250): Promise<boolean> {
    if (!this.#killRequested && !this.#didClose) {
      this.#killRequested = true;
      try {
        this.#child.kill('SIGKILL');
      } catch {
        // Close evidence below controls the result.
      }
    }
    return await this.#waitForClose(timeoutMs);
  }

  async #waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.#didClose) return true;
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      this.#closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return closed;
  }
}

function parseSnapshot(value: string, expectedHelperPath: string): WindowsProcessSnapshot {
  const lines = value.trimEnd().split(/\r?\n/u);
  if (lines.length !== 2) return { status: 'malformed', processes: [] };
  const helperIdentity = parseHelperIdentity(lines[0]!);
  if (
    helperIdentity?.canonicalExecutablePath === undefined ||
    !sameWindowsPath(helperIdentity.canonicalExecutablePath, expectedHelperPath)
  ) {
    return { status: 'malformed', processes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[1]!);
  } catch {
    return { status: 'malformed', processes: [] };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'malformed', processes: [] };
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1 || record['kind'] !== 'process_snapshot') {
    return { status: 'malformed', processes: [] };
  }
  if (record['status'] === 'limit') return { status: 'limit', processes: [], helperIdentity };
  if (record['status'] === 'unproven') {
    return { status: 'unproven', processes: [], helperIdentity };
  }
  if (
    (record['status'] !== 'ok' && record['status'] !== 'identity_changed') ||
    !Array.isArray(record['processes'])
  ) {
    return { status: 'malformed', processes: [] };
  }
  const processes: WindowsProcessIdentity[] = [];
  for (const item of record['processes']) {
    const identity = parseIdentityRecord(item);
    if (identity === undefined) return { status: 'malformed', processes: [] };
    processes.push(identity);
  }
  const validated = validatedIdentities(processes);
  if (validated.status === 'identity_limit') {
    return { status: 'limit', processes: [], helperIdentity };
  }
  return validated.status === 'ok'
    ? {
        status: record['status'],
        processes: validated.identities,
        helperIdentity,
      }
    : { status: 'malformed', processes: [] };
}

export class NodeWindowsProcessTreeIo implements WindowsProcessTreeIo {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  async openSnapshotSession(input: {
    powershellPath: string | undefined;
    timeoutMs: number;
  }): Promise<WindowsProcessSnapshotSession | undefined> {
    if (input.powershellPath === undefined || input.timeoutMs <= 0) return undefined;
    const encoded = Buffer.from(snapshotServerScript(), 'utf16le').toString('base64');
    let child: ReturnType<typeof spawn>;
    try {
      child = this.spawnProcess(
        input.powershellPath,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded,
        ],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      return undefined;
    }
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The uninitialized helper is already absent.
      }
      return undefined;
    }
    const session = new NodeWindowsProcessSnapshotSession(child, input.powershellPath);
    return (await session.initialize(input.timeoutMs)) ? session : undefined;
  }

  async snapshot(input: {
    rootPid: number;
    rootIdentity: WindowsProcessIdentity | undefined;
    knownIdentities: readonly WindowsProcessIdentity[];
    powershellPath: string | undefined;
    timeoutMs: number;
  }): Promise<WindowsProcessSnapshot> {
    if (input.powershellPath === undefined) return { status: 'error', processes: [] };
    if (
      !isPositivePid(input.rootPid) ||
      input.knownIdentities.length > MAX_OWNED_PROCESS_COUNT ||
      input.knownIdentities.some((identity) => !validateIdentity(identity)) ||
      (input.rootIdentity !== undefined && !validateIdentity(input.rootIdentity))
    ) {
      return { status: 'malformed', processes: [] };
    }
    const encoded = Buffer.from(
      snapshotScript(input.rootPid, input.rootIdentity, input.knownIdentities),
      'utf16le',
    ).toString('base64');
    const result = await runUtility(
      this.spawnProcess,
      input.powershellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded,
      ],
      input.timeoutMs,
      true,
      input.powershellPath,
    );
    if (result.status === 'timeout') return { status: 'timeout', processes: [] };
    if (result.status !== 'success') return { status: 'error', processes: [] };
    return parseSnapshot(result.stdout, input.powershellPath);
  }

  async terminateTree(input: {
    rootIdentity: WindowsProcessIdentity;
    taskkillPath: string;
    powershellPath: string | undefined;
    timeoutMs: number;
  }): Promise<'success' | 'nonzero' | 'error' | 'timeout' | 'cleanup'> {
    const result = await runUtility(
      this.spawnProcess,
      input.taskkillPath,
      ['/PID', String(input.rootIdentity.pid), '/T', '/F'],
      input.timeoutMs,
      false,
    );
    if (result.status === 'cleanup-unproven') return 'cleanup';
    if (result.status === 'helper_output_limit') return 'error';
    return result.status;
  }

  terminateExact(identity: WindowsProcessIdentity): boolean {
    try {
      return process.kill(identity.pid, 'SIGKILL');
    } catch {
      return false;
    }
  }
}
