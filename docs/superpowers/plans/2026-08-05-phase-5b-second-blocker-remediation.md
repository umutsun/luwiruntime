# Phase 5B Second Blocker Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three Important and three related Minor Phase 5B findings without widening the product or persistence architecture.

**Architecture:** Keep native probes behind the adapter runner, manifest reads behind a narrow identity-checked file-operation seam, and dashboard state inside the existing refresh and inspector boundaries. Each change is introduced with a failing behavioral test, then the minimum production change, focused verification, and finally the complete repository gates.

**Tech Stack:** Node.js 22+, TypeScript strict ESM, React 19, Vitest, Fastify, standard Node filesystem/process APIs, Redis 7 integration tests.

## Global Constraints

- Do not add a production dependency.
- Do not use `shell: true`, a general shell utility, broad process kills, or vendor-name dispatch.
- Do not add persistence, dashboard-to-Redis access, ACP, Goose, tasks, leases, or unrelated UI.
- Do not branch, stage, commit, tag, push, merge, reset, stash, clean, or modify the temp mockup.
- Preserve the 2.5-second probe timeout, 500-millisecond cleanup bound, and separate 64 KiB stdout/stderr limits.
- Preserve the 2 MiB manifest limit and fail closed when stable file identity cannot be proven.

---

### Task 1: Windows command-shim runner and detector isolation

**Files:**

- Modify: `packages/adapters/src/node-collaborators.test.ts`
- Modify: `packages/adapters/src/node-collaborators.ts`
- Modify: `packages/adapters/src/adapters.test.ts`
- Modify: `packages/adapters/src/adapter.ts`
- Modify: `apps/daemon/src/control-plane-service.test.ts`
- Modify: `apps/daemon/src/control-plane-service.ts`

**Interfaces:**

- Consumes: `AdapterCommandRunner.run(executable, ['--version'])`.
- Produces: a bounded runner that dispatches absolute `.cmd`/`.bat` paths through validated `ComSpec /d /s /c`, and detection batches that normalize only external probe rejection to unavailable.

- [ ] Add Windows-scoped real `.cmd` fixture tests, rejection-isolation tests, PID-tree cleanup tests, output-bound tests, and listener/timer cleanup tests.
- [ ] Run `pnpm exec vitest run packages/adapters/src/node-collaborators.test.ts packages/adapters/src/adapters.test.ts apps/daemon/src/control-plane-service.test.ts` and confirm the new tests fail for `EINVAL`, rejection propagation, or retained listeners.
- [ ] Add a narrow spawn/process-tree seam, strict shim-path/argument validation, explicit `ComSpec` invocation, exact PID cleanup, and an idempotent settlement path.
- [ ] Catch runner rejection at the adapter probe boundary and isolate service aggregation without hiding unrelated service failures.
- [ ] Re-run the focused tests and confirm all pass with no owned child left alive.

### Task 2: Stable manifest identity and bounded reading

**Files:**

- Modify: `apps/daemon/src/package-inventory.test.ts`
- Modify: `apps/daemon/src/package-inventory.ts`

**Interfaces:**

- Produces: an internal operations seam whose production defaults use `realpath`, `open`, handle `stat({ bigint: true })`, path `stat({ bigint: true })`, bounded positional reads, and guaranteed close.

- [ ] Add deterministic tests for matching identity, ABA mismatch with equal path strings, growth beyond 2 MiB, short reads, close-on-every-terminal-path, and explicit Windows junction skipping.
- [ ] Run `pnpm exec vitest run apps/daemon/src/package-inventory.test.ts` and confirm the ABA/growth tests fail against the existing pathname/readFile implementation.
- [ ] Implement exact non-zero `dev`/`ino` comparison for regular files and a chunk reader that observes at most `MAX_MANIFEST_BYTES + 1` bytes.
- [ ] Re-run the package-inventory tests and confirm the security cases pass.

### Task 3: Coherent event inspector navigation

**Files:**

- Modify: `apps/dashboard/src/inspectors/inspector-panel.test.tsx`
- Modify: `apps/dashboard/src/inspectors/inspector-panel.tsx`

**Interfaces:**

- Consumes: current `projects` and `sessions` snapshots.
- Produces: project navigation resolved independently, but session navigation allowed only when its authoritative project agrees with any event project reference.

- [ ] Add the exact `p1` event / `s2` session / `p2` ownership mismatch test plus snapshot-rerender invalidation and session-only coverage.
- [ ] Run the focused inspector test and confirm the mismatched session action is currently present.
- [ ] Resolve navigation on every render, suppress the conflicting session button, and expose restrained accessible mismatch text.
- [ ] Re-run the focused inspector tests.

### Task 4: Explicit non-destructive refreshing state

**Files:**

- Modify: `apps/dashboard/src/api/refresh-state.test.ts`
- Modify: `apps/dashboard/src/api/refresh-state.ts`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/app.test.tsx`
- Modify: `apps/dashboard/src/app.tsx`

**Interfaces:**

- Produces: `PulseFreshness = 'current' | 'refreshing' | 'stale' | 'unavailable'` owned by the existing refresh controller.

- [ ] Add transition tests proving retained data remains visible while refresh begins, success returns current, and failure becomes stale/unavailable according to retained data.
- [ ] Run refresh/app tests and confirm the new refreshing assertions fail.
- [ ] Emit a refreshing snapshot before awaiting the loader and render non-flickering accessible refresh text without clearing resources.
- [ ] Re-run the focused refresh/app tests.

### Task 5: Bounded session-duration clock

**Files:**

- Modify: `apps/dashboard/src/inspectors/inspector-panel.test.tsx`
- Modify: `apps/dashboard/src/inspectors/inspector-panel.tsx`

**Interfaces:**

- Produces: one 60-second interval per open active Session inspector, one captured `nowMs` per render, and identical visible/accessible duration text.

- [ ] Add fake-timer tests for minute-boundary consistency, one-minute advancement, terminal/invalid behavior, and interval cleanup on navigation/close/unmount.
- [ ] Run the inspector tests and confirm advancement/consistency assertions fail.
- [ ] Add a narrow shared inspector clock hook that exists only while the selected session is active and clears on cleanup.
- [ ] Re-run the inspector tests.

### Task 6: Documentation and verification

**Files:**

- Modify: `docs/remediations/phase-5b-blocker-remediation.md`
- Modify if behavior text exists: `docs/phase5-dashboard-realtime-contract.md`
- Modify if behavior text exists: `docs/phase5-dashboard-architecture.md`
- Modify if behavior text exists: `README.md`

- [ ] Record reproduction, root cause, implementation, security boundary, tests, Windows/browser evidence, and honest remaining limitations.
- [ ] Run the repository-owned `.cmd` fixture and benign `pnpm.cmd --version` through the bounded runner.
- [ ] Run bounded production browser verification on ports 4782/4783 and terminate owned processes.
- [ ] Run `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, configured `pnpm test:integration`, `pnpm build`, and `git diff --check`.
- [ ] Revalidate HEAD, staged count, dependency manifests, ports, processes, Redis ownership, and exact target-only diff before reporting.

## Third blocker remediation addendum (2026-08-05)

The independent re-review exposed a real early-root-close orphan and two inspector refresh
gaps, so the following completed work supersedes the second-pass cleanup assumptions above:

- [x] Resolve `cmd.exe`, `taskkill.exe`, and the fixed process-snapshot Windows PowerShell
      helper only from a validated canonical Windows system directory. Accept `ComSpec` only when
      it resolves to that same directory; never search ambient `PATH` or spawn a bare utility
      name.
- [x] Replace root-close/taskkill-result shortcuts with exact owned-tree discovery,
      creation-time/executable identity checks, bounded deepest-first exact-PID fallback, and
      post-termination absence verification. Cleanup success now means that no verified owned
      root or descendant remains.
- [x] Increase the termination-only total bound from 500 ms to 5,000 ms. Three independent
      trusted PowerShell snapshots are required for pre-capture and post/final verification, and
      Windows host scheduling exhausted the earlier three-second prototype during stress. The
      2,500 ms probe timeout and separate 64 KiB stdout/stderr limits are unchanged.
- [x] Add deterministic utility-resolution, malformed/timeout/error discovery, taskkill
      result, PID-reuse, root-close, sibling-isolation, listener/timer, and emergency-cleanup
      tests plus the source-controlled `pnpm test:windows-cleanup-stress` command.
- [x] Store Project, Session, and Event inspector selections as IDs only and resolve the
      current entity from the latest authoritative Project/Session/Activity snapshots on every
      render. Missing or evicted entities render a restrained unavailable state without stale
      actions.
- [x] Create the duration interval only for a current nonterminal Session whose `startedAt`
      is finite and not in the future; refreshed invalid/terminal/missing state clears it, while
      refreshed valid state starts exactly one interval.
- [x] Re-run focused Windows and dashboard tests, the 25-iteration orphan stress proof, ten
      consecutive Windows-suite passes, canonical unit/integration/build gates, and live
      production dashboard inspection. Exact results are recorded in the remediation report.
