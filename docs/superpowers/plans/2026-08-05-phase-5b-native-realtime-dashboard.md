# Phase 5B Native Realtime Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated native realtime invalidation, bounded Activity, and read-only
inspectors without duplicating daemon projections or adding mutations/vendor coupling.

**Architecture:** A browser-safe realtime controller validates and deduplicates stream
envelopes, appends them to a bounded activity store, and sends resource keys to a coalescing
invalidation coordinator. REST resources remain authoritative and merge generation-safely.

**Tech Stack:** React 19, TypeScript strict ESM, Vite 8, Zod 4, WebSocket/AbortController,
Vitest, React Testing Library, Fastify/Redis integration tests already in the repository.

## Global Constraints

- Work in the current normal checkout because Phase 2–5A is uncommitted; preserve all
  unrelated changes.
- Add no dependency, datastore, mutation, adapter, ACP, Goose, cloud, search, graph, task,
  lease, lifecycle, release, GitHub, chat, account, or remote-access feature.
- Dashboard uses daemon HTTP/WebSocket only; no Redis/filesystem imports.
- Activity retains 200 events; dedupe retains 512 stream IDs; payload preview is 8 KiB.
- Reconnect delays are 1/2/5/10 seconds; refresh invalidations coalesce for 250 ms.
- Do not stage, commit, tag, push, merge, reset, clean, stash, or create a new worktree.

---

### Task 1: Browser-safe realtime envelope and bounded activity store

**Files:**

- Create: `apps/dashboard/src/realtime/schema.test.ts`
- Create: `apps/dashboard/src/realtime/schema.ts`
- Create: `apps/dashboard/src/realtime/activity-store.test.ts`
- Create: `apps/dashboard/src/realtime/activity-store.ts`
- Modify: `apps/dashboard/src/pulse/model.ts`
- Modify: `apps/dashboard/src/api/pulse.ts`

**Interfaces:**

- Produces `DashboardEvent`, `parseDashboardEvent(value)`, and
  `createActivityStore({maxEvents,maxSeenIds})`.
- Activity store accepts REST and realtime envelopes by canonical `streamId`, exposes newest
  events, pause/follow state, pending count, filters, and selected event.

- [ ] Write schema tests for canonical, malformed, and unknown future events; run focused
      test and confirm missing-module RED.
- [ ] Implement the strict browser-safe envelope with bounded type/reference strings and
      unknown payload; rerun GREEN.
- [ ] Write activity tests for duplicates, reconnect duplicates, 200-row retention, 512-ID
      retention, out-of-order acceptance, pause/pending/resume, and filtering; verify RED.
- [ ] Implement the minimal store and seed REST activity with stream IDs; rerun GREEN.

### Task 2: Reconnect lifecycle and resource invalidation

**Files:**

- Replace: `apps/dashboard/src/realtime/observer.ts`
- Modify: `apps/dashboard/src/realtime/observer.test.ts`
- Create: `apps/dashboard/src/realtime/invalidation.test.ts`
- Create: `apps/dashboard/src/realtime/invalidation.ts`
- Modify: `apps/dashboard/src/api/client.ts`
- Modify: `apps/dashboard/src/api/client.test.ts`
- Refactor: `apps/dashboard/src/api/pulse.ts`
- Modify: `apps/dashboard/src/api/pulse.test.ts`

**Interfaces:**

- Produces `createRealtimeController(options)` with `start()`/`stop()` and state/event/error
  callbacks.
- Produces `resourcesForEvent(type)` and `createInvalidationCoordinator(options)`.
- Produces independently refreshable `PulseResourceKey` reads with AbortSignal and
  generation-safe merge metadata.

- [ ] Extend observer tests for connecting→live→reconnecting→live, bounded delay, malformed
      payload, reconnect duplicate handoff, and stop cancellation; verify RED.
- [ ] Implement the controller using injected socket/timers and browser-safe parsing; GREEN.
- [ ] Write exact event-family mapping and 250 ms burst/trailing-coalescing tests; verify RED.
- [ ] Implement invalidation coordinator; GREEN.
- [ ] Write API tests for AbortSignal, selected-resource reads, stale last-safe merge, and
      obsolete response rejection; verify RED.
- [ ] Refactor client/resource loading minimally and rerun all dashboard API tests.

### Task 3: Dashboard runtime integration and Activity route

**Files:**

- Create: `apps/dashboard/src/activity/activity-view.test.tsx`
- Create: `apps/dashboard/src/activity/activity-view.tsx`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/app.tsx`
- Modify: `apps/dashboard/src/app.test.tsx`
- Create: `apps/dashboard/src/styles/activity.css`
- Modify: `apps/dashboard/src/styles/shell.css`
- Modify: `apps/dashboard/src/styles/shell.test.ts`

**Interfaces:**

- `DashboardApp` consumes current route, freshness, realtime state, activity state, and
  selection callbacks.
- Activity view provides follow/pause/resume, bounded filters/search, keyboard selection,
  and event-open callback.

- [ ] Write failing route/navigation tests proving Activity is active and other planned
      routes remain disabled.
- [ ] Write failing Activity tests for REST seed, realtime append, pause count, resume,
      filters, unknown type, keyboard navigation, and manual-scroll follow behavior.
- [ ] Implement the ledger-style Activity view and hook it to the controller/coordinator.
- [ ] Add stale/current snapshot presentation that retains valid data on refresh failure.
- [ ] Add layout contract tests for wrapped controls, stable sidebar, inspector allowance,
      and no page-level horizontal overflow; rerun dashboard tests.

### Task 4: Accessible read-only inspectors

**Files:**

- Create: `apps/dashboard/src/inspectors/inspector-shell.test.tsx`
- Create: `apps/dashboard/src/inspectors/inspector-shell.tsx`
- Create: `apps/dashboard/src/inspectors/project-inspector.tsx`
- Create: `apps/dashboard/src/inspectors/session-inspector.tsx`
- Create: `apps/dashboard/src/inspectors/event-inspector.tsx`
- Create: `apps/dashboard/src/inspectors/safe-json.test.ts`
- Create: `apps/dashboard/src/inspectors/safe-json.ts`
- Modify: `apps/dashboard/src/pulse/pulse-view.tsx`
- Create: `apps/dashboard/src/styles/inspectors.css`

**Interfaces:**

- One dialog shell accepts title, invoking element, `onClose`, and children.
- Inspectors consume only validated snapshot/event records and supported navigation
  callbacks; `formatSafeJson(value,8192)` returns bounded plain text.

- [ ] Write failing safe JSON tests for HTML-like strings, cycles/unsupported values, and
      8 KiB truncation; implement and GREEN.
- [ ] Write failing dialog tests for initial focus, Escape, focus return, labels, and no raw
      HTML; implement shell and GREEN.
- [ ] Write failing Project/Session/Event content tests for allowed fields and forbidden
      lifecycle/task/lease/vendor claims; implement inspectors and Pulse row open controls.
- [ ] Integrate inspector selection with Pulse/Activity and rerun React tests.

### Task 5: Product independence, documentation, and verification

**Files:**

- Create: `apps/dashboard/src/product-independence.test.ts`
- Update: `docs/phase5-dashboard-capability-matrix.md`
- Update: `docs/phase5-dashboard-architecture.md`
- Update: `docs/phase5-dashboard-realtime-contract.md`
- Update: `docs/architecture/product-independent-core.md`
- Update: `README.md`

**Interfaces:** None; this task records and verifies the completed public boundary.

- [ ] Add a static test that production dashboard imports contain no Redis, filesystem,
      Goose, ACP, vendor SDK, agent-name conditional, mutation request, or raw HTML sink.
- [ ] Update docs with exact implemented states, route, bounds, omissions, and source lines.
- [ ] Run dashboard tests, then `pnpm format`, `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- [ ] Run real Redis integration with both required environment variables; require 15 files,
      41 tests, zero skip.
- [ ] Run `pnpm build`, production-bundle forbidden-import scan, and `git diff --check`.
- [ ] Launch the daemon and browser-test snapshot, live event, duplicate, pause/resume,
      reconnect/disconnect, inspectors, 1280/1440/1728 desktop contracts, and horizontal
      overflow; terminate every temporary process.
