# Dynamic MCP Session Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a long-lived LUWI MCP server bound to the live replacement session published by `session attach --session-out` without weakening identity or project boundaries.

**Architecture:** Add a small MCP binding resolver that reads either a backward-compatible static environment ID or a secure, atomically replaced session file. Verify one initial project anchor at startup, then resolve and verify exactly one session snapshot per MCP tool call.

**Tech Stack:** Node.js 22, TypeScript strict mode, ESM, Zod, Vitest, pnpm workspaces.

## Global Constraints

- Redis remains the only runtime datastore and only the daemon may access it.
- `LUWI_SESSION_ID` and `LUWI_SESSION_FILE` are mutually exclusive binding sources.
- A rotated session must remain in the startup session's project.
- Terminal sessions are never revived and leases are never transferred.
- Preserve all pre-existing dirty-worktree changes.
- Do not commit without an explicit commit request.

---

### Task 1: Secure session binding resolver

**Files:**

- Create: `apps/mcp-server/src/session-binding.ts`
- Create: `apps/mcp-server/src/session-binding.test.ts`
- Modify: `apps/mcp-server/src/config.ts`
- Modify: `apps/mcp-server/src/config.test.ts`
- Modify: `apps/mcp-server/src/index.ts`

**Interfaces:**

- Produces: `McpSessionBindingConfig` and `createSessionIdResolver(binding, options?)`.
- Consumes: the existing opaque session identifier constraints and Node filesystem APIs.

- [ ] **Step 1: Write failing resolver and configuration tests**

  Cover static compatibility, file-only configuration, both/neither rejection, absolute paths,
  atomic replacement between reads, malformed/empty/oversized data, symlinks, regular-file checks,
  and POSIX private permissions.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `pnpm --filter @luwi/mcp-server exec vitest run src/config.test.ts src/session-binding.test.ts`

  Expected: failure because the resolver module and file binding configuration do not exist.

- [ ] **Step 3: Implement the minimal resolver and config union**

  The resolver returns one trimmed session ID. File mode opens one absolute, non-symlink regular file,
  bounds it to 4 KiB, validates strict `{ attached }` JSON, enforces private POSIX permissions, and
  closes the handle in `finally`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

  Run the Step 2 command; expect all tests to pass.

### Task 2: Per-request verified identity snapshot

**Files:**

- Modify: `apps/mcp-server/src/main.ts`
- Modify: `apps/mcp-server/src/tools.ts`
- Modify: `apps/mcp-server/src/tools.test.ts`

**Interfaces:**

- Consumes: `createSessionIdResolver` and `McpDaemonClient.verifyBoundSession`.
- Produces: optional third `resolveBoundSession: () => Promise<SessionView>` argument on
  `createMcpToolHandlers`, defaulting to the current static behavior.

- [ ] **Step 1: Write failing rotation, request-snapshot, and project-anchor tests**

  Assert that consecutive tool calls may use different verified IDs, one `askAgent` call uses one ID
  through its wait response, and a rotated session in another project fails before mutation.

- [ ] **Step 2: Run `src/tools.test.ts` and verify RED**

  Expected: the old captured session is reused or the new resolver argument is unsupported.

- [ ] **Step 3: Implement one-resolution-per-handler behavior**

  Main resolves once for the startup anchor. Every handler obtains one current session, passes it to
  nested binding checks, and derives all project/source/responder fields from that snapshot.

- [ ] **Step 4: Run `src/tools.test.ts` and verify GREEN**

### Task 3: Harden session-out publication and migrate launch guidance

**Files:**

- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`
- Modify: `scripts/claude-mcp-launch.mjs`
- Modify as applicable without discarding existing work: `scripts/codex-mcp-launch.mjs`
- Modify as applicable without discarding existing work: `scripts/antigravity-mcp-launch.mjs`
- Modify: `README.md`
- Modify: `docs/LUWI-MCP-SETUP.md`
- Modify: `docs/architecture/overview.md`

**Interfaces:**

- Produces: private atomic `{ attached }` mapping files and `LUWI_SESSION_FILE` launcher wiring.

- [ ] **Step 1: Add a failing hard-link regression test for the legacy fixed `.tmp` path**

  Pre-create `<session-out>.tmp` as a hard link to a sentinel; assert the sentinel is unchanged after
  attach publishes its mapping.

- [ ] **Step 2: Run the focused CLI test and verify RED**

  Run: `pnpm --filter @luwi/cli exec vitest run src/cli.test.ts -t "session-out"`

- [ ] **Step 3: Use exclusive unique temporary files with mode `0600` and atomic rename**

  Always remove only the unique temporary file in `finally`; retain the current best-effort LUWI
  observation semantics.

- [ ] **Step 4: Update launchers and documentation**

  Launchers backed by `--session-out` pass its absolute path as `LUWI_SESSION_FILE`. Static inherited
  sessions retain `LUWI_SESSION_ID`. Document migration and restart requirements.

- [ ] **Step 5: Run focused MCP/CLI suites and verify GREEN**

### Task 4: Full verification and review

**Files:**

- Review all files changed by Tasks 1-3 without reverting unrelated work.

- [ ] **Step 1: Run formatting check**

  Run: `pnpm format --check`

- [ ] **Step 2: Run typecheck and lint**

  Run: `pnpm typecheck`

  Run: `pnpm lint`

- [ ] **Step 3: Run tests and build**

  Run: `pnpm test`

  Run: `pnpm build`

- [ ] **Step 4: Request focused code review and address valid findings**

  Review security, identity snapshot consistency, project scoping, dirty-worktree preservation, and
  migration documentation.

- [ ] **Step 5: Re-run affected verification after review fixes and report exact evidence**
