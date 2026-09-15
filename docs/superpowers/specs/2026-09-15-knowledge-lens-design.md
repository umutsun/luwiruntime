# Knowledge as the fifth overview lens — design (2026-09-15)

## Problem

The per-project graphify knowledge graph shipped as a separate route, `#/knowledge/<projectId>`,
with a static community-ring layout. The owner rejected it on sight: it is a page disconnected from
the overview, and it does not look like the `Graph.dc.html` comp, which is drawn in the same shell
as the four lens comps and animates a 3D-orbit force layout. Two things are wrong and one thing is
right: the route and the layout are wrong; the daemon endpoint, reader, projection and protocol
schema are correct and stay.

## Decisions

1. **Knowledge is a lens, not a route.** `VIEW_CHOICES` becomes Board / Flow / Radial / Timeline /
   Knowledge. The lens renders in the overview's main slot under the uniform stat strip and above
   the stream ticker; the docked aside shows the knowledge inspector while the lens is open. The
   `#/knowledge` route, the header Knowledge button and the standalone page are removed.
2. **The lens shows the focused project.** The overview already owns one focus; the Knowledge lens
   resolves it to a project (`focusProject`), falling back to the first project on the overview. A
   PROJECT switcher inside the lens, drawn like the comp's, reports its choice as a project focus,
   so the hash follows (`#/pulse/<id>`) and every other lens agrees with it.
3. **The graph loads only while the lens is open.** The lens receives `loadKnowledge` the way the
   drill-down receives `loadSessionUsage`, reads when its project changes and aborts on unmount. The
   other four lenses never pay for it. Nothing re-reads on snapshot refresh: graphify output changes
   on git hooks, not every few seconds.
4. **The comp's simulation, ported verbatim.** A pure, seeded model (`createKnowledgeSim`) carries the
   comp's constants: communities on a 250-unit ring tilted 0.46 rad, orbiting 0.00055 rad per tick
   under a 1000-unit perspective; pairwise repulsion inside 200 units (1500 same-community, 2400
   across); springs at 70 (import) and 150 (call); gravity to the community centre and, weakly, to
   the canvas centre; damping 0.9; alpha decaying 0.993 per tick to a floor of 0.04. The view steps
   it on `requestAnimationFrame` and writes positions straight into the SVG through refs — React
   renders the structure, never a frame. The sim settles 120 steps before the first paint, and under
   `prefers-reduced-motion` it settles fully and never orbits.
5. **Read-only stays read-only.** The comp's Optimize / Delete / Rebuild controls are not built; the
   provenance line (`built <commit> · observed <time>`) and the static `$ graphify query` hint stay.
   The empty projection (`nodeCount` 0) says to run `graphify build`; a failed read says
   Unavailable, never the empty state.
6. **The Flow lens animates on observed activity.** A ribbon moves when its session has a retained
   event in the last ten minutes that is not presence or lifecycle (`session.heartbeat`,
   `session.registered`, `session.native.linked`, `session.native.unlinked`), and the board says so
   in words. Turn-based GUI agents never report `thinking`, so the status-driven `working` motion
   alone left every live session still; this adds a truthful signal without faking a status.

## Components

- `overview/use-view-choice.ts` — the fifth choice.
- `overview/knowledge-model.ts` — `createKnowledgeSim(graph, seed)` (pure; `step()`, node positions,
  community projections, alpha) and `knowledgePanel(graph, selectedId?)` (moved unchanged from the
  old `knowledge/model.ts`).
- `overview/knowledge-view.tsx` — `KnowledgeView` (states, switcher, canvas, overlays, the rAF loop)
  and `KnowledgeInspector` (the `drill__*` anatomy plus the community bars).
- `overview/overview.tsx` — renders the lens and swaps the aside.
- `overview/model.ts` — `OverviewSession.live`, `FlowRibbon.live`.
- `styles/knowledge.css` — lens frame, canvas, node and edge classes, overlays; the standalone page
  and inspector rules go.
- Removed: `knowledge/*`, the `knowledge` route, `topbar__kg`, the bootstrap knowledge selectors, the
  `knowledge` props on `DashboardApp`.

## Testing

- Sim: deterministic under one seed; every node inside the viewBox after 200 steps; a spring pulls
  two linked nodes closer than two unlinked ones from the same start; community projections carry
  one entry per community present; alpha never drops below the floor.
- View: no project → the overview's empty-projects label; loading; unavailable; empty graphify
  output; a rendered graph with a node per record; a click selects and fills the inspector; the
  switcher reports a project focus; `loadKnowledge` is called once per project and not on re-render.
- Overview: the Knowledge lens replaces the drill-down aside and passes the focused project.
- Shell: the View group has five options and no `#/knowledge` link; `#/knowledge/p1` parses to the
  overview.
- Model: a session with a recent non-heartbeat event is live; one with heartbeats only is not.
- Guards: `class-coverage.test.ts` and `tokens.test.ts` cover the new files and classes.
