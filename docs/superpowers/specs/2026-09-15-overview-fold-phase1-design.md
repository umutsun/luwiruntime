# Fold the detail routes into the overview — Phase 1, vertical slice (2026-09-15)

## Direction

The owner wants a single unified overview with no separate pages: the twelve detail routes fold into
the overview as drawers over an always-mounted `#/pulse`. `#/runtime` already does exactly this
(`runtimeDrawer` + `isOverview`, a `DetailDrawer` over the overview, `onClose → hrefOfFocus(focus)`).
This phase generalizes that pattern.

## What the map found

- **The fold is centralized in `app.tsx`.** `main.tsx`/`bootstrap.ts` loaders are hash-name-keyed and
  page/drawer-agnostic — no change. `routing.ts` and `routeTitles` — no change (hashes stay for
  deep-link/reload; `routeTitles` already feeds `DetailDrawer` `{eyebrow,title}`).
- **Three clusters.** Trivial (read-only, no inner modal): usage, agents, context, optimization,
  activity, graph — copy the runtime branch. Inner-modal (each opens its own `DetailDrawer`/dialog, so
  an outer drawer nests two `aria-modal` surfaces): capabilities, config, messages, **and sessions**
  (its `AskSessionDialog` is a modal) — need the inner detail turned into an inline pane, deferred.
  Two-level: projects (detail already a drawer; only the list is a page), deferred.
- **Reachability gap.** With the palette and Details menu removed, most detail routes have no opener
  from the overview today. Folding without openers makes dead drawers, so the opener is part of scope.

## This slice (owner-approved)

Fold the **six trivial read-only routes** — usage, agents, context, optimization, activity, graph —
into `DetailDrawer`s over the always-mounted overview, and establish the **opener pattern**. Defer
the four inner-modal routes (sessions, messages, capabilities, config) and the projects list to a
second iteration.

### Fold mechanics (`app.tsx`)

- `FOLDED_DRAWER_ROUTES = [runtime, activity, usage, agents, context, optimization, graph]`;
  `routeDrawer = FOLDED_DRAWER_ROUTES.includes(route.name) ? route.name : undefined`;
  `isOverview = route.name === 'pulse' || routeDrawer !== undefined`.
- The six folded views move from the `.route-body` page switch into one general drawer branch that
  replaces the `runtimeDrawer` branch: one `DetailDrawer` with `routeTitles[routeDrawer]` for
  eyebrow/title, `onClose` → `hrefOfFocus(focus)`, body switched on `routeDrawer`.
- The `.route` page shell stays this slice (sessions, messages, capabilities, config, projects still
  use it); it is deleted in the second iteration when all routes fold.

### Openers (stat tiles + drill-down)

- **Stat tiles** open their domain drawer. Each `Stat` gains a `route` href; `StatsRow`'s `onSelect`
  takes the stat and navigates: Sessions→`#/sessions`, Projects→`#/projects`, Events→`#/activity`,
  Tokens→`#/usage`, Context→`#/context`. Three are folded drawers now; Sessions/Projects still
  navigate to their pages until the second iteration (forward-compatible).
- **Drill-down** runtime-focus links gain Graph and Optimization beside the existing Runtime and
  Agents, so the runtime-global drawers are reachable contextually. Kept short, not a menu.

### Tests

- `app.test.tsx` `it.each(routes)` asserts an `<h1>` + `← Overview` per route; for the six folded
  routes replace with the drawer template (a `dialog` named by its heading, Close → `#/pulse`). The
  Activity heading test and the intelligence-unavailable tests move to the drawer. The four unfolded
  routes keep their page assertions. A stat-tile test asserts a tile navigates to its route.
- `routes.test.tsx` (component-level) and the loader/routing tests are unaffected.

## Gate and verification

Dashboard typecheck, `vitest run apps/dashboard`, build, `tsc -b`; live-verify each of the six opens
as a drawer over the overview, the stat tiles open their drawers, and Close returns to the overview.

## Iteration 2 — the remaining five routes, and the page shell goes (2026-09-15, later)

Folded the four inner-modal routes and the projects registry, then deleted the page shell.

- **Inner detail → inline pane.** A message (messages), a package and a profile (capabilities), a plan
  and a snapshot (config) opened a second `DetailDrawer`; inside a route drawer that nested two
  `aria-modal` surfaces. They now open as a `DetailPane`: the drawer header's anatomy as a labelled
  `region` stacked under its list — no portal, no focus trap, no scroll lock — scrolled into view on
  mount because the drawer caps its tables at 340px. The evidence is unchanged; only where it sits.
- **Gates stay modal.** `AskSessionDialog` (sessions) and `ConfirmDialog` (config apply) are
  confirmations, not evidence, and remain dialogs over their drawer. Their Escape handlers stop
  propagation and their Tab handling keeps focus inside them, so the drawer's trap never fights them.
- **Projects.** `#/projects` is the registry drawer (`ProjectsView`, `renderDetailInline={false}`);
  picking a project navigates to `#/projects/<id>`, which is the project drawer already in place. One
  drawer at a time: the registry yields and is remounted on Close, so focus lands on its Close rather
  than on the row that opened the project.
- **Wide drawer.** `DetailDrawer` gained `wide` (`--detail-drawer-width-wide`, 72rem) for the routes
  whose tables run six to eight columns: sessions, messages, capabilities, config, projects.
- **Shell.** `routeDrawer` is every route but `pulse`; `isOverview`, `page--route` and the
  `.route`/`.route-head`/`.route-body` block are deleted. The skip link reads "Skip to overview".
- **Tests.** Every route asserts as a `dialog` named by its heading, Close → the focused overview hash.
  The three view tests query the inner detail as a `region` closed by "Close detail". A jsdom trap
  surfaced: `hashchange` fires from a zero timer, synchronous tests never let one run, and the queued
  events burst into the first awaiting test — 56 identical events tripped React's nested-update limit.
  `afterEach` now awaits one timer turn so each test's events fire with nothing mounted.
