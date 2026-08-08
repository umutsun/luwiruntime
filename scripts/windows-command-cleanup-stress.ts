import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SpawnCommandRunner,
  resolveTrustedWindowsUtilities,
} from '../packages/adapters/src/node-collaborators.js';
import {
  NodeWindowsProcessTreeIo,
  WindowsOwnedProcessTreeCleaner,
  type WindowsProcessCleanupResult,
  type WindowsProcessIdentity,
  type WindowsProcessSnapshot,
  type WindowsProcessSnapshotSession,
} from '../packages/adapters/src/windows-process-cleanup.js';
import type { AdapterCommandResult } from '../packages/adapters/src/types.js';

const DEFAULT_ITERATIONS = 25;
const requestedIterations =
  process.argv[2] === undefined ? DEFAULT_ITERATIONS : Number(process.argv[2]);
if (
  process.platform !== 'win32' ||
  !Number.isSafeInteger(requestedIterations) ||
  requestedIterations < DEFAULT_ITERATIONS ||
  requestedIterations > 100
) {
  throw new Error('Windows cleanup stress requires Windows and an iteration count from 25 to 100.');
}

type OwnedProcesses = { rootPid: number; descendantPid: number };
type IdentityState = 'same' | 'absent' | 'reused' | 'unproven';
type IterationEvidence = {
  iteration: number;
  rootIdentity: WindowsProcessIdentity;
  descendantIdentities: WindowsProcessIdentity[];
  raceObservedAtMs: number;
  runnerPendingWhenObserved: boolean;
  productionCleanupResult: WindowsProcessCleanupResult | undefined;
  runnerResult: AdapterCommandResult | undefined;
  finalAbsence: boolean;
  testEmergencyCleanupRequired: boolean;
  testEmergencyCleanupResult: 'unused' | 'verified_absent' | 'failed';
};

function isPositivePid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameIdentity(expected: WindowsProcessIdentity, actual: WindowsProcessIdentity): boolean {
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
    if (rendered.split(token).length !== expectedOccurrences + 1) {
      throw new Error(
        `Fixture token ${token} did not occur exactly ${String(expectedOccurrences)} times.`,
      );
    }
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readOwnedProcesses(path: string): Promise<OwnedProcesses> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as OwnedProcesses;
      if (isPositivePid(parsed.rootPid) && isPositivePid(parsed.descendantPid)) return parsed;
    } catch {
      // The fixture writes this test-owned evidence atomically enough for bounded retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not provide valid process evidence within 2,000 ms.');
}

async function inspectIdentities(
  identities: readonly WindowsProcessIdentity[],
  capture: (
    root: WindowsProcessIdentity,
    known: readonly WindowsProcessIdentity[],
  ) => Promise<WindowsProcessSnapshot>,
): Promise<Map<number, IdentityState>> {
  const states = new Map<number, IdentityState>();
  const root = identities[0];
  if (root === undefined) return states;
  const snapshot = await capture(root, identities);
  if (snapshot.status === 'ok') {
    const live = new Map(snapshot.processes.map((identity) => [identity.pid, identity] as const));
    for (const identity of identities) {
      const actual = live.get(identity.pid);
      states.set(
        identity.pid,
        actual === undefined ? 'absent' : sameIdentity(identity, actual) ? 'same' : 'reused',
      );
    }
    return states;
  }
  if (snapshot.status === 'identity_changed') {
    if (identities.length === 1) {
      states.set(root.pid, 'reused');
      return states;
    }
    for (const identity of identities) {
      const single = await inspectIdentities([identity], capture);
      states.set(identity.pid, single.get(identity.pid) ?? 'unproven');
    }
    return states;
  }
  for (const identity of identities) states.set(identity.pid, 'unproven');
  return states;
}

async function captureTestOwnedIdentity(
  io: NodeWindowsProcessTreeIo,
  powershellPath: string,
  pid: number,
): Promise<WindowsProcessIdentity | undefined> {
  const snapshot = await io.snapshot({
    rootPid: pid,
    rootIdentity: undefined,
    knownIdentities: [],
    powershellPath,
    timeoutMs: 2_000,
  });
  return snapshot.status === 'ok'
    ? snapshot.processes.find((identity) => identity.pid === pid)
    : undefined;
}

async function emergencyCleanup(
  io: NodeWindowsProcessTreeIo,
  powershellPath: string,
  identities: readonly WindowsProcessIdentity[],
): Promise<'unused' | 'verified_absent' | 'failed'> {
  if (identities.length === 0) return 'unused';
  const capture = async (root: WindowsProcessIdentity, known: readonly WindowsProcessIdentity[]) =>
    await io.snapshot({
      rootPid: root.pid,
      rootIdentity: root,
      knownIdentities: known,
      powershellPath,
      timeoutMs: 2_000,
    });
  const before = await inspectIdentities(identities, capture);
  const live = identities.filter((identity) => before.get(identity.pid) === 'same');
  if (live.length === 0) {
    return [...before.values()].every((state) => state !== 'unproven') ? 'unused' : 'failed';
  }
  for (const identity of live) io.terminateExact(identity);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const after = await inspectIdentities(identities, capture);
    if ([...after.values()].every((state) => state === 'absent' || state === 'reused')) {
      return 'verified_absent';
    }
    if ([...after.values()].some((state) => state === 'unproven')) return 'failed';
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 'failed';
}

const template = await readFile(
  join(process.cwd(), 'packages', 'adapters', 'test-fixtures', 'windows', 'early-root-close.cmd'),
  'utf8',
);
const trustedUtilities = await resolveTrustedWindowsUtilities();
if (trustedUtilities.powershellPath === undefined) {
  throw new Error('Canonical Windows PowerShell is unavailable.');
}

const evidence: IterationEvidence[] = [];
for (let iteration = 1; iteration <= requestedIterations; iteration += 1) {
  const directory = await mkdtemp(join(tmpdir(), `luwi-cleanup-stress-${String(iteration)}-`));
  const fixture = join(directory, `early-root-${String(iteration)}.cmd`);
  const pidPath = join(directory, `owned-${String(iteration)}.json`);
  const rootReleasePath = join(directory, `release-root-${String(iteration)}`);
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
  let owned: OwnedProcesses | undefined;
  let rootIdentity: WindowsProcessIdentity | undefined;
  let descendantIdentity: WindowsProcessIdentity | undefined;
  let activeSession: WindowsProcessSnapshotSession | undefined;
  let productionCleanupResult: WindowsProcessCleanupResult | undefined;
  let runnerResult: AdapterCommandResult | undefined;
  let runnerSettled = false;
  let runnerPendingWhenObserved = false;
  let raceObservedAtMs = 0;
  let finalAbsence: boolean;
  const snapshotTrace: Array<{
    status: WindowsProcessSnapshot['status'];
    processes: WindowsProcessIdentity[];
  }> = [];
  let testEmergencyCleanupRequired = false;
  let testEmergencyCleanupResult: IterationEvidence['testEmergencyCleanupResult'] = 'unused';
  let releaseTermination: (() => void) | undefined;
  let reachedTermination: (() => void) | undefined;
  const terminationReached = new Promise<void>((resolve) => {
    reachedTermination = resolve;
  });
  const terminationRelease = new Promise<void>((resolve) => {
    releaseTermination = resolve;
  });
  const observe = <T extends WindowsProcessSnapshot>(snapshot: T): T => {
    snapshotTrace.push({ status: snapshot.status, processes: [...snapshot.processes] });
    if (snapshot.status === 'ok' && owned !== undefined) {
      rootIdentity ??= snapshot.processes.find((identity) => identity.pid === owned!.rootPid);
      descendantIdentity ??= snapshot.processes.find(
        (identity) => identity.pid === owned!.descendantPid,
      );
    }
    return snapshot;
  };
  const cleaner = new WindowsOwnedProcessTreeCleaner({
    openSnapshotSession: async (request) => {
      const session = await nodeIo.openSnapshotSession(request);
      activeSession = session;
      return session === undefined
        ? undefined
        : {
            snapshot: async (request) => observe(await session.snapshot(request)),
            close: async (timeoutMs) => await session.close(timeoutMs),
          };
    },
    snapshot: async (request) => observe(await nodeIo.snapshot(request)),
    terminateTree: async () => {
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
  const runnerPromise = runner.run(fixture, ['--version']).finally(() => {
    runnerSettled = true;
  });

  try {
    owned = await readOwnedProcesses(pidPath);
    await Promise.race([
      terminationReached,
      runnerPromise.then(() => {
        throw new Error('Runner settled before the production termination gate.');
      }),
    ]);
    if (
      activeSession === undefined ||
      rootIdentity === undefined ||
      descendantIdentity === undefined
    ) {
      throw new Error('Production cleanup did not capture exact root and descendant identities.');
    }
    const raceDeadline = Date.now() + 2_000;
    while (Date.now() < raceDeadline) {
      const states = await inspectIdentities(
        [rootIdentity, descendantIdentity],
        async (root, known) =>
          await activeSession!.snapshot({
            rootPid: root.pid,
            rootIdentity: root,
            knownIdentities: known,
            timeoutMs: 1_000,
          }),
      );
      runnerPendingWhenObserved = !runnerSettled;
      if (
        states.get(rootIdentity.pid) !== 'same' &&
        states.get(rootIdentity.pid) !== 'unproven' &&
        states.get(descendantIdentity.pid) === 'same' &&
        runnerPendingWhenObserved
      ) {
        raceObservedAtMs = Date.now();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (raceObservedAtMs === 0) {
      throw new Error(
        'Did not observe exact root absence, exact descendant liveness, and pending runner.',
      );
    }

    releaseTermination?.();
    runnerResult = await withTimeout(runnerPromise, 10_000, 'Runner exceeded 10,000 ms.');
    if (runnerResult.failure !== 'timeout' || productionCleanupResult?.cleaned !== true) {
      process.stdout.write(
        `${JSON.stringify({ iteration, phase: 'production_cleanup_failure', owned, rootIdentity, descendantIdentity, productionCleanupResult, runnerResult, snapshotTrace })}\n`,
      );
      throw new Error(
        `Production cleanup failed: ${runnerResult.failure ?? 'no failure'} / ${productionCleanupResult?.diagnostic ?? 'no diagnostic'}.`,
      );
    }
    const finalStates = await inspectIdentities(
      [rootIdentity, descendantIdentity],
      async (root, known) =>
        await nodeIo.snapshot({
          rootPid: root.pid,
          rootIdentity: root,
          knownIdentities: known,
          powershellPath: trustedUtilities.powershellPath,
          timeoutMs: 2_000,
        }),
    );
    finalAbsence = [...finalStates.values()].every(
      (state) => state === 'absent' || state === 'reused',
    );
    if (!finalAbsence) throw new Error('Final exact identity absence was not proven.');

    const iterationEvidence: IterationEvidence = {
      iteration,
      rootIdentity,
      descendantIdentities: [descendantIdentity],
      raceObservedAtMs,
      runnerPendingWhenObserved,
      productionCleanupResult,
      runnerResult,
      finalAbsence,
      testEmergencyCleanupRequired,
      testEmergencyCleanupResult,
    };
    evidence.push(iterationEvidence);
    process.stdout.write(`${JSON.stringify(iterationEvidence)}\n`);
  } finally {
    releaseTermination?.();
    runnerResult ??= await withTimeout(
      runnerPromise,
      10_000,
      'Runner cleanup did not settle.',
    ).catch(() => undefined);
    if (owned !== undefined && descendantIdentity === undefined) {
      descendantIdentity = await captureTestOwnedIdentity(
        nodeIo,
        trustedUtilities.powershellPath,
        owned.descendantPid,
      );
    }
    if (owned !== undefined && rootIdentity === undefined) {
      rootIdentity = await captureTestOwnedIdentity(
        nodeIo,
        trustedUtilities.powershellPath,
        owned.rootPid,
      );
    }
    const cleanupIdentities = [rootIdentity, descendantIdentity].filter(
      (identity): identity is WindowsProcessIdentity => identity !== undefined,
    );
    testEmergencyCleanupResult = await emergencyCleanup(
      nodeIo,
      trustedUtilities.powershellPath,
      cleanupIdentities,
    );
    testEmergencyCleanupRequired = testEmergencyCleanupResult === 'verified_absent';
    await rm(directory, { recursive: true, force: true });
  }
  if (testEmergencyCleanupRequired || testEmergencyCleanupResult === 'failed') {
    throw new Error(
      `Iteration ${String(iteration)} required emergency cleanup or could not prove cleanup.`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify({ iterations: evidence.length, raceObserved: evidence.filter((item) => item.raceObservedAtMs > 0).length, cleanupFailures: evidence.filter((item) => item.productionCleanupResult?.cleaned !== true).length, emergencyCleanupUses: evidence.filter((item) => item.testEmergencyCleanupRequired).length, survivingFixtureProcesses: evidence.filter((item) => !item.finalAbsence).length })}\n`,
);
