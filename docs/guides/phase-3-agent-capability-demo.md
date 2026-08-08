# Phase 3 sandbox demo

The reproducible Phase 3 path uses only temporary agent/project/LUWI homes, a run-specific
Redis namespace and Function library, the real daemon, and the real built CLI. It never
modifies the developer's native agent configuration.

## Prerequisites

Start a local standard Redis server, then build:

```powershell
pnpm build
$env:LUWI_TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
pnpm demo:phase3
```

On macOS/Linux:

```sh
pnpm build
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm demo:phase3
```

The demo creates fixture executables that implement only `--version`, four agent
definitions, four bindings, multiple same-agent sessions, global/project capabilities, a
profile, deterministic override/tombstone/dependency cases, a Codex render plan, approval,
snapshot, apply, external drift, approved rollback, context estimates, and exact duplicate
hash detection across instruction, skill, hook, MCP, and policy sources. It also proves:

- Phase 1 same-agent sessions, status changes, heartbeat renewal, TTL expiry, and
  disconnection;
- Phase 2 project isolation, idempotent retry, inbox claim, acknowledge/process/respond,
  evidence, timeout, and a bound-session MCP request/reply round trip;
- a Redis Function commit whose client reply is deliberately lost, followed by daemon
  reconciliation back to `ready`;
- project-bounded Phase 3 MCP effective-config access.

The script fails if a hook/plugin/MCP marker is executed, if context values are not labeled
`estimated`/`generic-character-estimate`, if required context categories are absent, or if
normal and recovery rollbacks do not restore the fixture file. Cleanup deletes only the
temporary directory, run-specific Redis keys, and run-specific Function library.

For manual operation, the corresponding CLI groups are:

```text
luwi agent ...
luwi project agent ...
luwi capability ...
luwi profile ...
luwi config ...
luwi context ...
```

Applying a native plan always requires:

```text
luwi config plan apply <planId> --approval-token <one-time-token> --yes
```

`--yes` confirms only an already-created, approved plan. It never skips path checks,
preconditions, snapshots, ownership, or token validation.
