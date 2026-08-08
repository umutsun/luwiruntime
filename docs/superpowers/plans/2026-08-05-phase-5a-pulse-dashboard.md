# Phase 5A Pulse Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production read-only Pulse dashboard from validated Phase 1–4 daemon data.

**Architecture:** A React/Vite `apps/dashboard` bundle is served on the daemon's loopback origin. Independent validated resource results feed a pure Pulse mapper; WebSocket state is observed but events are not applied.

**Tech Stack:** TypeScript, React 19, Vite 8, `@luwi/protocol`, Vitest, React Testing Library, jsdom, Fastify.

## Global Constraints

- No direct Redis, filesystem, external analytics, CDN, or remote-font access from the dashboard.
- No mutations, live event projection, release scoring, leases, search, GitHub, ACP, graph rendering, or inspectors.
- Missing and failed data render as unavailable, never zero.
- Preserve all pre-existing dirty work; do not stage, commit, tag, or push.

---

### Task 1: Dashboard workspace and typed transport

**Files:**

- Create: `apps/dashboard/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- Create: `apps/dashboard/src/api/client.ts`, `apps/dashboard/src/api/client.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml`

**Interfaces:**

- Produces `createDaemonClient(fetchImpl)` and `loadPulseResources()` with per-resource results.

- [ ] Write failing tests for validated success, non-2xx validated health, transport failure, partial sibling failure, and unknown response rejection.
- [ ] Run `pnpm vitest run apps/dashboard/src/api/client.test.ts` and confirm expected failures.
- [ ] Add the minimal package/build configuration and typed client implementation.
- [ ] Install exact dependencies and inspect additive lockfile changes.
- [ ] Re-run the focused test and dashboard typecheck.

### Task 2: Pure Pulse snapshot mapping

**Files:**

- Create: `apps/dashboard/src/pulse/model.ts`
- Create: `apps/dashboard/src/pulse/model.test.ts`

**Interfaces:**

- Consumes typed resource results.
- Produces `PulseSnapshot`, confidence rows, context-state counts, active sessions, project rows, and panel availability.

- [ ] Write failing tests for empty projects, no active sessions, project/session join, five usage sources, five context states, unknown enum tolerance, and unavailable-not-zero behavior.
- [ ] Run the focused test and confirm failures are caused by the missing mapper.
- [ ] Implement only the tested derivations.
- [ ] Re-run the focused tests and refactor while green.

### Task 3: Application shell and Pulse rendering

**Files:**

- Create: `apps/dashboard/src/main.tsx`, `app.tsx`, `app.test.tsx`
- Create: `apps/dashboard/src/components/*.tsx`, `apps/dashboard/src/pulse/pulse-view.tsx`
- Create: `apps/dashboard/src/styles/tokens.css`, `shell.css`, `pulse.css`

**Interfaces:**

- Consumes `PulseSnapshot` and connection state.
- Produces the `#/pulse` shell, supported navigation, disabled planned labels, and read-only panels.

- [ ] Write failing jsdom tests for identity, navigation semantics, no dead links, loading, empty, partial, daemon-down, Redis-down, sanitization, distinctions, unknown values, and no mock fixture strings.
- [ ] Confirm focused failures.
- [ ] Implement normalized tokens, shell, operational strip, active sessions, project pulse, usage, context, runtime health, activity, and explicit state components.
- [ ] Add CSS contract tests for 1280/1440/1728 overflow and responsive secondary-panel stacking.
- [ ] Re-run focused tests and dashboard build.

### Task 4: Daemon production asset boundary

**Files:**

- Create: `apps/daemon/src/dashboard-assets.ts`, `dashboard-assets.test.ts`
- Modify: `apps/daemon/src/app.ts`, `runtime.ts`

**Interfaces:**

- Produces same-origin `/` and validated `/assets/:file` read-only routes over the Vite output directory.

- [ ] Write failing Fastify inject tests for entry HTML, JS/CSS assets, missing assets, traversal rejection, safe errors, and API precedence.
- [ ] Confirm focused failures.
- [ ] Implement a fixed-root, filename-validated asset reader with explicit content types and no arbitrary SPA fallback.
- [ ] Re-run daemon focused tests.

### Task 5: Connection state and integration

**Files:**

- Create: `apps/dashboard/src/api/realtime.ts`, `realtime.test.ts`
- Modify: `apps/dashboard/src/app.tsx`, `package.json`, root scripts and documentation.

**Interfaces:**

- Produces `connecting | connected | disconnected | unsupported`; does not expose messages.

- [ ] Write failing tests proving URL construction, state transitions, ignored event payloads, and bounded manual reconnect behavior.
- [ ] Confirm failures, implement the minimal observer, and rerun tests.
- [ ] Wire root scripts so dashboard test/typecheck/build participate in canonical gates without changing daemon security defaults.

### Task 6: Verification and visual review

**Files:**

- Modify documentation only for exact commands/results if needed.

- [ ] Run dashboard-focused tests and build.
- [ ] Run `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, explicit Redis integration tests when configured, `pnpm build`, and `git diff --check`.
- [ ] Start the loopback daemon with an explicit safe Redis URL and inspect the dashboard at 1280, 1440, and 1728 widths.
- [ ] Capture screenshots, inspect console errors, confirm no horizontal page overflow, and stop local processes.
- [ ] Audit the final diff for mock data, credentials, unrelated files, and forbidden capabilities.
