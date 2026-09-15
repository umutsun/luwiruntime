# Knowledge lens — implementation plan (2026-09-15)

Spec: `docs/superpowers/specs/2026-09-15-knowledge-lens-design.md`. Dashboard-only; the daemon
endpoint, reader, projection and protocol schema are reused unchanged.

1. **Sim model** — `overview/knowledge-model.ts`: port the comp's `startSim`/`tick` as a pure, seeded
   `createKnowledgeSim`; move `knowledgePanel` in. Tests in `knowledge-model.test.ts`.
2. **Lens view** — `overview/knowledge-view.tsx`: `KnowledgeView` (states, PROJECT switcher, canvas
   with the rAF loop writing through refs, legend line, query hint, provenance) and
   `KnowledgeInspector` on the `drill__*` anatomy. Tests in `knowledge-view.test.tsx`.
3. **Overview wiring** — fifth `VIEW_CHOICE`; `overview.tsx` renders the lens and swaps the aside;
   `loadKnowledge` threaded from `main.tsx` through `DashboardApp`. Overview and shell tests.
4. **Removal** — the `knowledge` route and its tests, `topbar__kg` and its CSS and assertion, the
   bootstrap selectors and tests, the `knowledge` props and state, the `knowledge/` directory.
5. **CSS** — `knowledge.css` reworked to the lens; guard lists updated.
6. **Flow liveness** — `OverviewSession.live`, `FlowRibbon.live`, `flow__ribbon--live`, the note on
   the board. Model test.
7. **Gate and live check** — dashboard typecheck, `vitest run apps/dashboard`, dashboard build,
   `tsc -b`; browser check on luwiruntime (bounded graph) and on a project without graphify output.
