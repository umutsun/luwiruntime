# CLI-First MVP Increment 1: Self-Healing Session Bootstrap Plan

> **For Codex:** Execute this plan test-first and keep all work inside the LUWI Runtime
> repository. Do not commit unless the user explicitly asks.

**Goal:** Keep an attached or wrapped native agent visible across daemon startup gaps,
transient heartbeat failures, and terminal/missing LUWI session IDs without ever preventing
the native agent from running.

**Architecture:** Extend the existing Redis-independent session bootstrap state machine in
`@luwi/runtime`. Keep one ordinary referenced timer, serialize registration/heartbeat work,
classify only explicit `SESSION_NOT_FOUND` and `SESSION_TERMINAL` errors as session loss, and
use bounded exponential retry timing for all other registration/heartbeat failures. The
daemon protocol and Redis model do not change.

**Tech Stack:** TypeScript strict mode, Vitest, existing `ApplicationError`, existing injected
timer collaborators; no new production dependency.

---

## Task 1: Specify registration recovery

**Files:**

- Modify: `packages/runtime/src/session-bootstrap.test.ts`
- Test: `packages/runtime/src/session-bootstrap.test.ts`

1. Replace the old assertion that a failed initial registration leaves no timer with a test
   proving the bootstrap remains degraded but retries registration on a later tick.
2. Add a test proving repeated `start()` calls do not bypass the single in-flight operation.
3. Run
   `.\\node_modules\\.bin\\vitest.cmd run packages/runtime/src/session-bootstrap.test.ts`
   and confirm the new recovery test fails for the expected missing timer/retry behavior.

## Task 2: Specify heartbeat recovery and backoff

**Files:**

- Modify: `packages/runtime/src/session-bootstrap.test.ts`
- Test: `packages/runtime/src/session-bootstrap.test.ts`

1. Add a transient-failure test with an injected clock proving retries are delayed by
   exponential intervals and capped by a configured maximum.
2. Add `SESSION_NOT_FOUND` and `SESSION_TERMINAL` tests proving a lost session ID is discarded
   and the original registration input is used to obtain a replacement ID.
3. Prove overlapping timer ticks cannot issue concurrent daemon operations.
4. Prove `stop()` prevents an in-flight registration from resurrecting a session and closes
   any registration that finishes after stop.
5. Run the focused test and confirm failures describe the missing recovery behavior rather
   than fixture errors.

## Task 3: Implement the state machine minimally

**Files:**

- Modify: `packages/runtime/src/session-bootstrap.ts`
- Modify if public types change: `packages/runtime/src/index.ts`

1. Validate heartbeat and maximum retry intervals as finite positive integers.
2. Arm one referenced interval even when initial registration fails.
3. Serialize registration and heartbeat attempts with one in-flight guard.
4. Track consecutive transient failures and a monotonic next-attempt timestamp; compute
   capped exponential retry delays without adding a timer dependency.
5. Reset backoff after a successful registration or heartbeat.
6. On explicit missing/terminal session errors, clear the current ID and retry registration
   on the next eligible tick. Never guess from generic network errors.
7. Keep errors observable through `onError` and keep `start()`/timer callbacks non-throwing.
8. Make stop idempotent, clear the timer before close, and prevent late async completion from
   restoring stopped state.
9. Run the focused test until green.

## Task 4: Regression and public-contract verification

**Files:**

- Modify only if required by verified regressions:
  `packages/runtime/src/session-bootstrap.ts`,
  `packages/runtime/src/session-bootstrap.test.ts`,
  `packages/runtime/src/index.ts`,
  `apps/cli/src/cli.test.ts`

1. Run `.\\node_modules\\.bin\\vitest.cmd run packages/runtime/src`.
2. Run `pnpm.cmd typecheck` (the workspace owns the TypeScript project references).
3. Run the CLI tests that consume `createSessionBootstrap`.
4. Run repository formatting and lint checks for changed files.
5. Inspect `git diff --check` and the focused diff for accidental changes or secrets.
6. Update the design/README only if actual behavior differs from the already approved
   contract; do not label later MVP increments implemented.

## Acceptance

- Initial daemon absence no longer makes bootstrap permanently inert.
- A transient heartbeat failure retries with bounded backoff and does not rotate identity.
- A confirmed missing or terminal session produces a new LUWI session using the original
  deterministic registration input.
- Concurrent ticks do not duplicate requests.
- Stop cannot resurrect or leak a session.
- Native tool startup remains independent of LUWI success.
- Focused runtime and affected CLI tests, typecheck, formatting, lint, and diff checks pass.
