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
