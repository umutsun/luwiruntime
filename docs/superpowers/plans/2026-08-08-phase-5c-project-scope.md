# Phase 5C Project Scope Implementation Plan

**Goal:** Turn the `Projects` navigation label into a working read-only route with on-demand
project-scoped evidence, without adding a dependency, a datastore, or a mutation surface.

**Status:** Implemented and verified on 2026-08-08.

**Design:** `docs/superpowers/specs/2026-08-08-phase-5c-project-scope-design.md`

## Global constraints

- Work in the current checkout. Phase 2 through 5B remain uncommitted; preserve every unrelated
  change.
- Add no dependency, datastore, mutation, lifecycle, release, task, lease, graph summary, search,
  GitHub, or account feature.
- Dashboard uses daemon HTTP and WebSocket only.
- Collection reads are bounded at 100 and disclose truncation.
- Do not stage, commit, tag, push, merge, reset, clean, stash, or create a worktree.

## Tasks

### Task 1: Protocol browser surface

**Files:** `packages/protocol/src/browser.ts`

- [x] Export `gitObservationSchema`, `packageCollectionSchema`, `technologyCollectionSchema` from
      `intelligence.js` and `projectAgentBindingCollectionSchema` from `control-plane.js`.
- [x] Rebuild `@luwi/protocol`. The dashboard resolves `@luwi/protocol/browser` to `dist`, not
      `src`: its own `vite.config.ts` declares no path alias, so an unbuilt export surfaces as an
      `undefined` schema at test time rather than a type error.

### Task 2: Route model

**Files:** `apps/dashboard/src/routing.ts`, `apps/dashboard/src/routing.test.ts`

- [x] Write failing tests for the two existing routes, `#/projects`, `#/projects/<id>`, percent
      decoding, a malformed percent sequence, an over-long identifier, extra path segments, a
      whitespace-only identifier, and href round-tripping.
- [x] Implement `parseRoute` and `routeHref`. Parsing never throws; `routeHref` percent-encodes the
      identifier so a `/` cannot forge a segment.

### Task 3: Project-scoped loader

**Files:** `apps/dashboard/src/api/project-scope.ts`, `apps/dashboard/src/api/project-scope.test.ts`

- [x] Write failing tests using a stub client that runs the real schemas against the fixtures, so
      fixture drift fails here rather than in the browser.
- [x] Cover per-resource independence, bounded query strings, project-id encoding, abort-signal
      forwarding, and the empty key set.
- [x] Cover the 404 to `not-observed` mapping for Git, and prove transport failure and 500 stay
      `unavailable`, and that 404 is never `not-observed` for the bounded collections.
- [x] Implement `loadProjectScope` and `projectResourcesForEvent`.

### Task 4: Projects view

**Files:** `apps/dashboard/src/projects/projects-view.tsx`,
`apps/dashboard/src/projects/projects-view.test.tsx`, `apps/dashboard/src/components/format.ts`,
`apps/dashboard/src/components/format.test.ts`, `apps/dashboard/src/styles/projects.css`

- [x] Extract `abbreviatePath` from `pulse-view.tsx` into a shared, tested module and add
      `abbreviateSha`; update `pulse-view.tsx` to import it rather than duplicating it.
- [x] Write failing view tests for the list, empty and unavailable states, selection, the four
      detail panels, not-observed versus unavailable, truncation disclosure, every confidence tier
      including unknown, project-filtered sessions, the loading state, the absence of any mutation
      control, and the absence of stage and release columns.
- [x] Implement the view and its stylesheet using grid `minmax`, a 12 px metadata floor, visible
      focus rings, and text-bearing status chips.

### Task 5: Shell integration

**Files:** `apps/dashboard/src/app.tsx`, `apps/dashboard/src/app.test.tsx`,
`apps/dashboard/src/main.tsx`

- [x] Replace the inline two-route parser with `parseRoute`; move `Projects` out of the disabled
      list into a real link; keep `Graph` disabled.
- [x] Load project scope on selection with abort, clear retained resources first, and guard
      realtime refreshes by generation.
- [x] Refresh project panels only when the event carries no project id or names the selected
      project.
- [x] Add shell tests for the promoted link, the still-disabled `Graph`, the active route, the
      loading state, unscoped resources reading as unavailable, and Pulse and Activity remaining
      reachable.

### Task 6: Boundary, documentation, verification

**Files:** `apps/dashboard/src/product-independence.test.ts`,
`docs/phase5-dashboard-capability-matrix.md`, `docs/phase5-dashboard-architecture.md`,
`AGENTS.md`, `README.md`

- [x] Assert statically that no production module issues a non-GET request, references a scan,
      apply, approve, rollback, or rebuild path, or names a lifecycle-stage or release-readiness
      field.
- [x] Record the four DERIVABLE to SUPPORTED transitions and why `Graph` stays PLANNED.
- [x] Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- [x] Run the opt-in Redis integration suite against the local server.

## Verification result

Recorded on 2026-08-08, each command actually executed:

| Command                 | Result                                      |
| ----------------------- | ------------------------------------------- |
| `pnpm format`           | exit 0 — all matched files Prettier-clean   |
| `pnpm lint`             | exit 0                                      |
| `pnpm typecheck`        | exit 0, both the dashboard leg and `tsc -b` |
| `pnpm test`             | exit 0 — 94 files, 596 tests                |
| `pnpm build`            | exit 0                                      |
| `pnpm test:integration` | exit 0 — 15 files, 41 tests, zero skipped   |

Baseline before Phase 5C was 90 files and 532 tests, so this phase added 4 test files and 64
tests and changed no existing expectation.

The integration run used `LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/15` and
`LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true` against the local server, which is Memurai
Developer 4.1.2 reporting `redis_version:7.2.5`. The shared-functions flag is required rather than
optional there: Redis Function libraries are server-scoped and that single server already hosts
the `luwi_v1` library. Database 15 was used because database 0 holds live development state.
