# Phase 5B Fourth Blocker Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Phase 5B Windows cleanup blockers with bounded fixed-point discovery, identity-verified ownership, canonical helper termination, deterministic race evidence, and fail-closed settlement.

**Architecture:** Keep the remediation inside the existing adapters boundary. Refine the internal Windows process identity and `WindowsProcessTreeIo` contracts, make `WindowsOwnedProcessTreeCleaner` own one deadline and one eight-snapshot counter, and retain `SpawnCommandRunner` as the sole command-probe settlement path. Use only fixed repository-owned Windows helpers through canonical absolute System32 paths with `shell: false`; no new package, datastore, dependency, or general process-management API is introduced.

**Tech Stack:** Node.js 22+, strict TypeScript ESM, Node `child_process`, fixed encoded Windows PowerShell/Toolhelp32 process evidence, canonical System32 `cmd.exe` and `taskkill.exe`, Vitest 4, pnpm 11, and a source-controlled Windows `.cmd` fixture.

## Global Constraints

- Work only from the approved specification: `docs/superpowers/specs/2026-08-05-phase-5b-fourth-blocker-remediation-design.md`.
- Preserve the local-only, dependency-independent adapters architecture; add no dependency, package, datastore, native addon, or package boundary.
- Maximum process-table snapshots: **8 total per cleanup**, shared across initial discovery, pre-termination revalidation, post-taskkill discovery, survivor revalidation, and final verification.
- Maximum owned identities: **256 total per cleanup**; the 257th candidate fails cleanup.
- Version-probe execution deadline: **2,500 ms**.
- One process-tree cleanup deadline: **5,000 ms total**; helper calls and discovery phases never multiply it.
- Version-probe stdout and stderr limits: **65,536 bytes each, independently**.
- Trusted-helper captured output limit: **65,536 bytes combined**.
- Stress proof: **25 iterations**, and every iteration must observe root-identity absent, descendant identity alive, and runner pending.
- Windows-focused proof: **10 consecutive complete passes**, zero failure, zero silent skip/early return on Windows, and zero orphan.
- Test PID-file acquisition: **2,000 ms**; race observation: **2,000 ms**; per-iteration outer bound: **10,000 ms**; emergency exact-identity absence wait: **2,000 ms**.
- Initial discovery failure, malformed evidence, missing/mismatched root identity, identity reuse, budget exhaustion, or unproven absence returns `failure: cleanup` without `/T`, exact fallback, or background cleanup.
- Preserve canonical absolute System32 utility resolution, fixed arguments, `shell: false`, no ambient `PATH`, no bare utility, no `where.exe`, no image-name kill, and no caller-provided PowerShell script.
- Dashboard inspector work remains excluded under the approved specification's Option B evidence unless new contrary source or independent-test evidence is discovered.
- During implementation do not stage, commit, branch, tag, push, merge, reset, stash, clean, create a checkpoint, begin Phase 5C, or begin ACP/Goose work.

---

## Frozen Baseline and Source Audit

### Frozen state revalidated before this plan

| Check                            | Frozen value                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                           | `master`                                                                                                                                                                                                                    |
| HEAD                             | `31c4f54cc8fd2902d3c301dcc577e67002418a8b`                                                                                                                                                                                  |
| `merge-base HEAD master`         | `31c4f54cc8fd2902d3c301dcc577e67002418a8b`                                                                                                                                                                                  |
| Existing tags                    | `phase-1-projects-sessions` only                                                                                                                                                                                            |
| Checkpoint/Phase 5 branch or tag | none                                                                                                                                                                                                                        |
| Staged paths                     | `0`                                                                                                                                                                                                                         |
| Modified tracked paths           | `43`                                                                                                                                                                                                                        |
| Untracked files with `-uall`     | `174` before this plan; this plan becomes the 175th untracked file                                                                                                                                                          |
| `pnpm-lock.yaml` SHA-256         | `79a62b422430f9197dc8421d7eb400a182ba7fc2a9d69b782ae319a828ff1072`                                                                                                                                                          |
| Active LUWI sessions             | `[]`                                                                                                                                                                                                                        |
| Presence keys                    | `0`                                                                                                                                                                                                                         |
| `luwi:v1:runtime:daemon-owner`   | absent                                                                                                                                                                                                                      |
| Claim/lease/lock keys            | none                                                                                                                                                                                                                        |
| Path/file claim keys             | none                                                                                                                                                                                                                        |
| Worktree keys                    | only the operational-graph index/node `luwi:v1:graph:generation:initial:index:nodes:worktree` and `luwi:v1:graph:generation:initial:node:worktree:worktree-b42f026905f2ef0aaebc243fe88784d7`; neither is an ownership claim |
| Spec/plan ownership              | no active LUWI session or ownership key claims either path                                                                                                                                                                  |

The implementation session must repeat these read-only checks before changing tests. Any ownership change is a stop condition.

### Current source regions and exact symbols

| File and current region                                        | Current symbol/behavior                                                                                                       | Planned role                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/adapters/src/windows-process-cleanup.ts:3-30`        | `MAX_OWNED_PROCESS_COUNT`, `MAX_HELPER_OUTPUT_BYTES`, `WindowsOwnedProcess`, `WindowsProcessSnapshot`, `WindowsProcessTreeIo` | Rename/refine the internal identity shape, carry canonical executable evidence, and make snapshot/termination inputs identity-aware.                                                                                                           |
| `packages/adapters/src/windows-process-cleanup.ts:54-119`      | `isPositivePid`, `sameIdentity`, `ticksToUnixMilliseconds`, `processDepth`, `validatedProcesses`                              | Validate PID/parent/ticks/name/path, distinguish reuse, compute exact-fallback depth, and centralize identity matching.                                                                                                                        |
| `packages/adapters/src/windows-process-cleanup.ts:121-258`     | `WindowsOwnedProcessTreeCleaner.cleanup`                                                                                      | Replace the current initial/after/final three-snapshot flow with one cleanup context and bounded fixed-point phases. Remove the current unsafe `/T` call after failed initial discovery.                                                       |
| `packages/adapters/src/windows-process-cleanup.ts:261-334`     | `UtilityRunResult`, `runUtility`                                                                                              | Replace immediate timeout/output settlement with one identity-aware helper termination path that waits for close and absence within the original deadline. Fix stderr overflow, which currently settles without killing the helper.            |
| `packages/adapters/src/windows-process-cleanup.ts:336-416`     | `snapshotScript`, `parseSnapshot`                                                                                             | Queue root plus every known identity before local traversal, emit a strict helper-identity header, preserve dead-parent seeds, validate reuse, and parse strict bounded evidence.                                                              |
| `packages/adapters/src/windows-process-cleanup.ts:418-479`     | `NodeWindowsProcessTreeIo.snapshot`, `.terminateTree`, `.terminateExact`                                                      | Continue using canonical PowerShell/taskkill with fixed arguments and `shell: false`; route their terminal causes through canonical helper termination and keep exact PID kill subordinate to immediate identity revalidation and final proof. |
| `packages/adapters/src/windows-process-cleanup.test.ts:9-37`   | root/child/grandchild fixtures and `ioWithSnapshots`                                                                          | Retain this narrow sequence seam, upgrading fixtures and requests to exact identities.                                                                                                                                                         |
| `packages/adapters/src/windows-process-cleanup.test.ts:39-230` | cleaner success/fallback/discovery/reuse/deadline tests                                                                       | Add fixed-point, global-budget, 257th identity, root gate, helper lifecycle, and final-proof regressions; correct the current expectation that initial discovery failure invokes `terminateTree`.                                              |
| `packages/adapters/src/node-collaborators.ts:17-21`            | probe/output/cleanup constants                                                                                                | Preserve 2,500/65,536/5,000 exact bounds.                                                                                                                                                                                                      |
| `packages/adapters/src/node-collaborators.ts:34-141`           | `TrustedWindowsUtilities`, `resolveTrustedWindowsUtilities`                                                                   | Preserve canonical System32 resolution unchanged except for passing canonical executable evidence into cleanup.                                                                                                                                |
| `packages/adapters/src/node-collaborators.ts:143-169`          | `killProcessSafely`, `SpawnCommandRunnerOptions`                                                                              | Prefer the existing `spawnProcess` and `windowsProcessCleanup` seams; add no general caller-controlled process-table or utility seam.                                                                                                          |
| `packages/adapters/src/node-collaborators.ts:222-415`          | `SpawnCommandRunner.run`, `settle`, `terminate`, `collect`, `onClose`                                                         | Split stdout/stderr failure codes, retain one idempotent settlement path, and preserve the original cause only after canonical cleanup proves the owned tree absent.                                                                           |
| `packages/adapters/src/node-collaborators.test.ts:13-72`       | controllable child, exact emergency stop, fixture cleanup                                                                     | Extend only test-owned identity evidence and emergency-cleanup accounting.                                                                                                                                                                     |
| `packages/adapters/src/node-collaborators.test.ts:74-189`      | canonical utility and ambient-PATH tests                                                                                      | Keep as trusted-utility regression coverage.                                                                                                                                                                                                   |
| `packages/adapters/src/node-collaborators.test.ts:219-267`     | timeout and stdout/stderr bound tests                                                                                         | Require exact `timeout`, `stdout_limit`, and `stderr_limit` outcomes only when cleanup is proven.                                                                                                                                              |
| `packages/adapters/src/node-collaborators.test.ts:316-473`     | listener/late-event/cleanup/root-close tests                                                                                  | Add helper identity/close/reuse/absence and one-settlement assertions.                                                                                                                                                                         |
| `packages/adapters/src/node-collaborators.test.ts:527-590`     | real early-root-close and noisy `.cmd` fixtures                                                                               | Replace inferred race behavior with the shared deterministic source fixture and explicit runner-pending race observation.                                                                                                                      |
| `packages/adapters/src/types.ts:10-15`                         | `AdapterCommandResult.failure`                                                                                                | Replace the undifferentiated `'output-limit'` with the binding `'stdout_limit'` and `'stderr_limit'` values.                                                                                                                                   |
| `packages/adapters/src/adapter.ts:208-240`                     | `NativeAgentAdapter.detectInstallations`                                                                                      | Verification only: it already normalizes any runner failure/rejection to an unavailable installation. No production edit is expected.                                                                                                          |
| `packages/adapters/src/adapters.test.ts:109-154`               | bounded failure and rejected-runner sibling tests                                                                             | Verification only; change only if the failure-literal type update requires an exact fixture literal.                                                                                                                                           |
| `apps/daemon/src/control-plane-service.ts:485-493`             | `detectAgents` with `Promise.all`                                                                                             | Verification only; no production change expected.                                                                                                                                                                                              |
| `apps/daemon/src/control-plane-service.test.ts:115-131`        | rejected runner does not erase sibling detection                                                                              | Run after each runner/adapter change; no source change expected.                                                                                                                                                                               |
| `scripts/windows-command-cleanup-stress.ts:1-131`              | current 25-iteration stress                                                                                                   | Start the runner without awaiting, capture identities, observe the exact race, separate production and emergency cleanup evidence, and verify every original identity absent.                                                                  |
| `package.json:13-24`                                           | `test:windows-cleanup-stress` already exists                                                                                  | Keep unchanged; the existing command is sufficient and accepts the bounded iteration argument.                                                                                                                                                 |
| `README.md:186-199`                                            | documents the cleanup budget and stress command                                                                               | Inspect after implementation. Keep unchanged because the user-facing command does not change; put fourth-remediation evidence in the remediation document.                                                                                     |
| `docs/remediations/phase-5b-blocker-remediation.md:99-135`     | third-remediation evidence                                                                                                    | Add a fourth-remediation section with defect, algorithm, hard limits, tests, stress/repeat/gate evidence, and no-dependency/no-checkpoint statements.                                                                                          |

### Expected implementation file scope

| Action | Exact file                                                     | Intended change                                                                                                                                              |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modify | `packages/adapters/src/windows-process-cleanup.ts`             | Identity model, strict snapshot/helper evidence, global fixed-point context, fail-closed initial gate, canonical helper termination, final identity absence. |
| Modify | `packages/adapters/src/windows-process-cleanup.test.ts`        | All cleaner/helper red tests and global bound regressions.                                                                                                   |
| Modify | `packages/adapters/src/node-collaborators.ts`                  | Root expectation evidence, separate output failure labels, unified cleanup settlement.                                                                       |
| Modify | `packages/adapters/src/node-collaborators.test.ts`             | Helper lifecycle, timeout/stdout/stderr, deterministic real race, listener/timer and emergency-cleanup evidence.                                             |
| Modify | `packages/adapters/src/types.ts`                               | Exact `stdout_limit`/`stderr_limit` failure union.                                                                                                           |
| Create | `packages/adapters/test-fixtures/windows/early-root-close.cmd` | Repository-owned release-gated root plus persistent descendant fixture.                                                                                      |
| Modify | `scripts/windows-command-cleanup-stress.ts`                    | 25 observed-race iterations, identity evidence, bounded failure cleanup, structured summary.                                                                 |
| Modify | `docs/remediations/phase-5b-blocker-remediation.md`            | Fourth-remediation evidence after every gate passes.                                                                                                         |

Verification-only files are `packages/adapters/src/adapter.ts`, `packages/adapters/src/adapters.test.ts`, `apps/daemon/src/control-plane-service.ts`, and `apps/daemon/src/control-plane-service.test.ts`. Do not edit them unless an exact compile/test failure caused by the failure-union change requires a literal update. Do not modify `package.json`, `pnpm-lock.yaml`, the approved specification, dashboard files, architecture documents, or `README.md` under the accepted scope.

### Internal contracts to implement

Use these exact internal names and shapes; do not export them from `packages/adapters/src/index.ts`:

```ts
export type WindowsProcessIdentity = {
  pid: number;
  creationTicks: string;
  parentPid: number;
  executableName: string;
  canonicalExecutablePath?: string;
};

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
  maximumSnapshots: 8;
  maximumIdentities: 256;
};

type WindowsIdentityState =
  | { status: 'same'; identity: WindowsProcessIdentity }
  | { status: 'absent' }
  | { status: 'reused'; current: WindowsProcessIdentity }
  | { status: 'unproven' };

type FixedPointResult =
  | { status: 'stable'; current: Map<number, WindowsProcessIdentity> }
  | {
      status:
        'deadline' | 'discovery_failed' | 'identity_changed' | 'snapshot_limit' | 'identity_limit';
    };
```

`WindowsProcessCleanupRequest` must add `rootParentPid`, `rootObservedBeforeMs`, and optional `rootCanonicalExecutablePath` so the first snapshot can prove the spawn-bound root. Keep the request internal to the adapters implementation.

### Binding fixed-point pseudocode

```ts
async function discoverToFixedPoint(context: WindowsCleanupContext): Promise<FixedPointResult> {
  if (context.rootIdentity === undefined) return { status: 'discovery_failed' };
  for (;;) {
    if (Date.now() >= context.cleanupDeadline) return { status: 'deadline' };
    if (context.snapshotCount >= context.maximumSnapshots) {
      return { status: 'snapshot_limit' };
    }
    context.snapshotCount += 1;
    const snapshot = await takeBoundedSnapshot({
      rootIdentity: context.rootIdentity,
      knownIdentities: [...context.knownIdentities.values()],
      deadline: context.cleanupDeadline,
    });
    if (snapshot.status !== 'ok') return { status: 'discovery_failed' };

    const current = new Map<number, WindowsProcessIdentity>();
    let additions = 0;
    for (const identity of snapshot.processes) {
      const known = context.knownIdentities.get(identity.pid);
      if (known !== undefined && !sameIdentity(known, identity)) {
        return { status: 'identity_changed' };
      }
      current.set(identity.pid, identity);
      if (known === undefined) {
        if (context.knownIdentities.size >= context.maximumIdentities) {
          return { status: 'identity_limit' };
        }
        context.knownIdentities.set(identity.pid, identity);
        additions += 1;
      }
    }
    if (additions === 0) return { status: 'stable', current };
    if (context.snapshotCount === context.maximumSnapshots) {
      return { status: 'snapshot_limit' };
    }
  }
}
```

The first root-proof table is global snapshot one. Every later table uses the same counter and deadline. The fixed PowerShell traversal enqueues verified root and every known identity before its queue loop. An absent known parent remains a seed. A live reused known PID returns `identity_changed` before traversal. A per-table `HashSet[uint32]` ensures local exhaustion.

The fixed helper emits exactly two bounded lines:

```text
line 1 schema: { version: 1, kind: "helper_identity", identity: WindowsProcessIdentity }
line 2 schema: { version: 1, kind: "process_snapshot", status: "ok" | "identity_changed" | "limit", processes: WindowsProcessIdentity[] }
```

### Trusted helper and test-seam matrix

| Helper/path          | Fixed invocation and inputs                                                                           | Bounds and identity evidence                                                            | Terminal cleanup                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Command processor    | canonical `join(systemDirectory, 'cmd.exe')`; fixed `/d /s /c` validated shim command; `shell: false` | 2,500 ms; 65,536 stdout and stderr separately; spawn-bound root plus first snapshot     | Timeout/stdout/stderr enter the tree cleaner; original cause survives only after full absence |
| Process snapshot     | canonical fixed PowerShell flags and encoded repository script; `shell: false`; identities are data   | shared 5,000 ms; 65,536 combined output; helper header; consumes global snapshot budget | one exact-handle kill, close, and original identity absence/reuse; otherwise failure          |
| Exact identity probe | same canonical PowerShell; fixed exact identity query; no full table                                  | original helper deadline; strict `same`, `absent`, `reused`, `unproven`                 | verifier failure is unproven; no recursive/background retry                                   |
| Tree termination     | canonical `taskkill.exe`; `['/PID', String(root.pid), '/T', '/F']`; `shell: false`                    | shared 5,000 ms; helper identity if forced termination is needed                        | exit code is never success proof                                                              |
| Exact fallback       | `process.kill(identity.pid, 'SIGKILL')` only after identity revalidation                              | deepest-first; boolean is not proof                                                     | final fixed point controls success                                                            |
| Test emergency       | exact test-owned identities only                                                                      | 2,000 ms absence wait; separate evidence                                                | `finally` only; never masks production                                                        |

The smallest seams remain `WindowsProcessTreeIo`, `spawnProcess`, and `windowsProcessCleanup`. Add no index export, arbitrary table/utility injector, duplicate runner, or supervisor API.

---

### Task 1: Freeze, Reproduce, and Establish the Complete Red Baseline

**Purpose:** Revalidate ownership and finish every required failing regression before production changes.

**Files:**

- Modify: `packages/adapters/src/windows-process-cleanup.test.ts`
- Modify: `packages/adapters/src/node-collaborators.test.ts`
- Create: `packages/adapters/test-fixtures/windows/early-root-close.cmd`
- Modify: `scripts/windows-command-cleanup-stress.ts`
- Read: `packages/adapters/src/windows-process-cleanup.ts`
- Read: `packages/adapters/src/node-collaborators.ts`

**Interfaces:**

- Consumes: current IO, snapshot, spawn, and cleanup seams.
- Produces: complete red baseline for identity, fixed point, gate, helper, final absence, race, and emergency evidence.

- [ ] **Step 1: Revalidate frozen state.**

  Require branch/HEAD/merge-base/lock hash/counts/runtime ownership exactly as recorded above. Stop on any mismatch.

- [ ] **Step 2: Audit the existing orphan test.**

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/node-collaborators.test.ts -t "removes a known descendant even when the Windows command root closes early"
  ```

  A PASS is insufficient because the current test awaits the runner before reading PIDs.

- [ ] **Step 3: Add the dead-known-parent ordering test.**

  ```ts
  it('reaches a fixed point from a dead known parent before destructive cleanup', async () => {
    let call = 0;
    const terminateTree = vi.fn(async () => 'success' as const);
    const snapshot = vi.fn(async (request: { knownPids: readonly number[] }) => {
      call += 1;
      if (call === 1) return { status: 'ok' as const, processes: [root, child] };
      expect(terminateTree).not.toHaveBeenCalled();
      return request.knownPids.includes(child.pid)
        ? { status: 'ok' as const, processes: [root, grandchild] }
        : { status: 'ok' as const, processes: [root] };
    });
    const io = {
      snapshot,
      terminateTree,
      terminateExact: vi.fn(() => true),
    } satisfies WindowsProcessTreeIo;
    await new WindowsOwnedProcessTreeCleaner(io).cleanup({
      rootPid: root.pid,
      rootExecutableName: 'cmd.exe',
      taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      timeoutMs: 500,
    });
  });
  ```

  Task 2 changes `knownPids` to `knownIdentities` and uses `.some((identity) => identity.pid === child.pid)`.

- [ ] **Step 4: Add every remaining red test.**

  Cover identity/header/reuse; local/multi-round/global-eight/eighth-growth/ninth/257th; initial error/timeout/malformed/limit/missing/mismatched root with no kill; helper timeout/stdout/stderr/close/absence/reuse/deadline/listener; cause mapping; taskkill/fallback/final proof; exact race; separate emergency evidence.

- [ ] **Step 5: Add the release-gated source fixture.**

  ```bat
  @echo off
  start "" /b "__NODE_EXE__" -e "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({rootPid:process.ppid,descendantPid:process.pid}));setInterval(()=>{},1000)" "__EVIDENCE_PATH__" >nul 2>nul
  "__NODE_EXE__" -e "const fs=require('node:fs');const p=process.argv[1];const s=Date.now();const t=setInterval(()=>{if(fs.existsSync(p)||Date.now()-s>=9000){clearInterval(t)}},10)" "__ROOT_RELEASE_PATH__"
  exit /b 0
  ```

- [ ] **Step 6: Run the complete red wave.**

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/node-collaborators.test.ts -t "helper|initial|fixed point|stdout|stderr|identity|observes root absent"
  pnpm test:windows-cleanup-stress 25
  ```

  Each failure must be the intended defect; crash, hang, unrelated compile failure, or orphan is unacceptable.

**Review Point 1 — Red tests:** No production change until every required red case has failed for the intended defect.

**Completion condition:** Complete red baseline and no orphan.

**Stop condition:** Frozen-state mismatch, unbounded/unrelated failure, or unremovable orphan.

### Task 2: Refine Process Identity and Strict Evidence

**Purpose:** Replace PID-oriented ownership with the approved PID-plus-creation identity, add required parent/executable evidence, and bind the fixed helper to its strict identity header without widening public API.

**Files:**

- Modify: `packages/adapters/src/windows-process-cleanup.ts:7-119,336-456`
- Modify: `packages/adapters/src/windows-process-cleanup.test.ts:3-37`
- Modify: `packages/adapters/src/node-collaborators.ts:248-284,352-360`

**Interfaces:** Produces the identity/root/envelope contracts above.

- [ ] **Step 1: Re-run identity tests red.**

  Expected: FAIL because the current type uses `startedAtTicks`, has no canonical path, and the current helper emits no separate self-identity header.

- [ ] **Step 2: Implement exact identity validation and matching.**

  Require PID, creation ticks, name, required canonical path, and parent relation for new descendants. Validate bounded/control-free fields.

- [ ] **Step 3: Record canonical spawn evidence.**

  ```ts
  const rootCanonicalExecutablePath =
    process.platform === 'win32' ? await realpath(command).catch(() => undefined) : undefined;
  if (process.platform === 'win32' && rootCanonicalExecutablePath === undefined) {
    return { exitCode: 1, stdout: '', stderr: '', failure: 'spawn' };
  }
  if (rootCanonicalExecutablePath !== undefined) command = rootCanonicalExecutablePath;
  const rootSpawnedAfterMs = Date.now();
  const child = this.#spawnProcess(command, commandArguments, spawnOptions);
  const rootObservedBeforeMs = Date.now();
  const rootParentPid = process.pid;
  ```

- [ ] **Step 4: Emit/parse strict helper identity then table envelope.**

- [ ] **Step 5: Verify focused identity and canonical utility tests.**

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts -t "identity|creation|canonical Windows utilities|ambient"
  ```

**Completion condition:** Exact identity everywhere, no index export.

**Stop condition:** PID-only, ambient, untrusted output, or missing canonical evidence.

### Task 3: Implement Fixed-Point Discovery and Global Bounds

**Purpose:** Seed every captured table from the verified root plus all known identities, preserve dead parent seeds, and enforce one cleanup-wide snapshot/identity/deadline context.

**Files:**

- Modify: `packages/adapters/src/windows-process-cleanup.ts:121-258,336-456`
- Modify: `packages/adapters/src/windows-process-cleanup.test.ts`

**Interfaces:** Produces the single cleanup context and `discoverToFixedPoint`.

- [ ] **Step 1: Re-run all fixed-point/limit tests red.**

  Expected: FAIL because current cleanup invokes taskkill after its first table, has no fixed-point loop/global counter, and the helper adds known PIDs only after traversal.

  ```ts
  const identities = Array.from(
    { length: 257 },
    (_, index) =>
      ({
        pid: index + 100,
        parentPid: index === 0 ? 1 : index + 99,
        creationTicks: String(index + 1),
        executableName: index === 0 ? 'cmd.exe' : 'node.exe',
      }) satisfies WindowsProcessIdentity,
  );
  ```

- [ ] **Step 2: Create context before snapshot one and never reset it.**

- [ ] **Step 3: Queue root and every known identity before local traversal.**

  ```powershell
  foreach ($seed in $seedIdentities) {
    $live = $rowByPid[[uint32]$seed.pid]
    if ($null -ne $live -and -not (Test-LuwiIdentity $seed (Get-LuwiIdentity $live))) {
      Write-LuwiSnapshotResult 'identity_changed' @()
      exit 0
    }
    if ($owned.Add([uint32]$seed.pid)) { $queue.Enqueue([uint32]$seed.pid) }
  }
  while ($queue.Count -gt 0) {
    $parentPid = $queue.Dequeue()
    foreach ($childRow in $childrenByParent[$parentPid]) {
      if ($owned.Add([uint32]$childRow.pid)) { $queue.Enqueue([uint32]$childRow.pid) }
    }
  }
  ```

- [ ] **Step 4: Implement binding pseudocode and fail on every limit/error.**

- [ ] **Step 5: Run cleaner tests.**

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts
  ```

**Completion condition:** Stable no-addition table under one eight-round/256/deadline context.

**Stop condition:** Reset budget, ninth snapshot, partial success, reuse traversal, or unbounded scan.

### Task 4: Enforce Initial Ownership Gate

**Purpose:** Prove the spawn-bound root and initial fixed point before any destructive action, returning cleanup failure with no delayed work when proof is unavailable.

**Files:**

- Modify: `packages/adapters/src/windows-process-cleanup.ts:127-198`
- Modify: `packages/adapters/src/windows-process-cleanup.test.ts:110-190`
- Modify: `packages/adapters/src/node-collaborators.test.ts:403-473`

**Interfaces:** Sets verified `context.rootIdentity` or returns non-destructive failure.

- [ ] **Step 1: Re-run initial-gate tests red.**

  Expected: FAIL because current lines 171-178 call `terminateTree` after initial error/invalid data and a child-only first table can reach exact fallback.

  ```ts
  expect(result).toMatchObject({ cleaned: false });
  expect(io.terminateTree).not.toHaveBeenCalled();
  expect(io.terminateExact).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(vi.getTimerCount()).toBe(0);
  ```

- [ ] **Step 2: Prove root in global snapshot one.**

  Require creation window, parent, name, and canonical path. Child-only first snapshot fails.

- [ ] **Step 3: Remove initial best-effort `/T`.**

  Return `discovery_failed`, `identity_changed`, `snapshot_limit`, `identity_limit`, or `deadline`; no destructive/background work.

- [ ] **Step 4: Verify gate tests.**

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts -t "initial|missing root|mismatched root|cleanup failure|root close"
  ```

**Completion condition:** Destructive cleanup only after verified stable initial ownership.

**Stop condition:** Any kill or late work without proof.

### Task 5: Canonical Helper Termination and Unified Causes

**Purpose:** Route every trusted helper and command timeout/stdout/stderr terminal cause through one exact-handle, identity-aware, bounded cleanup and settlement path.

**Files:**

- Modify: `packages/adapters/src/windows-process-cleanup.ts:261-334,418-479`
- Modify: `packages/adapters/src/windows-process-cleanup.test.ts`
- Modify: `packages/adapters/src/node-collaborators.ts:302-413`
- Modify: `packages/adapters/src/node-collaborators.test.ts`
- Modify: `packages/adapters/src/types.ts:10-15`

**Interfaces:** Produces `terminateTrustedHelper` and exact cause literals.

- [ ] **Step 1: Re-run helper/cause tests red.**

  Expected: FAIL because current `runUtility` settles immediately after kill, stderr overflow does not kill, helper absence is not verified, and the runner exposes only `'output-limit'`.

- [ ] **Step 2: Change failure union exactly.**

  ```ts
  failure?:
    | 'spawn'
    | 'timeout'
    | 'stdout_limit'
    | 'stderr_limit'
    | 'cleanup'
    | 'unavailable';
  ```

- [ ] **Step 3: Implement one helper termination function.**

  ```ts
  stopAcceptingOutput();
  requestKillOnce(child, 'SIGKILL');
  const closed = await waitForCloseWithin(originalUtilityDeadline);
  if (!closed || helperIdentity === undefined) return false;
  const state = await probeExactIdentityWithin(helperIdentity, originalUtilityDeadline);
  if (state.status === 'same' || state.status === 'unproven') return false;
  return state.status === 'absent' || state.status === 'reused';
  ```

  Verifier failure is `unproven`; no recursive/background verifier.

- [ ] **Step 4: Unify command output causes.**

  ```ts
  const onStdout = (chunk: Buffer): void => {
    stdoutBytes = collect(stdout, chunk, stdoutBytes, this.#maxStdoutBytes, 'stdout_limit');
  };
  const onStderr = (chunk: Buffer): void => {
    stderrBytes = collect(stderr, chunk, stderrBytes, this.#maxStderrBytes, 'stderr_limit');
  };
  ```

- [ ] **Step 5: Verify helper, runner, and sibling tests.**

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/adapters.test.ts apps/daemon/src/control-plane-service.test.ts -t "sibling|reject"
  ```

**Completion condition:** One bounded identity-aware cleanup and settlement per cause.

**Stop condition:** Close/PID-only success, renewed deadline, second kill, stderr partial path, ambient utility, leak, or background cleanup.

### Task 6: Main Owned-Tree Termination and Final Proof

**Purpose:** Preserve the complete known set, invoke canonical `/T` only for the still-matching root, revalidate deepest-first exact survivors, and let final fixed-point identity absence alone control success.

**Files:**

- Modify: `packages/adapters/src/windows-process-cleanup.ts:121-258,458-479`
- Modify: `packages/adapters/src/windows-process-cleanup.test.ts`
- Modify: `packages/adapters/src/node-collaborators.test.ts:438-567`

**Interfaces:** Produces cleanup true only for final stable original-identity absence.

- [ ] **Step 1: Re-run final-invariant tests red.**

  Expected: FAIL for post-taskkill additions, shared-budget final stability, and the current insufficient root/after/final three-snapshot sequence.

- [ ] **Step 2: Implement exact sequence.**

  ```text
  prove root with snapshot one
  initial fixed point
  batch root revalidation
  matching root only: canonical taskkill /PID <root> /T /F
  absent/reused root: no /T
  post-taskkill fixed point
  batch survivor revalidation
  deepest-first matching exact fallback
  final fixed point
  every original identity absent/reused
  ```

- [ ] **Step 3: Never treat kill/taskkill/close/deadline as proof.**

- [ ] **Step 4: Allow true only with `verified_absent` or `verified_fallback` after final stability.**

- [ ] **Step 5: Verify four sensitive test files.**

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts packages/adapters/src/adapters.test.ts apps/daemon/src/control-plane-service.test.ts
  ```

**Review Point 2 — Minimal implementation:** Reject best effort, ambient PATH, background cleanup, multiplied budgets, PID-only absence, public exports, dependencies, or dashboard/service production edits.

**Completion condition:** `cleaned: true` means complete original-identity absence plus stable final fixed point.

**Stop condition:** Any weaker success proof.

### Task 7: Deterministic Early-Root-Close Fixture and Observed-Race Harness

**Purpose:** Observe root absent, descendant alive, and runner pending in every real iteration; keep emergency evidence exact and separate.

**Files:**

- Create in Task 1: `packages/adapters/test-fixtures/windows/early-root-close.cmd`
- Modify: `packages/adapters/src/node-collaborators.test.ts:527-567`
- Modify: `scripts/windows-command-cleanup-stress.ts:1-131`

**Interfaces:**

- Consumes: Task 6 cleaner and existing cleanup/IO seams.
- Produces: shared release-gated fixture, observed-race Vitest regression, and structured iteration evidence.

- [ ] **Step 1: Verify the repository-owned release-gated fixture created in Task 1.**

  Use a fixed file with only these three renderer tokens: `__NODE_EXE__`, `__EVIDENCE_PATH__`, and `__ROOT_RELEASE_PATH__`. Its behavior is:

  ```bat
  @echo off
  start "" /b "__NODE_EXE__" -e "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({rootPid:process.ppid,descendantPid:process.pid}));setInterval(()=>{},1000)" "__EVIDENCE_PATH__" >nul 2>nul
  "__NODE_EXE__" -e "const fs=require('node:fs');const p=process.argv[1];const s=Date.now();const t=setInterval(()=>{if(fs.existsSync(p)||Date.now()-s>=9000){clearInterval(t)}},10)" "__ROOT_RELEASE_PATH__"
  exit /b 0
  ```

  Renderer code must reject token values containing `"`, `%`, `!`, or control characters, replace each token exactly once, and write only a unique temporary copy. The fixture accepts no command text and executes only the exact `process.execPath` inserted by test code.

- [ ] **Step 2: Re-open the real Vitest race test written in Task 1 and verify its exact pre-completion assertion.**

  Construct the real runner with `timeoutMs: 2_500`, `cleanupTimeoutMs: 5_000`, and separate 65,536-byte stdout/stderr limits. Start `runner.run(fixture, ['--version'])` without awaiting. Track `runnerSettled` in a `.finally`. Acquire the PID file within 2,000 ms, capture exact identities from the cleaner's trusted snapshot trace, and hold the existing injected `terminateTree` seam. Release the fixture root, then poll trusted identity evidence for at most 2,000 ms until:

  ```ts
  const raceObserved =
    rootState.status !== 'same' && descendantState.status === 'same' && runnerSettled === false;
  expect(raceObserved).toBe(true);
  ```

  Only after recording the race may the test release the termination seam and await the runner within the 10,000 ms outer bound.

- [ ] **Step 3: Preserve Task 1's red race result, then run it against the minimal implementation.**

  Run:

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/node-collaborators.test.ts -t "observes root absent, descendant alive, and runner pending"
  ```

  Task 1 evidence must show the original **FAIL**. At this point the expected result is PASS only if the non-awaited fixture flow, injected termination gate, production cleanup, and `finally` absence proof are all wired correctly.

- [ ] **Step 4: Implement exact race gating without production delay.**

  The test/stress wrapper around the existing `WindowsProcessTreeIo.terminateTree` seam waits on a test-owned deferred. Once the cleaner has proven the initial tree and reaches the termination seam, write the root-release file. Observe the exact race with trusted identity checks while the runner remains pending. Then release the seam; because the original root is absent, the wrapper returns `nonzero` without calling real `/T`, allowing production exact-fallback/final-proof logic to remove the validated descendant. No delay or gate enters production code.

- [ ] **Step 5: Separate production and emergency evidence.**

  Each test/iteration must maintain:

  ```ts
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
  ```

  On a failed/aborted iteration, `finally` revalidates each recorded exact identity, calls exact termination only for a still-matching test-owned identity, and waits at most 2,000 ms for identity absence. It never kills by image name and never changes `productionCleanupResult`. If emergency cleanup is needed on an otherwise successful iteration, the iteration fails.

- [ ] **Step 6: Rewrite the stress output and summary.**

  Emit one JSON line per iteration with every `IterationEvidence` field and a final line containing:

  ```json
  {
    "iterations": 25,
    "raceObserved": 25,
    "cleanupFailures": 0,
    "emergencyCleanupUses": 0,
    "survivingFixtureProcesses": 0
  }
  ```

- [ ] **Step 7: Run the single real race regression green.**

  Run the Step 3 command again. Expected: PASS; the log/test evidence shows the race before runner completion and final absence after runner completion.

**Completion condition:** The source-controlled fixture produces a release-controlled root and persistent descendant, and the test fails whenever the exact race is not observed.

**Stop condition:** Sleep-only proof, awaited runner before observation, PID-only liveness, emergency cleanup masking production failure, test gate in production code, or any surviving fixture/helper.

### Task 8: Execute the 25-Iteration Stress and 10-Pass Windows Proof

**Purpose:** Produce repeatable bounded evidence that the exact race occurs every time and that the complete Windows cleanup suite remains stable with no skip or orphan.

**Files:**

- Modify only if a defect is found: files from Tasks 2-7
- Read unchanged: `package.json`

**Interfaces:**

- Consumes: Task 7 stress command and Windows-focused test files.
- Produces: 25/25 structured race evidence and 10/10 complete Windows-focused passes.

- [ ] **Step 1: Run the binding 25-iteration stress command once.**

  Run:

  ```powershell
  pnpm test:windows-cleanup-stress 25
  ```

  Expected final JSON: 25 iterations, 25 races observed, zero cleanup failures, zero emergency cleanup uses, and zero surviving fixture processes. Any iteration failure stops the run and retains its structured evidence while `finally` performs exact test-owned cleanup.

- [ ] **Step 2: Verify no recorded identity remains after stress.**

  Re-probe every identity recorded by the harness. A reused PID counts as original-identity absence and is not killed. Any same identity still alive blocks continuation.

- [ ] **Step 3: Run the complete Windows-focused suite ten consecutive times.**

  Run:

  ```powershell
  1..10 | ForEach-Object {
    Write-Host "Windows focused pass $_/10"
    & .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Windows focused pass $_ failed" }
  }
  ```

  Expected: ten complete green invocations. On this Windows host, command-shim, orphan-descendant, canonical-utility, ambient-PATH-substitution, helper-termination, stdout, stderr, and race tests must execute; no `skipIf` may activate and no test may return early.

- [ ] **Step 4: Run full adapters and service sibling-isolation coverage.**

  Run:

  ```powershell
  .\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts packages/adapters/src/adapters.test.ts apps/daemon/src/control-plane-service.test.ts
  ```

  Expected: all four files pass and no runner rejection erases a successful sibling installation.

**Review Point 3 — Stress:** Before canonical gates, require 25/25 exact observed races, 10/10 complete Windows suite passes, zero skip, zero orphan, and zero emergency cleanup in a successful iteration.

**Completion condition:** Both repeated proofs meet their exact counts in one uninterrupted implementation evidence set.

**Stop condition:** Race not observed, runner already settled at observation, emergency cleanup required, any orphan, any skip/early return on Windows, or any failed repeated pass.

### Task 9: Update Fourth-Remediation Documentation Without Creating a Checkpoint

**Purpose:** Record the implemented invariant and verified evidence honestly after, and only after, the repeated proof passes.

**Files:**

- Modify: `docs/remediations/phase-5b-blocker-remediation.md:after line 135`
- Read unchanged: `README.md:186-199`
- Read unchanged: `docs/superpowers/specs/2026-08-05-phase-5b-fourth-blocker-remediation-design.md`

**Interfaces:**

- Consumes: exact focused/stress/repeat results from Tasks 1-8.
- Produces: a fourth-remediation section containing only already observed evidence; Task 10 appends its final gate evidence before handoff.

- [ ] **Step 1: Add a “Fourth blocker remediation” section.**

  Record:

  - the old known-PID queue defect and unsafe initial `/T` behavior;
  - PID versus `WindowsProcessIdentity` and reuse handling;
  - root proof, dead-parent seed preservation, local exhaustion, one global eight-snapshot cap, 256 identities, and one 5,000 ms deadline;
  - canonical helper identity/termination/absence proof;
  - `timeout`, `stdout_limit`, `stderr_limit`, and `cleanup` result mapping;
  - exact taskkill/fallback/final verification sequence;
  - source-controlled fixture and observed race fields;
  - 25/25 and 10/10 exact results;
  - focused, stress, and repeated-Windows results already observed in Tasks 1-8;
  - remaining manual QA, if an exact item remains;
  - unchanged dependency/lockfile and no checkpoint/publication operations.

- [ ] **Step 2: Do not rewrite earlier evidence.**

  Preserve the third-remediation section as historical evidence. State that the fourth section supersedes its weaker discovery/stress proof, not that the earlier command was never run.

- [ ] **Step 3: Keep non-goals explicit.**

  State that no dashboard source, ACP/Goose work, dependency, package boundary, release document, checkpoint tag, or Git publication was added. Do not edit the formally approved specification.

- [ ] **Step 4: Record only results already observed through Task 8.**

  Write no passing count from expectation and leave no blank result slot. Task 10 will append a separate final-verification paragraph with its exact observed unit/integration/format/typecheck/lint/build/diff results. If a pre-gate command failed, document that failure and use the incomplete verdict instead of claiming completion.

**Completion condition:** The remediation document accurately maps every binding invariant to observed evidence and asks for independent read-only review without self-approval.

**Stop condition:** Any proposed wording claims a checkpoint, release readiness, unrun test, or changed architecture/dependency.

### Task 10: Run Canonical Gates and Prepare Independent-Review Handoff

**Purpose:** Verify the repository as a whole, audit residual processes/runtime state/diff scope, and issue only the allowed remediation verdict.

**Files:**

- Verify: every file in “Expected implementation file scope”
- Do not modify: manifests, lockfile, approved spec, dashboard, checkpoint/release files

**Interfaces:**

- Consumes: all completed tasks.
- Produces: a bounded evidence report for a new independent read-only reviewer.

- [ ] **Step 1: Run the full canonical unit suite once and stop on any failure.**

  Run:

  ```powershell
  pnpm test
  ```

  Expected: every discovered unit file/test passes. A later focused green run cannot override one canonical failure.

- [ ] **Step 2: Run the repository gates in binding order.**

  Run:

  ```powershell
  pnpm format
  pnpm typecheck
  pnpm lint
  pnpm test

  $env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6379'
  $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'
  pnpm test:integration

  pnpm build
  git diff --check
  ```

  Required evidence: format, typecheck, lint, unit, build, and diff check pass; Redis integration reports exactly 15/15 files and 41/41 tests with zero missing-config skip. If the repository's discovered unit count has legitimately changed because of these tests, record the exact new count instead of copying the old 90/519 evidence.

- [ ] **Step 3: Verify the Windows and process invariants after all gates.**

  Confirm no fixture/helper/daemon identity remains; ports 4782 and 4783 are free; daemon-owner lease and validation presence are absent; active sessions/presence remain empty; and no late cleanup is running. Reused PIDs are unrelated and must not be killed.

- [ ] **Step 4: Audit exact file and dependency scope.**

  Require staged count zero, `pnpm-lock.yaml` hash `79a62b422430f9197dc8421d7eb400a182ba7fc2a9d69b782ae319a828ff1072`, no manifest change, no added dependency, no ACP/Goose dependency, no dashboard Redis client, and no dashboard file change. Use `git diff --name-only`, `git status --short -uall`, and `git diff --check`; do not stage or clean.

- [ ] **Step 5: Append exact final-gate evidence to the remediation document.**

  After Steps 1-4 pass, append the exact unit file/test counts, 15/15 integration files, 41/41 integration tests, zero missing-config skips, format/typecheck/lint/build/diff results, residual process/port/runtime checks, lock hash, and no-dependency/no-checkpoint evidence to Task 9's fourth-remediation section. Do not copy an expected count that was not observed.

- [ ] **Step 6: Re-run documentation-sensitive final checks.**

  Run:

  ```powershell
  pnpm format
  git diff --check
  ```

  Expected: both pass after the final documentation edit.

- [ ] **Step 7: Perform the final self-review.**

  Check each approved specification section against a task/test result. Search the diff for `shell: true`, bare `cmd`, bare `taskkill`, `/IM`, `where.exe`, per-phase timeout/counter construction, `'output-limit'`, delayed cleanup timers, PID-only success, and emergency cleanup that modifies the production result. Any hit must be explained as test text or corrected.

- [ ] **Step 8: Request a new independent read-only re-review.**

  The handoff must list files changed, exact commands/results, stress/repeat summaries, remaining limitations, no-dependency/no-lock-drift evidence, and no Git publication operations. It must not self-approve checkpoint readiness.

- [ ] **Step 9: Use exactly one implementation-session verdict.**

  If every condition passes:

  ```text
  FOURTH BLOCKER REMEDIATION COMPLETE — READY FOR FINAL INDEPENDENT RE-REVIEW
  ```

  Otherwise:

  ```text
  FOURTH BLOCKER REMEDIATION INCOMPLETE
  ```

  Never use `CHECKPOINT READY`, `CHECKPOINT CREATED`, `PHASE 5B CHECKPOINTED`, or `READY TO PUSH`.

**Review Point 4 — Canonical gates:** Only a fully green canonical evidence set permits the complete verdict and independent-review request.

**Completion condition:** Every binding command and residual-state check passes, the diff is narrow, and the independent-review handoff is evidence-backed.

**Stop condition:** Any canonical failure, missing integration configuration, orphan, occupied port, live lease/presence, dependency/lock drift, staged file, new Critical/Important defect, or scope expansion.

---

## Focused Command Registry

Use these commands exactly; do not invent package-local scripts that do not exist:

```powershell
# Cleaner/fixed-point/helper tests
.\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts

# Complete Windows-focused runner and cleaner suite
.\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts

# Adapter and daemon sibling isolation
.\node_modules\.bin\vitest.cmd run packages/adapters/src/adapters.test.ts apps/daemon/src/control-plane-service.test.ts

# All four remediation-sensitive test files
.\node_modules\.bin\vitest.cmd run packages/adapters/src/windows-process-cleanup.test.ts packages/adapters/src/node-collaborators.test.ts packages/adapters/src/adapters.test.ts apps/daemon/src/control-plane-service.test.ts

# Binding stress
pnpm test:windows-cleanup-stress 25

# Canonical unit suite
pnpm test
```

On the current Windows host, any Windows security test reported as skipped or silently returned is a blocking failure.

## Complete Stop-Condition Ledger

Stop without destructive fallback, documentation completion, independent-review readiness, or publication when any of these occurs:

1. Frozen HEAD/merge-base/ownership changes.
2. Initial root ownership cannot be proven.
3. Snapshot/helper data is malformed or required identity evidence is missing.
4. A known PID resolves to mismatched creation/executable identity.
5. Snapshot eight adds an identity or proof would require snapshot nine.
6. A 257th owned identity would be added.
7. Canonical cmd/taskkill/PowerShell cannot be proven.
8. Helper close and original-identity absence cannot both be proven.
9. Timeout/stdout/stderr cleanup cannot prove the owned tree absent.
10. Any descendant identity survives final stable verification.
11. A stress iteration does not observe root absent, descendant alive, runner pending.
12. Emergency cleanup is required during a purportedly successful iteration.
13. A Windows test skips/returns early or any repeated pass fails.
14. Canonical `pnpm test` fails once.
15. Integration does not report 15/15 files and 41/41 tests with no missing-config skip.
16. Any fixture/helper/daemon remains, ports 4782/4783 are occupied, or daemon-owner/presence remains.
17. Ambient PATH, image-name kill, broad process kill, arbitrary PowerShell input, or background cleanup appears.
18. A new Critical/Important defect or contrary dashboard evidence appears.
19. A dependency, manifest, lockfile, package boundary, checkpoint, or Git publication operation becomes necessary.

## Plan Self-Review and Resolved Decisions

- **Spec coverage:** Every binding identity, root gate, fixed-point, helper, command cause, race, repeated proof, gate, and stop requirement maps to Tasks 2-10.
- **One snapshot budget:** The plan creates `WindowsCleanupContext` once and makes every full process-table call consume the same counter. Snapshot-eight growth and required snapshot nine are explicit red tests.
- **One deadline:** The 5,000 ms cleanup deadline and each helper's original deadline are absolute and non-renewable; no phase or output limit creates another window.
- **Identity absence:** Success uses PID plus creation ticks plus required executable evidence. Reuse is original-identity absence and never authorizes killing the new process.
- **Initial fail-closed correction:** The plan explicitly reverses the current test/implementation behavior that invokes `/T` after initial discovery error and blocks child-only first-snapshot fallback.
- **Helper lifecycle correction:** The plan covers the current stderr-overflow no-kill branch and immediate post-kill settlement, requiring one kill, close, exact absence, and one settlement.
- **Failure-code correction:** The approved `stdout_limit` and `stderr_limit` names replace current `'output-limit'`; consumer logic remains generic.
- **Race evidence correction:** The permanent fixture is release-gated, the runner starts unawaited, and production versus emergency cleanup evidence is separate.
- **Smallest seams:** Reuse `WindowsProcessTreeIo`, `spawnProcess`, and `windowsProcessCleanup`. The only new seam is fixed fixture data/rendering and internal exact identity evidence; nothing enters `src/index.ts`.
- **File scope correction:** `adapter.ts`, daemon production, package manifests, lockfile, README, dashboard, architecture, and approved spec are verification-only or excluded. No separate implementation report is created because the existing remediation document is the repository convention.
- **Git/dependency correction:** The writing-plans skill's usual commit cadence is intentionally replaced with red/green/review checkpoints because this remediation explicitly forbids stage/commit/branch/tag/push/merge/reset/stash/clean.
- **Remaining ambiguity:** None. If implementation evidence contradicts an assumption, the corresponding stop condition requires an incomplete verdict and renewed design review rather than an improvised weaker algorithm.

This plan is ready for implementation approval only. It does not implement, self-approve, checkpoint, release, or publish Phase 5B.
