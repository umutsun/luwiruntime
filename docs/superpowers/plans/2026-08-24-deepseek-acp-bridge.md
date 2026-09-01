# DeepSeek Harness ACP Bridge Implementation Plan

> Execute as a vertical, opt-in CLI increment. Do not commit unless the user explicitly asks.

**Goal:** Add a minimal DeepSeek Harness ACP Session Bridge while preserving LUWI's standalone
runtime and existing daemon protocol.

**Architecture:** Put orchestration and ACP subprocess code in `apps/cli`; depend only on the
official vendor-neutral ACP SDK pinned to DeepSeek Harness's compatible version. Reuse existing
daemon routes and schemas. No runtime, protocol, Redis, dashboard, or native-config mutation.

## Task 1: Lock the behavior with bridge orchestration tests

**Files:**

- Create: `apps/cli/src/deepseek-bridge.test.ts`
- Create: `apps/cli/src/deepseek-bridge.ts`

1. Write failing tests for startup ordering: LUWI register, ACP start/session creation, native
   declaration, then inbox claims.
2. Write failing tests for delivered → acknowledged → processing → responded mapping.
3. Write failing tests for ACP cancellation/failure and blank-output behavior.
4. Write failing tests for heartbeat failure and idempotent shutdown.
5. Implement only enough injected orchestration to pass the tests.
6. Run `pnpm.cmd exec vitest run apps/cli/src/deepseek-bridge.test.ts`.

## Task 2: Add the ACP subprocess adapter

**Files:**

- Create: `apps/cli/src/deepseek-acp-client.test.ts`
- Create: `apps/cli/src/deepseek-acp-client.ts`
- Modify: `apps/cli/package.json`
- Modify: `pnpm-lock.yaml`

1. Add failing tests using a scripted ACP child for initialization, fresh session creation,
   committed text collection, permission policy, cancellation, and process cleanup.
2. Add `@agentclientprotocol/sdk@0.25.1` as the sole production dependency.
3. Implement an injected spawn boundary and the official SDK connection.
4. Keep stdout protocol-only and inherit stderr for diagnostics.
5. Run `pnpm.cmd exec vitest run apps/cli/src/deepseek-acp-client.test.ts`.

## Task 3: Wire the opt-in CLI command

**Files:**

- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`
- Modify: `apps/cli/src/index.ts`

1. Add failing CLI tests for required project/agent/workspace/command inputs and safe defaults.
2. Register `luwi session bridge deepseek` with explicit command/args, bridge identity,
   permission policy, heartbeat, claim, and shutdown options.
3. Adapt existing validated loopback HTTP requests to the bridge client interface.
4. Print identifiers and lifecycle state only; do not print prompt or answer bodies.
5. Run the focused CLI and bridge tests.

## Task 4: Document the experimental boundary

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/overview.md`

1. Document the command, exact ownership model, prerequisites, and a repository-based DeepSeek
   ACP launch example.
2. Document optional Cordis-side LUWI MCP configuration and the current ACP `mcpServers`
   limitation.
3. State clearly that the integration is opt-in, experimental, and absent from the daemon/runtime
   dependency graph.

## Task 5: Verify the repository

1. Run focused bridge and CLI tests.
2. Run `pnpm.cmd format`.
3. Run `pnpm.cmd lint`.
4. Run `pnpm.cmd typecheck`.
5. Run `pnpm.cmd test`.
6. Run `pnpm.cmd build`.
7. Inspect `git diff --check`, `git status --short`, and the final diff for secrets or accidental
   files.
