---
description: Preflight and run the opt-in Redis integration tests safely against the local Memurai instance.
argument-hint: '[optional: vitest filter, e.g. message-transitions]'
allowed-tools: Bash, Read, Grep, Glob
---

Run the Redis integration test suite. Optional filter: $ARGUMENTS

`AGENTS.md` section 15 forbids these tests from silently using a developer's default database or
flushing unrelated keys. This machine makes that risk concrete, so preflight before running.

## What this machine actually has

There is **no Docker**. `compose.yaml` targets `redis:7-alpine`, but the running server is
**Memurai Developer 4.1.2**, reporting `redis_version:7.2.5`, as a Windows service on
`127.0.0.1:6379`. Redis Functions are fully supported — `FUNCTION LIST`, `LOAD`, `DELETE`,
`FLUSH`, `DUMP`, `RESTORE`, and `STATS` all exist.

The CLI is at `C:\Program Files\Memurai\memurai-cli.exe`; `redis-cli` is not on `PATH`.

## Preflight

1. Confirm the server responds:
   `& 'C:\Program Files\Memurai\memurai-cli.exe' -h 127.0.0.1 -p 6379 PING`
2. Check the keyspace before deciding on a database:
   `& 'C:\Program Files\Memurai\memurai-cli.exe' INFO keyspace`

   **`db0` holds live development state (~1300 `luwi:v1:*` keys). It must never be the test
   target.** Use `db15`.

3. Check the loaded Function libraries:
   `& 'C:\Program Files\Memurai\memurai-cli.exe' FUNCTION LIST`

   Expect `luwi_v1` with 29 functions. Leftover `luwi_test_run_*` libraries from earlier runs may
   also be present — report them, but **do not** `FUNCTION FLUSH`; that would unload `luwi_v1` and
   break the running daemon. Delete a specific stale library by name if cleanup is wanted, and say
   which one you are deleting first.

## Run

```
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true \
pnpm test:integration
```

`LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true` is **required here**, not optional: Redis Function
libraries are server-scoped, and this is a single shared server that already hosts `luwi_v1`.
`.env.example` recommends a disposable dedicated server instead — that is not available on this
machine, so the shared-server escape hatch is the honest path.

In PowerShell, set the variables with `$env:NAME = 'value'` before the command; in the Bash tool,
the inline prefix form above works.

## After

- Re-check `FUNCTION LIST` and `INFO keyspace`. Report any test library or key the run left behind
  — tests are required to clean only their own state, so residue is a finding worth reporting, not
  something to quietly delete.
- Report the actual pass/fail counts. If the suite could not run, give the exact command, the
  error, the likely cause, and the next safe action rather than reporting it as skipped.
