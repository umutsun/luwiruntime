# Refactor prompt — Knowledge Graph as the 5th overview lens (2026-09-15)

You are working in LUWI Runtime (`C:/xampp/htdocs/luwiruntime`), Umut's local multi-agent dashboard +
daemon + CLI. Talk to Umut in Turkish; code/commits/ADRs/comments in English. Commit on the working
branch, **never push without his say-so**, ADR-style commit messages, trailer
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

Read `CLAUDE.md` (routes to `AGENTS.md`) and the memory index (`MEMORY.md` →
`luwi-project-position.md`) first. Branch: `claude/fleet-routing-prefer-bridge-worker`.
Use the superpowers brainstorming → writing-plans → subagent-driven-development flow (the previous
session used it); this is a redesign, so brainstorm the lens integration + the force-sim before coding.

## Why this refactor

The per-project graphify knowledge graph was built (previous session, SDD, all tasks reviewed) but as a
**separate full-page route `#/knowledge/<projectId>`** with a **static community-ring layout**. The owner
rejected it on sight: "bu şekilde olmaz, tasarımla ilgisi yok, ana dashboard yapımızdan kopuk ayrı sayfa
istemiyoruz." Two mistakes to fix:

1. **It is a separate page, disconnected from the overview.** It must be integrated into the main
   dashboard as the **5th lens** (Board / Flow / Radial / Timeline / **Knowledge**), rendered in the same
   overview shell (56px header + the uniform stat strip + the stream ticker + the docked drill-down),
   exactly like the other four lenses. The `Graph.dc.html` comp is drawn in the SAME shell as the other
   four lens comps — it was always meant to be a lens, not a page.
2. **The static layout does not match the comp.** The owner wants the comp's look **exactly**: the
   **3D-orbit force-directed simulation** (communities on a tilted, slowly rotating ring with perspective
   projection; force layout; animated). Not the current cluttered static ring.

The design comp is `temp/Luwi Runtime Dashboard Mockup/Luwi Runtime - Graph.dc.html` — read its `<script>`
block: `buildGraph`, `startSim`, the `requestAnimationFrame` `tick` (community ring in 3D + perspective,
node repulsion, edge springs), `renderVals` (node/edge/inspector projection). Replicate that behaviour in
the lens. `apps/dashboard/src/overview/radial-view.tsx` is the closest existing pattern (an SVG orbit lens
with `ov-spin`), a useful reference for doing an animated SVG lens inside the overview.

## What is CORRECT and must be REUSED (do not rebuild the backend)

- **Daemon endpoint** `GET /api/v1/projects/:projectId/knowledge-graph` — read-only, bounded, LIVE. Keep.
- **Reader + pure projection** `apps/daemon/src/graphify-knowledge.ts`: `readGraphifyKnowledge` (reads a
  project's `graphify-out/graph.json` the ADR-0029 bounded way) and `projectKnowledgeGraph` (degree →
  god/hub/symbol, backbone ≤ 40 nodes, top-12 communities, summary over the whole doc, `truncated`,
  guards empty community names / over-long labels). Keep. The data is graphify's own structure (symbols,
  communities, typed import/call edges), ~6k nodes for luwiruntime → the endpoint returns the ~40-node
  backbone, so the force-sim runs on a small set.
- **Protocol schema** `knowledgeGraphResponseSchema` in `@luwi/protocol` (node kind `god|hub|symbol`, edge
  kind `import|call`, `embeddings` literal 0, optional `observedAt`). Keep.
- **`api/knowledge-scope.ts`** (`loadKnowledgeScope` → `client.get`). Keep, but change WHEN it loads (see
  below).
- **`knowledgePanel(graph, selectedId?)`** in `apps/dashboard/src/knowledge/model.ts` (inspector model:
  project-summary vs node-detail). Reusable. **Replace `layoutKnowledge`** (the static ring) with a
  force-sim layout matching the comp.
- **The uniform stat strip** (commit `be6431e`): one `fill` `StatsRow` for all lenses. Keep — it is good.
- **Read-only honesty**: the comp's Optimize / Prune / Delete-node / Rebuild write buttons stay DROPPED
  (LUWI never mutates or runs graphify — AGENTS.md §12/§18/§21). The provenance line
  `built <commit> · observed <time>` replaces them. Keep. The `$ graphify query` hint is a static,
  non-executing label — keep.

## What is WRONG and must be REMOVED / REWORKED

- **The separate route `#/knowledge/<projectId>`** in `apps/dashboard/src/routing.ts` (the `knowledge`
  route variant + its parse/href + `routing.test.ts` cases) — remove; a lens is a `VIEW_CHOICE`, not a
  hash route.
- **The header "Knowledge" button** (commit `39a2e88`): `topbar__kg` `<a>` in `app.tsx` + the `.topbar__kg`
  rules in `shell.css` + its `app.test.tsx` assertion — remove. The lens switch (`VIEW_CHOICES`) is the
  entry point instead.
- **The standalone page render**: the `route.name === 'knowledge'` branch in `app.tsx`, the `routeTitles`
  `knowledge` entry, and the route-gated scope loading `needsKnowledgeOf` / `selectedKnowledgeProjectOf`
  in `bootstrap.ts` (+ tests) and their `main.tsx` effect — remove/replace. Load the graph when the
  **Knowledge lens is active** for the focused project, not on a route.
- **`knowledge/knowledge-view.tsx` + `knowledge-canvas.tsx` + `knowledge-inspector.tsx`** — rework into an
  overview lens component (e.g. `overview/knowledge-view.tsx`) that renders inside `overview.tsx` beside
  Board/Flow/Radial/Timeline, using the force-sim canvas + the docked drill-down (not its own page shell).

## Target shape

- Add `'knowledge'` to `VIEW_CHOICES` / `VIEW_LABELS` (`overview/use-view-choice.ts`). The header lens
  segments become Board / Flow / Radial / Timeline / Knowledge.
- In `overview.tsx`, when `view === 'knowledge'`, render the knowledge lens in the main canvas (the same
  slot the other lenses use), with the shared stat strip above and the ticker below and the drill-down
  aside. The lens shows **one project's** graph.
- **Which project:** the Knowledge lens is per-project (unlike the other four). Decide during brainstorming
  how it selects — the comp's Graph has its own PROJECT switcher; the overview already has a focused
  project (`focus.kind === 'project'`) and the header PROJECTS control. Simplest coherent option: the
  Knowledge lens uses the focused project (falls back to the first visible project), and shows a small
  in-lens project selector like the comp. Confirm with the owner.
- **Load policy:** fetch `GET /api/v1/projects/:id/knowledge-graph` when the Knowledge lens is active and a
  project is chosen; the overview must not pay for it on the other four lenses.
- **Force-sim:** port the comp's simulation (community ring in 3D + perspective, node repulsion, edge
  springs, slow orbit) to the lens, over the bounded backbone from the endpoint. rAF is acceptable here
  (the comp uses it; RADIAL already animates) — keep it paused/cheap when the lens is not visible, and
  respect `prefers-reduced-motion`.
- Node styles: god = filled ink, hub = paper fill + ink stroke, symbol = dim; import edges solid, call
  edges dashed; community labels; click a node → highlight neighbours + fill the drill-down (reuse
  `knowledgePanel`). Empty state when the project has no `graphify-out/` (endpoint returns nodeCount 0):
  "run `graphify build`".

## Constraints

- Dashboard-only for the view; the daemon endpoint already exists (no daemon restart needed to iterate on
  the view — the daemon serves `dist/` per request; `pnpm --filter @luwi/dashboard build` + a cache-busting
  `?v=` query shows it).
- CSS: mono tokens only; every new class registered with `styles/tokens.test.ts` + `class-coverage.test.ts`
  (no raw pixel in spacing/font, no opaque colour literal; SVG geometry attributes in TSX are exempt).
- Read-only: no new dashboard write module (product-independence guard stays green). No graphify execution.
- Gate: `pnpm --filter @luwi/dashboard typecheck` exit 0, `pnpm exec vitest run apps/dashboard` green,
  `pnpm --filter @luwi/dashboard build` succeeds, `pnpm exec tsc -b` for the workspace. The only tolerated
  pre-existing failure anywhere is `apps/cli/src/codex-mcp-launcher.test.ts` (untracked baseline).
- Verify LIVE in the browser against luwiruntime (`b27e329f-1cce-48c4-9f3a-adafcaba01a0`, 5846 nodes →
  bounded) and against a project with no graphify output (empty state).

## Git state

- Branch `claude/fleet-routing-prefer-bridge-worker`. The KG separate-page commits are already pushed
  (`1022ce8`..`df829fc`), so the refactor deletes the route/button/page in NEW commits on top.
- Two commits are UNPUSHED: `be6431e` (uniform stat strip — keep) and `39a2e88` (header Knowledge button —
  its button is removed by this refactor). Don't push until the owner says so.
- The palette (`command-palette.tsx`) was already removed (`3864ede`); the radial gauge overlap was fixed
  (`df829fc`).

## Also fix: the Flow lens animation is gone ("flow animasyonu iptal olmuş")

The Flow lens's animated ribbons (`.flow__ribbon--working .flow__ribbon-flow`, the moving dash in
`styles/overview.css`) only play for ribbons whose session tone is `working` — i.e. LUWI status
`thinking` or `tool_running` (`toneOf` in `overview/model.ts`). Live, every online session is `idle`, so
nothing animates even while a GUI agent (the Codex desktop session) is visibly running a task: turn-based
GUI agents only update their LUWI status when they call the LUWI MCP inside a turn, so LUWI never sees
their native "busy" state. The owner reads this as the animation being cancelled. Decide with the owner:
(a) animate a project's ribbon whenever it has recent event activity (a truthful "alive" signal even when
no session reports `working`), or (b) keep it strictly status-driven and fix status reporting upstream
(hard — turn-based). Do not fake `working`; whatever animates must be backed by an observed signal
(ADR 0032's honesty rule).

## Broader direction (SEPARATE scope — do not do in this refactor unless the owner asks)

The owner is moving to a **single unified overview with no separate pages**: "ayrı sayfa istemiyoruz,
onları da kaldıracağız zaten." The 12 detail routes (Sessions / Agents / Capabilities / Config / Usage /
Context / Optimization / Graph / Messages / Runtime / Projects) are slated to be folded into the overview
(drill-down / inspector / lenses) and their standalone routes removed. The Ctrl-K palette that used to
reach them is already gone. Treat this as the next conversation after the Knowledge lens lands.

## Start

Confirm the branch and that the daemon is `ready`; read the comp and the files above; brainstorm the lens
integration + how the Knowledge lens picks its project + the force-sim port; get the design approved;
then plan and implement. Verify live before declaring done.
