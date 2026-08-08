# Phase 5B blocker remediation manifest

Date: 2026-08-05

This manifest records remediation evidence only. It is not a release checkpoint or an
approval of the complete Phase 2-5B candidate diff.

| Finding                                            | Root cause                                                                                                                                                                              | Files changed                                                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                         | Tests                                                                                                                                                                    | Manual verification                                                                                                                                            | Remaining limitation                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Important 1: unbounded native detection            | The spawn runner accumulated both output streams and waited for process exit without policy bounds.                                                                                     | `packages/adapters/src/node-collaborators.ts`, `types.ts`, `adapter.ts`, related tests and README                                                                                                                                                           | Shell-free probes now have a 2.5 s timeout, separate 64 KiB stdout/stderr limits, two bounded kill attempts, safe failure results, and sibling-safe detection.                                                                                              | Normal, missing, hanging, post-timeout PID, noisy stdout, noisy stderr, shell-literal, and sibling detection cases pass.                                                 | Not applicable; tests use controlled Node fixtures rather than installed agent products.                                                                       | A failed probe intentionally exposes no partial version output.                                                                                            |
| Important 2: manifest symlink escape               | Lexical containment was checked before file APIs followed the final symlink target.                                                                                                     | `apps/daemon/src/package-inventory.ts` and `.test.ts`                                                                                                                                                                                                       | The scanner canonicalizes the root and target, rechecks relative containment, opens and reads only the stable canonical regular file, and rejects escape, breakage, directories, changes, and oversize targets. In-root links are allowed.                  | Ordinary, external junction, no external-content leak, in-root link, broken link, directory link, nested root, and non-Git fallback cases pass.                          | Windows junction security cases executed in the full unit run.                                                                                                 | Link creation remains privilege-aware on platforms that restrict it; the test attempts a Windows junction before treating platform refusal as unsupported. |
| Important 3: first-live consistency gap            | Only reconnecting-to-live caused a full refresh, leaving the initial REST/subscription interval uncovered.                                                                              | `apps/dashboard/src/main.tsx`, `realtime/invalidation.ts`, and `.test.ts`                                                                                                                                                                                   | A small state-edge coordinator invalidates all eight Phase 5B resources on every edge into `live`, including Activity; duplicate live notifications are inert and existing coalescing/generation/abort behavior is retained.                                | Mutation-before-first-live, all-resource refresh, immediate-event coalescing, duplicate live, reconnect, stale generation, and failure-preservation tests pass.          | Production showed live snapshots and retained one copy of the real validation event across a real reconnect.                                                   | The WebSocket still has no backlog cursor, so REST remains the authoritative recovery path.                                                                |
| Important 4: incomplete secure Vite WebSocket path | `/api` lacked WebSocket proxying; the dev origin was not explicitly allowed; the proxy forwarded the dev Host; and the dashboard package barrel evaluated a Node crypto module in Vite. | `apps/dashboard/vite.config.ts` and `.test.ts`, daemon config test, `apps/dashboard/src/api/pulse.ts`, `packages/protocol/package.json`, `browser.ts`, `runtime-state.ts`, `runtime-api.ts`, `runtime-http.ts`, `vitest.config.ts`, docs and `.env.example` | `/api` enables `ws`, both proxies target loopback and normalize only upstream Host, the daemon accepts 4783 only through explicit configuration, and a browser-only protocol subpath excludes Node runtime factories.                                       | Host/proxy/origin tests and an in-memory Vite bundle test proving no `node:crypto` external pass.                                                                        | Both 4782 and 4783 loaded Pulse, REST data, and `Realtime live` with clean consoles. Direct handshakes: 4783 opened; 4784 and an external origin returned 403. | Development requires the documented explicit `LUWI_ALLOWED_ORIGINS`; production defaults remain unchanged.                                                 |
| Important 5: Active Sessions semantics             | Header and body cells used different DOM orders.                                                                                                                                        | `apps/dashboard/src/pulse/pulse-view.tsx` and `app.test.tsx`                                                                                                                                                                                                | Headers and cells now use Agent, Project, State, Started, Last heartbeat, Inspect; Inspect remains a labeled native button in the final column.                                                                                                             | Header/cell order, accessible action, keyboard activation, empty, and unavailable semantics pass.                                                                        | The real browser exposed the same six-column order and opened the Session inspector.                                                                           | No responsive visual redesign was added.                                                                                                                   |
| Important 6: incomplete inspectors                 | Inspectors rendered only base fields and payload, without the accepted retained joins or supported navigation.                                                                          | `pulse/model.ts`, `app.tsx`, `inspectors/inspector-panel.tsx` and `.test.tsx`, `styles/activity.css`                                                                                                                                                        | Project/session inspectors show at most 20 newest deduplicated matching retained events; active duration uses `now - startedAt`; terminal duration is unavailable without a real end field; Event navigation resolves only known project/session snapshots. | Bounds, ordering, filtering, empty text, active/terminal/invalid duration, both navigation targets, missing targets, unknown events, Escape, and focus restoration pass. | Real project and session inspectors showed retained events; active duration rendered; both Event navigation buttons opened the correct inspector.              | Related events are a retained local window, not complete history. The session schema has no end timestamp, so terminal duration remains unavailable.       |
| Minor: missing live-region summary                 | Incoming accepted Activity additions had no bounded assistive announcement channel.                                                                                                     | `apps/dashboard/src/activity/activity-view.tsx` and `.test.tsx`                                                                                                                                                                                             | One hidden polite atomic region aggregates unique additions for 750 ms, distinguishes paused accumulation, ignores hydration/filtering/duplicates, caps pending work, and clears its timer.                                                                 | Single, burst, duplicate, paused, hydration, continuous-burst, and unmount fake-timer cases pass.                                                                        | DOM semantics were inspected through the browser; screen-reader speech output was not hardware-tested.                                                         | Announcements intentionally summarize batches rather than enumerate events.                                                                                |

## Verification summary

- `pnpm format`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm test`: 89 files, 458 tests passed.
- `pnpm test:integration`: 15 files, 41 tests passed with explicit Redis configuration.
- `pnpm build`: passed; the final dashboard build emitted no Node-external warning.
- `git diff --check`: passed.
- Browser verification: production and Vite development paths loaded validated REST data,
  reached `Realtime live`, and had no new console warning or error.
- Temporary processes, scripts, logs, and local verification homes were removed; ports 4782
  and 4783 were free afterward. The deliberately created Redis validation events were not
  deleted.

The next session must independently review all seven findings, the complete Phase 2-5B
candidate diff, and checkpoint path classification.

## Second blocker remediation

Date: 2026-08-05

This section records the six findings from the second independent review. It does not
approve or checkpoint the Phase 2-5B candidate diff.

| Finding                                   | Exact reproduction and root cause                                                                                                                                                                                                                           | Implementation and security boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tests and focused verification                                                                                                                                                                                                                                   | Remaining limitation                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Important: Windows command-shim rejection | Spawning a real absolute `.cmd` path directly with Node and `shell: false` produced `spawn EINVAL`. The rejected runner promise crossed the adapter boundary and could reject the service-level detection batch.                                            | Direct executables remain direct, shell-free probes. Absolute `.cmd`/`.bat` paths use a validated absolute `ComSpec`, `/d /s /c`, fixed quoting, and literal `--version` only, while Node `shell` remains false. The third remediation removed every ambient utility fallback; see the current policy below. NUL, control, quote, percent, and delayed-expansion metacharacters are rejected. Spawn throws, process errors, rejected probes, non-zero exits, and malformed output degrade only that installation to unavailable.               | A repository-owned real shim, child shim, rejection isolation, service sibling survival, timeout, noisy output, literal-argument, and listener/timer tests execute on Windows. A benign installed `pnpm.cmd --version` probe returned `11.9.0` without `EINVAL`. | This is intentionally a version-probe runner, not a general command-script execution API.                              |
| Minor: runner cleanup                     | Terminal outcomes previously left cleanup distributed across event paths, so timers, listeners, and captured buffers were not explicitly finalized through one path.                                                                                        | One idempotent settlement path stops accepting output, clears timers, detaches child and stream listeners, and releases buffers. The former direct-child/root-close success rule was insufficient and is superseded by the third-remediation verified owned-tree model below; no path kills by image name.                                                                                                                                                                                                                                     | Controllable-child tests inspect listener counts and timer cleanup, and prove late events do not change the settled result. Real hanging/noisy Windows fixtures prove bounded termination and no owned child remains.                                            | Cleanup failure is reported as a bounded probe failure; LUWI does not become a general process supervisor.             |
| Important: manifest ABA and read growth   | The path could change outside during `open()` and return inside before the second canonical-path check, while the opened handle still referenced the outside file. A small pre-read `stat().size` also did not bound a later `readFile()` if the file grew. | The scanner canonicalizes and contains the target, opens it read-only, obtains bigint handle identity, canonicalizes and contains the candidate again, obtains bigint final-path identity, and requires matching non-zero device/inode identities and regular-file types before reading. The already-open handle is then read positionally in at most 64 KiB chunks, observing no more than 2 MiB plus one overflow byte, and is always closed. Unavailable or placeholder identity fails closed. Diagnostics do not disclose outside content. | Deterministic injected-operation tests reproduce same-path/different-inode ABA, small-stat/later-growth overflow, stable success, and handle closure. Real ordinary, link/junction, nested-root, and fallback cases remain covered.                              | Filesystems that cannot provide usable stable identity are rejected instead of being scanned.                          |
| Important: inconsistent Event navigation  | With `event.projectId = p1`, `event.sessionId = s2`, and authoritative `s2.projectId = p2`, the inspector previously exposed both unrelated targets.                                                                                                        | Project and Session actions resolve from current snapshots on every render. A session-only reference may open its known session. When both IDs exist, Session is offered only if its authoritative `projectId` equals the event project. On mismatch the independently valid Project action remains, Session is suppressed, and a read-only explanation is shown. The event payload is never corrected or treated as authority.                                                                                                                | The exact two-project mismatch, coherent references, missing references, session-only/project-only events, keyboard behavior, focus return, and snapshot invalidation are covered by DOM tests.                                                                  | Navigation is limited to retained Project and Session snapshots; no agent, task, file, or commit navigation was added. |
| Minor: refresh-in-progress semantics      | A retained snapshot remained labeled current while an authoritative REST generation was in flight.                                                                                                                                                          | The existing refresh controller remains the sole freshness owner and now emits `current`, `refreshing`, `stale`, or `unavailable`. Safe retained data stays visible during refreshing; success returns to current; a failed or partial generation preserves safe resource data and reports stale/unavailable per resource availability. Accessible status text identifies an in-flight refresh.                                                                                                                                                | Controller and App tests cover first load/live and reconnect-style refresh, retained data, success, partial failure, total failure, obsolete generations, abort, and stop behavior.                                                                              | Very short refreshes may be perceptually brief; no artificial delay or duplicate state owner was introduced.           |
| Minor: session duration clock             | The duration helper could call the clock separately for visible and accessible text and had no bounded update source.                                                                                                                                       | The inspector captures one `nowMs`, derives one duration string for both representations, and owns one 60-second interval only while a selected non-terminal Session needs it. Navigation/status changes and unmount clear the interval. Invalid, negative, and terminal-without-end durations remain unavailable.                                                                                                                                                                                                                             | Fake-timer tests prove minute-boundary consistency, one clock value, 60-second advancement, absence of high-frequency updates, and cleanup on state change and unmount.                                                                                          | The protocol still has no terminal end timestamp, so terminal duration remains unavailable.                            |

Closure review tightened two boundaries before handoff. Manual Retry now routes through the
same coalesced refresh controller as first-live, reconnect, and realtime invalidation;
bootstrap with no ready resource is `unavailable`. The second-pass Windows settlement model
described here was later proven insufficient by a real descendant orphan. Its root-close and
500 ms assumptions are superseded by the verified third-remediation model below.

The final independent review must re-evaluate these six remediations and the complete
candidate diff for new Critical or Important regressions. Verification totals and browser
evidence are recorded only after fresh closure gates complete.

### Second remediation verification summary

- `pnpm format`, `pnpm typecheck`, and `pnpm lint`: passed.
- `pnpm test`: 89 files and 488 tests passed on Windows. The process-tree tests ran with
  host permission to terminate only their owned exact PID trees.
- `pnpm test:integration`: 15 files and 41 tests passed with explicit
  `LUWI_TEST_REDIS_URL` and shared Function-library permission; no file was skipped for
  missing configuration.
- `pnpm build`: passed and emitted the production dashboard bundle.
- `git diff --check`: passed.
- Focused Windows runner/service verification passed 49 tests. The real benign local
  `pnpm.cmd` shim returned `11.9.0` through the bounded runner without `EINVAL`; hanging
  and noisy fixtures terminated without an owned child remaining.
- Package-inventory security verification passed all 13 tests. Deterministic ABA and
  concurrent-growth cases executed, and the supported Windows junction cases executed
  without a skip.
- Production browser verification at `http://127.0.0.1:4782/` loaded the existing snapshot,
  reached `Realtime live`, accepted a new Session through realtime invalidation, and updated
  one Session duration from `0 minutes` to `1 minute` on the bounded tick. Console warnings
  and errors were empty.
- A temporary read-only daemon fixture served the same production dashboard assets without
  writing Redis. It visibly held Project and Session data through the first-live
  `Refreshing snapshot` state, returned to `Validated snapshot`, exposed both coherent
  navigation actions, exposed only the valid Project action plus the mismatch explanation
  for `event.projectId = p1`, `event.sessionId = s2`, `s2.projectId = p2`, and removed a
  formerly valid Session action after a snapshot invalidation. Its browser console was
  empty.
- A second production-asset fixture verified that visible manual Retry enters
  `Refreshing snapshot` through the same controller, keeps `Retained Retry Project`
  visible, returns to `Validated snapshot`, and emits no console warning/error.
- Temporary daemon/fixture processes, logs, scripts, and local verification homes were
  removed. Retained Redis events were not deleted.
- No production dependency was added by this remediation.

These results prepare evidence for, but do not replace, the required final independent
review or approve the checkpoint.

## Third blocker remediation

Date: 2026-08-05

No checkpoint, branch, tag, stage, commit, push, merge, reset, stash, or clean was performed.

| Finding                                        | Exact reproduction and root cause                                                                                                                                                                                                                                                                                                                                             | Implementation and security invariant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Deterministic tests and stress result                                                                                                                                                                                                                                                                                                                                                                                                                 | Remaining limitation                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Important: ambient Windows utilities           | Test-local fake `cmd.exe`/`taskkill.exe` earlier on `PATH` could be selected when trusted lookup failed. The resolver treated an untrusted ambient name as a fallback.                                                                                                                                                                                                        | One narrow resolver validates raw `SystemRoot`/`windir`/`ComSpec`, canonicalizes the Windows directory, requires regular files with exact case-insensitive basenames inside its canonical System32 directory, and returns only absolute paths. Relative, quoted, argument-bearing, control-bearing, and out-of-directory `ComSpec` values are ignored. If canonical `cmd.exe` is unavailable, `.cmd`/`.bat` detection is `unavailable`; if canonical `taskkill.exe` is unavailable, cleanup cannot claim success. No production spawn uses a bare utility or searches `PATH`.                                                                                                                                                            | Resolver tests cover canonical SystemRoot utilities, valid/invalid ComSpec variants, case-insensitive comparison, missing utilities, and malicious test-local PATH entries. Neither fake utility executes.                                                                                                                                                                                                                                            | The policy intentionally supports only System32 `cmd.exe`, `taskkill.exe`, and the fixed WindowsPowerShell helper; it is not a generic binary resolver.                                                                                                                                                      |
| Important: early-root-close descendant orphan  | The canonical suite hung at `expect(() => process.kill(pid, 0)).toThrow()` after a `.cmd` root exited while its Node descendant remained alive. The reproduced owned root PID was `18668` with descendant PID `54128`; the focused legacy fixture separately left descendant PID `24600` after root PID `31356` exited. The shortcut accepted child closure as cleanup proof. | The runner records the spawned root PID and immediately bounded descendants. A fixed encoded, profile-free, non-interactive Toolhelp32Snapshot helper runs only through canonical absolute Windows PowerShell with `shell: false` and strict bounded JSON. The cleaner captures exact PID/parent/start-ticks/executable identities, invokes canonical `taskkill /PID <root> /T /F` only for a reuse-safe root, verifies all known identities, applies deepest-first exact-PID fallback where identities still match, and verifies again. Root close, root absence, nonzero taskkill, or deadline alone is never success. Cleanup succeeds only when no verified owned identity remains; otherwise the runner returns `failure: cleanup`. | Forty-two focused utility/cleanup tests pass, including real early-root-close and emergency cleanup, helper error/timeout/malformed/limit, taskkill zero/nonzero/error/timeout, known descendants after root exit, PID reuse, sibling isolation, and bounded settlement. `pnpm test:windows-cleanup-stress` completed 25 unique fixtures with 25 successes and zero surviving owned PIDs. The focused Windows suite then passed ten consecutive runs. | The total termination-only cleanup budget is 5,000 ms rather than the former 500 ms. Windows stress showed that three independent trusted PowerShell snapshots can exceed three seconds under host scheduling. Normal successful probes retain the 2,500 ms probe timeout and separate 64 KiB stream limits. |
| Minor: invalid Session start opens a timer     | The inspector displayed `Unavailable` for invalid/missing/future `startedAt` but the effect predicate still created a 60-second interval.                                                                                                                                                                                                                                     | The interval exists only for an ID-selected current Session that is nonterminal, has a finite parsed start, and satisfies `nowMs - startedAt >= 0`. Session identity/start/status form the effect key, so refresh, navigation, close, and unmount deterministically clear or replace the timer.                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fake-timer tests cover valid, invalid, missing, future, terminal, refreshed valid/invalid/terminal, repeated render, close, and unmount cases using actual timer counts.                                                                                                                                                                                                                                                                              | Terminal duration remains unavailable because the protocol has no terminal end timestamp.                                                                                                                                                                                                                    |
| Minor: stale Project/Session inspector objects | Selection state retained canonical entity objects, so REST/realtime refresh changed the main snapshot while the open inspector kept old status, timestamps, duration, name, path, or actions.                                                                                                                                                                                 | Selection stores only `{ projectId }`, `{ sessionId }`, or `{ streamId }`. Every render resolves Project/Session from current authoritative collections and Event from the current bounded Activity window. Missing/evicted entities show a restrained unavailable state with no stale entity action. Event navigation continues to require current coherent Project/Session ownership.                                                                                                                                                                                                                                                                                                                                                  | App and inspector tests replace snapshots while dialogs remain open and cover Project metadata, Session terminal/invalid/valid transitions, entity deletion, Event eviction/ownership change, Escape/focus, and repeated refresh without timer accumulation.                                                                                                                                                                                          | Event selection becomes unavailable when its stream ID is evicted from the retained Activity window; it intentionally does not keep a second immutable event store.                                                                                                                                          |

### Third remediation verification summary

- The benign source runner executed the validated absolute `pnpm.cmd --version` and returned
  exit code 0, stdout `11.9.0`, empty stderr, and no `EINVAL`.
- Focused adapter/process cleanup passed 42 tests; adapter plus daemon sibling-isolation
  coverage passed 29 tests; dashboard App/inspector coverage passed 35 tests.
- The exact early-root-close stress command completed 25/25 unique iterations with zero
  surviving owned PIDs. The focused Windows suite passed ten consecutive runs.
- `pnpm test` passed 90 files and 519 tests. Configured Redis integration passed 15 files and
  41 tests with no missing-configuration skip. Format, typecheck, lint, build, and
  `git diff --check` passed.
- The production dashboard at `http://127.0.0.1:4782/` reached `Realtime live`. A live
  ID-selected Session inspector updated from `starting`/online to `completed`/offline without
  close/reopen, terminal duration became `Unavailable`, Event-to-Session navigation resolved
  the current terminal snapshot, the Project inspector resolved the current project, and
  browser application logs contained no warning/error. Invalid/future timestamps and
  changed/deleted authoritative snapshots cannot be injected through the validated
  production API; their refresh behavior was therefore verified in deterministic rendered
  DOM/fake-timer tests rather than claimed as a live server mutation.
- The exact cleanup window adjustment is documented above. No production dependency was
  added and the lockfile hash remained unchanged by this remediation.

These results are evidence for a new read-only independent re-review. They do not approve or
create a Phase 5B checkpoint.

## Fourth blocker remediation

Date: 2026-08-05

This section supersedes the third remediation's weaker root-oriented discovery and stress
proof. It preserves that section as historical evidence; it does not claim that the earlier
commands were not run. No checkpoint, branch, tag, stage, commit, push, merge, rebase, reset,
stash, clean, or publication operation was performed.

### Corrected cleanup invariant

The remaining defect had two coupled causes. Discovery was not guaranteed to feed every
previously verified identity back into every traversal, so a dead intermediate parent could
hide a live descendant. Initial discovery failure could also reach a destructive `/T` path
without complete ownership proof. The corrected internal identity is PID plus exact creation
ticks, parent PID, executable name, and canonical executable path when Windows exposes it.
Parentage derives ownership, while later reparenting does not change an already proven
identity. A reused PID is unrelated and is never killed as part of the old tree.

One cleanup context owns the verified root, every known identity, one absolute 5,000 ms
deadline, one global eight-snapshot counter, and a 256-identity limit. Snapshot traversal is
seeded with the root and every known identity, including dead intermediate parents, and runs
to local exhaustion. A newly discovered identity requires another full snapshot. Growth on
snapshot eight, a required snapshot nine, a 257th identity, malformed evidence, or exhausted
unproven evidence fails closed. A short-lived Windows state in which Toolhelp still exposes
a dying row but creation/path evidence cannot be read is classified as `unproven`, not PID
reuse, and may consume another snapshot from the same global budget. It never authorizes a
kill.

The first trusted snapshot must prove the spawn-bound root using PID, parent, creation-time
window, executable name, and canonical root path, then complete the initial fixed point.
Until that gate succeeds there is no `taskkill`, exact termination, delayed fallback, or
background cleanup. After proof, the bounded sequence is: revalidate the root, conditionally
invoke canonical `taskkill.exe /PID <root> /T /F`, run the post-termination fixed point,
immediately revalidate and terminate matching survivors deepest-first, and use the remaining
global snapshots to prove final absence. Root close, taskkill return, exact-kill return, or
deadline alone is never success.

Only canonical absolute System32 `cmd.exe`, `taskkill.exe`, and the fixed encoded
WindowsPowerShell helper are used with `shell: false`; ambient `PATH`, `where.exe`, bare
utilities, image-name kills, and caller-provided PowerShell are absent. The helper emits a
strict identity header and bounded process envelope. Timeout and combined helper-output
limits share one kill-once, close-bound settlement path. Runner timeout, stdout overflow, and
stderr overflow all enter the same canonical owned-tree cleanup and preserve their distinct
`timeout`, `stdout_limit`, or `stderr_limit` cause only after verified absence; unproven
cleanup maps to `cleanup`. The runner no longer has a second timer that can settle while its
canonical cleanup promise continues in the background.

### Deterministic race and focused evidence

The repository-owned `early-root-close.cmd` fixture accepts only renderer-controlled
`__NODE_EXE__`, `__EVIDENCE_PATH__`, and `__ROOT_RELEASE_PATH__` values. The test and stress
harness hold the injected termination seam, release the root, and use trusted snapshot
evidence to prove, before runner settlement, that the original root identity is absent, an
identity-validated descendant remains alive, and the runner is pending. Test-only emergency
cleanup revalidates exact fixture identities, is recorded separately, and cannot alter the
production result.

- `pnpm test:windows-cleanup-stress 25` passed 25/25 iterations: 25 exact races observed,
  zero cleanup failures, zero emergency cleanup uses, and zero surviving fixture processes.
- The complete Windows-focused cleaner/runner suite passed 10/10 consecutive invocations;
  every invocation ran two files and 55 tests on Windows with no skip or orphan.
- The four remediation-sensitive files passed together: 4 files and 84 tests, including
  adapter and daemon sibling-isolation coverage.
- The source runner executed the resolved absolute `pnpm.cmd --version` and returned exit
  code 0, stdout `11.9.0`, empty stderr, and no `EINVAL`.
- Focused cleaner coverage passed 26 tests, including dead-parent fixed point, shared
  snapshot exhaustion, 257th identity, initial no-kill failures, helper lifecycle,
  temporary unreadable evidence, bounded close verification, reuse, and final survivor
  refusal.

No dashboard source, ACP/Goose behavior, dependency, datastore, package boundary, release
document, checkpoint, or Git publication was added by this remediation. The lockfile and
dependency manifests were reserved for the final hash/diff audit below; no passing result
was claimed before its command completed.

### Fourth remediation final verification

The first final-preparation formatting check found one unformatted internal enum rename; it
was formatted. The first restarted lint check then found one `prefer-const` and one
no-useless-assignment error; both were corrected without changing cleanup behavior. A fresh,
complete gate sequence from the corrected tree produced the following binding evidence:

- `pnpm format`: passed; every discovered file matched Prettier.
- `pnpm typecheck`: passed for the dashboard and the strict TypeScript project references.
- `pnpm lint`: passed with zero errors and warnings.
- `pnpm test`: 90/90 files and 532/532 tests passed. The Windows race executed in the
  canonical suite rather than skipping and left emergency cleanup unused.
- Explicitly configured `pnpm test:integration`: 15/15 files and 41/41 tests passed, with no
  missing-configuration skip.
- `pnpm build`: passed, including the dashboard production bundle and TypeScript build.
- `git diff --check`: passed; the displayed Windows line-ending notices are warnings, not
  whitespace errors.

The residual-state audit found ports 4782 and 4783 free, daemon-owner absent, no presence
keys, no active sessions, no pending inbox entries, and no claim/lease/lock key. Historical
completed/disconnected Session projections were left intact. The fixture/stress temporary
directories were absent; the 25-iteration harness and canonical test finalizers had already
re-probed their exact identities and reported zero survivors. No late cleanup was running.

The final lockfile SHA-256 remained
`79a62b422430f9197dc8421d7eb400a182ba7fc2a9d69b782ae319a828ff1072`, identical to the
frozen value. The staged path count remained zero. Git refs remained only `master` and the
pre-existing `phase-1-projects-sessions` tag; no checkpoint or remote ref appeared. The wider
uncommitted Phase 2-5B candidate already contained manifest and lockfile diffs at the frozen
baseline, but this remediation added no dependency and did not alter that lockfile hash.

The final source audit found no `shell: true`, `/IM`, `where.exe`, ambient utility fallback,
bare taskkill spawn, image-name kill, public process API export, delayed post-settlement
cleanup, or dashboard change in this remediation. The only production `taskkill.exe` text is
the canonical System32 resolver. This evidence requests a new independent read-only review;
it does not self-approve, checkpoint, release, or publish Phase 5B.
