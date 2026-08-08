# LUWI Runtime Phase 5B Fourth Blocker Remediation Design

Date: 2026-08-05

Status: ready for formal architectural approval; implementation is not approved by this
document

## 1. Objective

Close the two remaining Important Windows process findings and the two current Minor
findings without changing LUWI's architecture, adding a dependency, or widening the native
version-probe surface.

The binding outcome is:

> Bounded fixed-point process discovery, verified process identity, and fail-closed Windows
> cleanup.

This specification is implementation-ready input for a later test-first plan. It is not an
implementation plan and does not authorize a checkpoint or Git publication operation.

## 2. Scope

The later implementation is limited to:

- Windows owned-process discovery and cleanup;
- identity-aware trusted-helper termination;
- cleanup unit and Windows-host tests;
- the deterministic early-root-close fixture and bounded stress harness;
- remediation documentation affected by these changes.

It does not add dashboard functionality, a dependency, a datastore, a public execution API,
a general-purpose process manager, or background cleanup.

### Dashboard Minor decision: Option B, excluded with independent evidence

No dashboard source or test change is in scope. The two dashboard findings from the older
independent review were fixed before the newest independent third-remediation re-review and
were then independently inspected again on 2026-08-05. That newest review reported zero
dashboard Critical/Important findings and identified only two Windows-cleanup Minors:
trusted-helper stderr-limit termination and incomplete stress race evidence. It explicitly
confirmed all four dashboard closure conditions below.

Concrete current evidence:

- `apps/dashboard/src/inspectors/inspector-panel.tsx:10-13` defines selection as
  `{ projectId }`, `{ sessionId }`, or `{ streamId }`; it stores no canonical Project or
  Session object.
- `apps/dashboard/src/inspectors/inspector-panel.tsx:119-129` resolves the current selected
  Project, Session, and Event from the current `projects`, `sessions`, and bounded `activity`
  props on every render.
- `apps/dashboard/src/inspectors/inspector-panel.tsx:136-165` permits an interval only for a
  current nonterminal Session with a finite, non-future `startedAt`, and its effect cleanup
  clears the interval when identity, start value, status, selection, close, or unmount
  changes.
- `apps/dashboard/src/inspectors/inspector-panel.test.tsx:179-196` proves invalid, missing,
  and future starts create no interval.
- `apps/dashboard/src/inspectors/inspector-panel.test.tsx:244-288` proves refreshed invalid,
  valid, and terminal data starts or clears exactly one interval without close/reopen.
- `apps/dashboard/src/inspectors/inspector-panel.test.tsx:291-323` proves Event selection is
  reconciled against the current retained Activity window.
- `apps/dashboard/src/inspectors/inspector-panel.test.tsx:324-409` proves deleted selected
  entities leave no stale details/actions, and `:410-456` proves refreshed ownership removes
  an incoherent Event-to-Session action.
- `apps/dashboard/src/app.test.tsx:194-252` proves an open Project inspector reflects
  refreshed metadata and deletion; `:254-323` proves an open Session inspector reflects a
  terminal refresh and stops its duration clock.
- The independent third-remediation re-review on 2026-08-05 independently read these paths,
  ran the dashboard App/Inspector suite at 35/35, and concluded that identity reconciliation
  and duration eligibility were correct.

This evidence resolves the earlier scope contradiction. Reopening dashboard work requires a
new contrary source or independent test finding.

## 3. Process identity model

A PID is only an address into the current process table. It is not an ownership identity.

Every owned process identity contains at minimum:

```ts
type WindowsProcessIdentity = {
  pid: number;
  creationTicks: string;
  parentPid: number;
  executableName: string;
  canonicalExecutablePath?: string;
};
```

Rules:

- `pid` and `parentPid` are validated bounded decimal integers.
- `creationTicks` is a validated decimal UTC creation-time identity.
- `executableName` is compared case-insensitively; a canonical executable path is required
  for the trusted root/helper executable whenever the operating-system query exposes it.
- A process matches an owned identity only when PID and creation ticks agree and the required
  executable evidence agrees. Parent relation is also required when deriving a new
  descendant.
- A live row with the same PID but different creation ticks is a reused PID, not the original
  process. It must not be killed or used as a traversal seed for the old tree.
- A PID with mismatched executable or creation identity fails closed.
- No identity is persisted beyond one probe lifecycle.

Binding absence definition:

> The original process identity is absent when no live process matches the captured PID plus
> creation-time identity and the required executable evidence. A reused PID is not treated as
> the original process and must not be terminated as part of the old ownership set.

This identity rule applies to the command root, every descendant, the command helper, the
`taskkill` helper, and the discovery helper. Termination uses the exact Node-owned child
process handle where one exists; PID is never used as the sole identity proof.

For a fixed discovery helper, its fixed script emits its own PID, parent PID, creation ticks,
and executable evidence in the strict result envelope before process-table payload data. The
spawn-bound stdout pipe and Node-owned child handle bind that envelope to the spawned helper.
For another trusted helper that remains live, a trusted snapshot captures the same identity
before any timeout/output-limit termination is treated as proven. If required identity
evidence cannot be captured, helper cleanup may be requested through the already-owned
process handle, but helper cleanup is unproven and the operation fails closed.

## 4. Root identity baseline

Root ownership is proven only in this sequence:

1. The runner successfully spawns the exact direct executable or canonical System32
   `cmd.exe` chain and receives the root PID from its own spawn result.
2. The runner records the spawn-attempt time, expected canonical executable/basename, and its
   own parent-process evidence.
3. The first trusted process snapshot must contain that PID.
4. The row's creation ticks must fall within the recorded spawn window, its parent relation
   must agree with the runner where available, and its executable evidence must match the
   expected spawned executable chain.
5. Only that complete identity becomes the verified root. Descendants may then be derived
   only through verified parent relations.

If the first snapshot or initial fixed-point discovery fails because of timeout, helper
error, malformed output, missing root identity, root identity mismatch, process limit, round
limit, trusted-utility failure, or deadline exhaustion, ownership is not proven.

Required behavior in every such case:

```text
do not invoke taskkill /T
do not invoke exact descendant termination
return failure: cleanup
do not start background cleanup
```

There is no best-effort destructive fallback before initial ownership proof.

## 5. Bounded fixed-point discovery

Each snapshot round receives two seed classes:

- the exact verified root identity;
- every previously identity-validated known process identity.

For each captured process table:

1. Build a lookup by PID and by `ParentProcessId`.
2. Add the verified root and every known identity to the local traversal queue, including a
   known identity whose original process is now absent.
3. If a known PID currently names a mismatched/reused live process, fail closed and do not
   traverse from that PID.
4. Traverse the captured table to local exhaustion. A live child whose `ParentProcessId`
   names an absent but known parent remains discoverable.
5. Validate each new child's PID, creation ticks, executable evidence, and parent relation
   before adding it to the owned set and local queue.
6. If adding an identity would exceed 256 total owned identities, return `failure: cleanup`;
   the partial set is not proof of completeness.
7. Begin the next snapshot round with the expanded verified seed set.

A fixed point is reached only when a complete snapshot round adds no new identity. One
cleanup permits at most eight snapshots in total across initial discovery, post-taskkill
discovery, survivor revalidation, and final verification. A single shared round counter is
never reset between phases. If snapshot eight adds an identity, or any required final proof
would need snapshot nine, return `failure: cleanup`.

Every snapshot call and all phases share one total cleanup deadline. The round limit does
not create a fresh per-phase or per-round timeout. No retry or cleanup continues after runner
settlement.

## 6. Ownership boundary

The cleaner owns only:

- the exact process identity created by its own spawn;
- identity-validated descendants derived from the bounded parent relation.

It never accepts PIDs or identities from agent output, command stdout/stderr, untrusted event
payloads, or persisted stale probe state. The fixed trusted helper's strict identity/table
envelope is operating-system evidence, not command-probe output.

The following are explicitly forbidden:

```text
taskkill /IM node.exe
taskkill /IM cmd.exe
broad process-name cleanup
ambient PATH utility resolution
```

There is no image-name kill and no broad Node, PowerShell, or command-processor kill.

## 7. Trusted Windows utility policy

Only validated absolute utilities under the canonical Windows system directory are allowed:

```text
<SystemRoot>\System32\cmd.exe
<SystemRoot>\System32\taskkill.exe
<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe
```

Every path must have an exact case-insensitive basename, canonical directory containment,
regular-file evidence, and the expected canonical path. `ComSpec` is accepted only when it
is absolute, argument-free, quote-free, control-free, and resolves to the same canonical
System32 `cmd.exe`.

Forbidden behavior includes a bare executable name, ambient PATH search, ambient
`where.exe`, relative/argument-bearing `ComSpec`, wildcard resolution, `shell: true`, or
caller-provided script content.

The process snapshot uses only the fixed repository-owned encoded helper with
`-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass`, `shell: false`, bounded output,
and bounded execution. `Bypass` does not create a general script surface.

If canonical `cmd.exe` cannot be proven, `.cmd`/`.bat` probing is unavailable. If canonical
`taskkill.exe` or the discovery helper cannot be proven when cleanup is required, the result
is `failure: cleanup`. Ambient PATH is never a fallback.

## 8. Termination sequence

The required bounded sequence is:

1. Prove the initial root identity.
2. Discover the owned identity set to a bounded fixed point.
3. Preserve the complete verified known set.
4. Immediately revalidate the root identity.
5. If the original root identity is still live, invoke only canonical
   `taskkill /PID <root> /T /F` through `shell: false`.
6. If the original root identity is absent, do not invoke `/T` against that numeric PID.
7. Wait only within the existing total cleanup deadline.
8. Run bounded fixed-point discovery using root plus all known identities as seeds.
9. Identify only still-matching surviving identities.
10. Revalidate every survivor immediately before exact fallback.
11. Terminate only still-matching owned identities, deepest-first.
12. Run final bounded fixed-point discovery.
13. Return success only when every owned identity is proven absent and the final fixed point
    completed without error or limit exhaustion.
14. Otherwise return `failure: cleanup`.

When the root has disappeared, the tree is not assumed gone. Previously verified known
descendant identities remain seeds. Exact fallback is allowed only after immediate identity
revalidation; a reused root or descendant PID is never terminated.

## 9. Termination success invariant

None of the following proves cleanup success:

- root close;
- root exit;
- numeric root PID absence;
- `taskkill` exit code zero;
- nonzero `taskkill` plus root closure;
- exact `kill()` return;
- helper close without identity-aware absence verification;
- deadline expiry.

Cleanup succeeds only when final bounded fixed-point verification proves:

```text
the original root identity is absent
and every known descendant identity is absent
and the fixed-point verification completed without error or limit exhaustion
```

If proof cannot be completed, the result is `failure: cleanup`. No background cleanup starts
or continues after this result.

## 10. Canonical trusted-helper termination

Execution timeout, stdout limit, and stderr limit use one internal helper-termination
function. It applies to every trusted spawned helper and uses identity rather than numeric
PID absence alone.

Required helper sequence:

1. Capture the Node-owned child handle, PID, expected canonical executable, spawn time, and
   trusted creation-time identity evidence.
2. Stop accepting output.
3. Request termination once through the exact owned child handle.
4. Wait within the original utility deadline for `close`.
5. Verify through trusted process evidence that the original PID-plus-creation identity is
   absent. A reused PID is unrelated and is not killed.
6. Return helper cleanup success only when both close and original-identity absence are
   proven.
7. Return helper failure when close or identity absence cannot be proven.

The utility deadline is not extended by output-limit handling. One idempotent settlement
path clears all timers, listeners, and buffers. No delayed helper cleanup survives
settlement.

## 11. Command timeout and output-limit unification

These command-probe terminal causes all enter the same identity-aware
`WindowsOwnedProcessTreeCleaner` path:

```text
execution timeout
stdout limit exceeded
stderr limit exceeded
```

Every path stops accepting output, performs the same bounded cleanup, and waits for its
result. The original cause is returned only when cleanup succeeds:

```text
timeout + cleanup proven       -> failure: timeout
stdout limit + cleanup proven  -> failure: stdout_limit
stderr limit + cleanup proven  -> failure: stderr_limit
any cause + cleanup unproven   -> failure: cleanup
```

There is no separate partial cleanup path for stdout or stderr.

## 12. Hard limits

| Limit                               |         Binding value | Enforcement                                                                                           |
| ----------------------------------- | --------------------: | ----------------------------------------------------------------------------------------------------- |
| Maximum snapshot rounds             |   8 total per cleanup | Shared across initial, post-taskkill, survivor, and final verification; needing round 9 fails cleanup |
| Maximum owned identities            | 256 total per cleanup | The 257th candidate fails cleanup                                                                     |
| Version-probe execution timeout     |              2,500 ms | One command execution deadline                                                                        |
| Total process-tree cleanup deadline |              5,000 ms | One deadline shared by every discovery, utility, fallback, and verification step                      |
| Version-probe stdout                |          65,536 bytes | Separate hard limit                                                                                   |
| Version-probe stderr                |          65,536 bytes | Separate hard limit                                                                                   |
| Trusted-helper captured output      | 65,536 bytes combined | Output limit enters canonical helper termination                                                      |
| Stress iterations                   |                    25 | Every iteration must observe the race                                                                 |
| Consecutive Windows-suite passes    |                    10 | Complete applicable suite, zero skip/orphan                                                           |
| Test PID-file acquisition           |              2,000 ms | Condition polling, not sleep-only proof                                                               |
| Test race observation               |              2,000 ms | Must occur while runner remains pending                                                               |
| Per-iteration outer test bound      |             10,000 ms | Includes 2,500 ms execution plus 5,000 ms cleanup and bounded harness overhead                        |
| Emergency exact-PID absence wait    |              2,000 ms | Test-only cleanup evidence                                                                            |

The total cleanup deadline is an explicitly reviewed adjustment from the original 500 ms.
The third-remediation Windows stress work showed that three independent trusted PowerShell
snapshots could exceed three seconds under host scheduling. The exact 5,000 ms value remains
one total deadline; it is never multiplied by helper calls or snapshot rounds. Deadline tests
must prove this.

## 13. Deterministic race requirement

Each stress iteration must:

1. Start the runner without awaiting completion.
2. Acquire the test-owned root and descendant identities within 2,000 ms.
3. Observe process identities through trusted process evidence while the runner promise is
   still pending.
4. Prove this exact state within the next 2,000 ms:

   ```text
   original root identity absent
   at least one identity-validated descendant alive
   runner not settled
   ```

5. Record `raceObserved: true` with the root and descendant identities.
6. Await runner completion within the 10,000 ms iteration bound.
7. Prove the original root identity and every recorded descendant identity are absent.
8. Prove no fixture/helper process remains.

The test harness may hold its injected termination seam until the observed race condition is
fulfilled, making the race deterministic. Production cleanup receives no artificial delay.
Sleeps alone are never evidence, and fixture design is never substituted for observation.
Failure to observe the race fails the iteration.

## 14. Stress and repeat acceptance

Binding stress result:

```text
25/25 iterations:
- root-absent / descendant-alive / runner-pending race observed;
- production runner cleanup completed;
- original root identity absent;
- every known descendant identity absent;
- no fixture/helper process remained;
- test emergency cleanup was not required for a successful iteration.
```

Binding Windows-focused result:

```text
10 consecutive complete passes
0 failed
0 silent skips or early-return passes
0 orphan processes
```

The current Windows host must execute command-shim, orphan-descendant, trusted-utility,
ambient-PATH-substitution, helper-termination, and stress tests. An explicit platform skip is
allowed only on a genuinely unsupported non-Windows host; a silent early return is a blocking
defect.

A later focused green result never overrides an earlier canonical failure.

## 15. Test fixture emergency cleanup

Emergency cleanup belongs only to test code. It uses exact test-owned identities, runs from
`finally` after failed/aborted work, and separately records:

```text
productionCleanupResult
testEmergencyCleanupResult
```

It never changes or masks the production runner result. If emergency cleanup is required
during a supposedly successful iteration, that iteration fails. Emergency cleanup must
prove absence of both the original root identity and every recorded descendant identity;
it never kills by name or broad process selection.

## 16. Required red-first order

The later implementation plan must enforce this order:

1. Reproduce the canonical orphan failure or its precise current regression test.
2. Add a failing known-seed/dead-parent fixed-point test.
3. Add failing multi-round stability, eighth-round growth, and 257th-identity tests.
4. Add failing initial-discovery fail-closed tests proving no tree or exact kill occurs.
5. Add failing helper identity, close, reuse, and absence tests.
6. Add failing timeout/stdout/stderr canonical-termination tests.
7. Add a failing real race-observation stress assertion.
8. Add failing emergency-cleanup evidence separation where needed.
9. Make only the minimum production changes required by those tests.
10. Run focused tests.
11. Run 25 observed-race iterations.
12. Run the complete Windows suite ten consecutive times.
13. Run canonical `pnpm test` once; any failure stops the remediation.
14. Run all repository gates.
15. Request a new independent read-only review.

No production behavior change precedes its failing regression test. A minimal injected test
seam is permitted only when it does not alter runtime behavior and has its own test.

## 17. Canonical gates

The later implementation must run:

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

Required results:

- all discovered unit tests pass with zero failure;
- every applicable Windows test executes and passes;
- Redis integration reports 15/15 files and 41/41 tests with no missing-config skip;
- format, typecheck, lint, build, and diff check pass;
- no owned fixture/helper/daemon process remains;
- ports 4782 and 4783 are free;
- daemon owner and active validation presence are absent;
- no dependency or lockfile drift exists;
- no ACP/Goose dependency or dashboard Redis access exists;
- staged count remains zero and no commit, branch, tag, push, merge, reset, stash, or clean
  occurs.

## 18. Stop conditions

Stop without destructive fallback or publication when any of these occurs:

- the first snapshot cannot prove root ownership;
- any snapshot/helper data is malformed or identity evidence is missing;
- a known PID resolves to a mismatched creation identity;
- round eight still adds an identity;
- the 257th owned identity would be added;
- a trusted utility cannot be resolved canonically;
- helper close plus original-identity absence cannot both be proven;
- a command timeout/output-limit cleanup cannot prove the owned tree absent;
- any owned descendant identity remains after final verification;
- a stress iteration does not observe the real race while the runner is pending;
- emergency cleanup is required during a purportedly successful iteration;
- canonical `pnpm test` fails once;
- repeat testing exposes an orphan after focused tests pass;
- an ambient PATH utility, image-name kill, or broad process kill is used;
- cleanup continues after settlement;
- new evidence contradicts the dashboard Option B closure;
- any new Critical or Important finding appears.

## 19. Formal acceptance criteria

This specification is implementation-ready only because it establishes all of the following:

1. Initial ownership is proven before destructive cleanup.
2. Discovery reaches a bounded fixed point.
3. Every captured table is traversed to local exhaustion.
4. Dead intermediate parents remain valid seeds unless their PID has been reused.
5. All known identities seed every relevant subsequent discovery.
6. Root close is never treated as tree cleanup.
7. PID reuse cannot cause unrelated termination.
8. Helper cleanup uses identity-aware absence.
9. Timeout and output-limit paths share canonical cleanup.
10. Stress observes the actual root-absent/descendant-live race before runner settlement.
11. Final success requires verified absence of every owned identity.
12. Round, identity, output, helper, and total-deadline limits fail closed.
13. No ambient PATH or image-name cleanup exists.
14. Dashboard Minor scope is excluded with current source, tests, and independent evidence.
15. Canonical and repeated Windows tests are binding.
16. No dependency or architecture widening is introduced.

## 20. Rejected approaches

Unbounded or independently timed full-table scans are rejected because they multiply
timeouts and still require known-identity seeding. A third-party process-tree package or
native addon is rejected because it conflicts with the lightweight dependency-independent
architecture and is unnecessary for the bounded invariant. PID-only verification and
best-effort destructive cleanup are rejected because they permit PID-reuse termination or
false cleanup success.

## 21. Specification self-review

The corrected specification was checked against the failed independent third-remediation
review and every requirement in the correction request.

Corrections made:

- resolved the dashboard contradiction through Option B with current source/test paths and
  newer independent-review evidence;
- distinguished PID address from stable process identity and applied the rule to root,
  descendants, and all trusted helpers;
- required the first snapshot to prove the root before any destructive action;
- specified local traversal exhaustion, multi-snapshot fixed point, dead-parent seeding,
  reuse rejection, one shared eight-snapshot cleanup cap, and the 256-identity cap;
- made final identity absence—not close, kill return, or numeric PID absence—the only
  success proof;
- unified timeout/stdout/stderr command cleanup and trusted-helper termination;
- recorded one non-multiplying 5,000 ms total cleanup deadline and every other hard limit in
  one table;
- required observed, not inferred, race evidence and separated emergency cleanup evidence;
- added explicit canonical gates and stop conditions.

No undefined placeholder, open failure path, timeout multiplication, PID-only absence rule,
or untestable acceptance criterion remains. The document is ready for external formal
architectural approval; it does not self-approve implementation.
