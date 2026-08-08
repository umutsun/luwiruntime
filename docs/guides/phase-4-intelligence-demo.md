# Phase 4 intelligence demo

The reproducible demo creates two temporary Git repositories named Luwi Bridge and Luwi
Listings, a temporary LUWI/native-agent home, a run-specific Redis namespace, and a
run-specific Function library. All telemetry is explicitly simulated. Cleanup removes only
those temporary artifacts.

## Run

Start a local standard Redis server, build, and run:

```powershell
$env:LUWI_TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
pnpm build
pnpm demo:phase4
```

On macOS/Linux:

```sh
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm build
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm demo:phase4
```

Use a disposable local Redis server when possible. Redis Functions are server-scoped even
when a database number is selected.

## What it proves

The script fails unless it can demonstrate:

- two projects, four AgentDefinitions, project bindings, multiple sessions, and two sessions
  sharing `codex-demo`;
- exact, agent-reported, LUWI-estimated, and unavailable usage with source composition;
- absent token fields remaining absent rather than becoming zero;
- static estimates plus explicit assigned/effective/loaded/invoked observations;
- always, conditional, on-demand, and post-plan reference-only context;
- oversized, exact-duplicate, project-observed-global, and broad-MCP/few-call findings;
- local branches, linked worktrees, dirty state, redacted remote credentials, exact LUWI
  trailer attribution, and separately labeled correlated attribution;
- Node and Flutter/Dart package and evidence-backed technology inventory;
- project/agent/session/commit/file/package/capability graph relationships, a bounded path,
  and a successful shadow-generation swap;
- acceptance without application, an immutable baseline, Phase 3 plan creation, one-time
  approval, snapshot-backed apply, an explicit post-apply session observation, and a
  non-causal footprint evaluation;
- one project-scoped, read-only Phase 4 MCP usage query.

The final JSON identifies the data as simulated and reports graph counts, finding kinds,
snapshot/config-plan IDs, evaluation state, and `causalClaim: false`.

The demo fixture itself creates commits, branches, and a linked worktree inside the temporary
repositories. The LUWI Git observer remains read-only and runs only its ADR 0011 allowlist.
No package manager, package script, hook, plugin, or MCP definition discovered during scans
is executed.

## Earlier regressions

Phase 3's sandbox demo contains the complete Phase 1 presence/session and Phase 2
communication/MCP regressions:

```powershell
$env:LUWI_TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
pnpm demo:phase3
```

Run both scripts after the full verification suite for the Phase 1–4 release evidence.
