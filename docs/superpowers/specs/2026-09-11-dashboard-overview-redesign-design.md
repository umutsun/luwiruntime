# Dashboard overview redesign — four switchable views over one drill-down

Date: 2026-09-11  
Design source: `temp/Luwi Runtime Dashboard Mockup/Luwi Runtime - {Board,Flow,Radial,Timeline}.dc.html`
(the four "dynamic" comps the owner shared on 2026-09-11)  
Supersedes: the Pulse route of `docs/2026-08-14-dashboard-redesign-plan.md` (its honesty rules
survive; its layout does not)  
Owner instruction: "tamamlayana kadar benden onay isteme" — decisions below were taken without a
review gate and are recorded with their reasons.

## Why

The dashboard grew a thirteen-entry rail, a command bar, a snapshot line and a Pulse route that is
six dense panels of tables. It is honest, and it is chaos: the owner's read is that it presents
data detail, not how the runtime is _going_. The four new comps share one calmer shape — a header,
one large picture of the whole runtime, a docked drill-down, a stream ticker — and differ only in
the picture. That picture is a lens, so the four lenses are switchable.

## What the comps are, and are not

All four are drawn from the same fictional data: seven projects with a **release readiness** and a
**lifecycle stage**, sessions with a **task lease**, a **7-day activity trend**, **tokens summed
across provenance grades**, and a **running** status. Every one of those is either prohibited by
`AGENTS.md` §21 or not observed by this runtime, and `product-independence.test.ts` fails the build
on the first two. The layout ships; the claims are replaced by what the daemon actually serves.

### Honest replacements (binding)

| Comp claim                                    | Why it cannot ship                                      | What ships instead                                                                                   |
| --------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Ready / Needs Attention / Blocked / Unknown` | §21 bans release scoring; no read exists                | Session-derived badge: `N ACTIVE`, `N BLOCKED` (blocked wins), `QUIET`                               |
| `active dev / release prep / …` stage         | §21 bans lifecycle stages                               | The observed Git branch (`GET /projects/:id/git`), `NOT OBSERVED` on 404, `UNAVAILABLE` on failure   |
| Flow's third column `Release`                 | as above                                                | **Status** — the nine-value session vocabulary, one node per status present                          |
| `Task lease: … (queued)`                      | §21 bans task orchestration; `WorkLease` has only paths | Dropped                                                                                              |
| `Activity · 7 days` trend                     | `GET /events` takes a `limit`, not a time bound         | The retained window, bucketed, labelled with its real span (`retained-window.ts`)                    |
| `51.4k tokens · 61% exact`                    | Summing across grades is forbidden by README            | One figure, the best grade that reported a total, labelled with its grade; other grades in the sub   |
| `running`                                     | Not an observed status                                  | Labels stay verbatim; `thinking` and `tool_running` share an _animation_ tone only                   |
| `Observers: git · fs · test`                  | No such read                                            | Runtime facts: uptime, Redis latency, daemon version                                                 |
| `WHY BLOCKED · Held by … · Task lease …`      | Status carries no reason                                | The latest `lease.denied` event for that session in the retained stream, or an honest "none"         |
| `Live / 24h / 7d` header range                | Nothing global is time-bounded                          | Dropped from the header; **Timeline** alone gets a window (`90 min / 24 h / 7 d`) over session times |
| Worktrees fact                                | Sessions carry `branch`, no worktree                    | Distinct session branches                                                                            |
| Per-project tokens                            | Usage summary is runtime-wide                           | Git facts (`HEAD`, clean/untracked, tags) in the project drill-down                                  |

Everything else — session counts and statuses, project registry, agents, events and their rate,
context loaded/invoked/unused counts, health, uptime, Redis latency, git facts — is already in the
Pulse batch and is rendered from it. **No new endpoint, no new mutation.**

## Decisions

1. **The overview is the product.** `#/pulse` (the default route) renders the new shell with the
   four views; the rail, command bar, scope select, snapshot line and the old Pulse panels are
   deleted. The twelve detail routes **stay**, reachable from the header, from
   `Ctrl K`, and from context links in the drill-down — but they are secondary. They keep their code
   and stylesheets; the token swap gives them the mono look. Deleting Configuration (the only write
   surface, ADR 0021) or Messages (ADR 0018) is a scope decision the owner did not take.
2. **Four lenses, one switch.** `Board · Flow · Radial · Timeline` is a segmented control in the
   header, persisted in `localStorage` (`luwi.view`) exactly like the theme. All four read the same
   `Overview` model; switching re-renders nothing but the picture.
3. **One focus, one drill-down.** Focus is client state (`runtime | project | agent | session`) whose project rides in the
   hash as `#/pulse/<projectId>` so a reload returns to it,
   set by clicking a tile, node, lane, bar, ribbon end or list row, and by the `PROJECT` switcher.
   The docked 360 px aside renders the panel for the focus. It is not a modal and it is not the
   inspector: the existing `DetailDrawer` + `InspectorPanel` stay as the deeper, evidence-grade view,
   opened from an `Inspect …` button inside the aside.
4. **Mono palette.** Tokens move to the comps' neutral ink/paper palette in both themes (`--ink`,
   `--paper`, `--line`, `--line-soft`, `--stripe` added; the navy/indigo values retired). The
   semantic `--success/--warning/--danger` tones stay for the detail routes and the status chips,
   because their dual encoding is tested and the comps' own design system keeps them too.
5. **The retained window grows to 200.** The bootstrap read was `GET /events?limit=20`; the
   in-memory store already caps at 200 and the daemon allows 1000. Twenty events cannot draw a rate,
   a histogram or Timeline marks. One bounded read, same cap as the store.
6. **Motion is the comps' motion**, behind `prefers-reduced-motion`. Pulse for working, blink and a
   halo for blocked, a sweep for a tile with work, packets on the radial spokes, dashed flow on
   Sankey ribbons. Colour never carries meaning alone: blocked also gets the solid ink border,
   quiet the dashed border, and every status is written in words beside its dot.

## Information architecture

```
header (56px)  [mark] Luwi Runtime │ ● LIVE · hh:mm:ss [PARTIAL]   …   [PROJECT ▾] [Board│Flow│Radial│Timeline] [Details ▾] [◐ theme]
body           grid: minmax(0,1fr) 360px
  main          stats row → the picture (per view) → STREAM ticker (44px, sticky bottom)
  aside         eyebrow · title · badge · sub │ WHY BLOCKED (if any) │ 3 facts │ trend (7 buckets) │ list rows │ Inspect › / Open … ›
```

- **Header.** The LIVE cluster is the realtime switch (pressed = following; released reads
  `PAUSED · N NEW`); its word follows the socket (`LIVE / CONNECTING / RECONNECTING / OFFLINE`), the
  clock is wall time. A snapshot that is partial, stale, refreshing or unavailable adds one tag that
  is also the retry button. `PROJECT` is a menu of `All projects` plus every project with its
  monogram and session badge. Route navigation beyond the drill-down's links is `Ctrl K`; the
  `Details` menu of the first build was removed on the owner's read. Theme keeps
  its three choices as an icon-only segmented control.
- **Stats row.** Sessions (breakdown of the top statuses), Projects (`N with sessions · M blocked`),
  Events / min (over the retained span), Tokens (best grade, others in the sub), Context
  (`loaded · invoked · loaded-not-invoked`). An unavailable read renders `—` with "unavailable" in
  the sub, never `0`. Board shows the same five inline.
- **Board.** A 6-column tile grid. The runtime tile (2×2) carries the health badge, an events/min
  ring gauge whose fill is the latest bucket against the busiest bucket, and three facts. Project
  tiles are sized by work: the busiest project 2×2, projects with active sessions 2×1, quiet ones
  1×1. Each tile: branch eyebrow, name, session badge, one chip per active session (agent initials +
  age, pulse/blink by tone), `HEAD · clean|N untracked`, and a 7-bucket sparkline of the project's
  retained events on the shared time axis.
- **Flow.** Sankey `Agents → Projects → Status`. One ribbon per active session in each stage;
  widths are the session unit, scaled so the tallest column fits. A quiet project is a thin dashed
  node with no ribbons. Clicking an agent focuses the agent; clicking a project focuses it; the
  other ribbons dim.
- **Radial.** The runtime at the centre (events/min, the same ring), projects on an orbit. Each
  node's arc is its share of retained events against the busiest project; its dots are active
  sessions by tone; spokes carry one packet per working session. Focusing a project puts its
  sessions on the orbit and the project's monogram in the centre.
- **Timeline.** One lane per project, one bar per session whose interval meets the window (start →
  now for active, start → last heartbeat for terminal), greedy row packing, a NOW line at 88 %, a
  30-bucket histogram of retained events over the window, and a diamond mark per `lease.denied`
  event on the session that suffered it. Window: `90 min` (default) `24 h` `7 d`.
- **Drill-down.** `runtime`: health words (`Daemon online/degraded/offline`, `Redis connected · N ms`
  — no Redis verdict without a daemon answer), uptime/Redis/version facts, retained-event trend,
  active session rows. `project`: branch, badge, `N sessions · HEAD sha`, WHY BLOCKED, git facts,
  the project's events trend, its session rows, `Inspect project`, `Open project evidence` (routes to
  `#/projects/<id>`). `agent`: sessions across projects, models reported, blocked/waiting counts.
  `session`: task summary (as reported), status badge, branch, started/heartbeat ages, WHY BLOCKED,
  model/context facts, its events trend, the project's other sessions, `Inspect session`.
- **Ticker.** The four newest retained events: time, type, one detail string picked from the
  payload (`path`, `subject`, `status`, `reason`, `branch` — first present), project name.

## Components

```
apps/dashboard/src/overview/
  model.ts            buildOverview(snapshot, events, nowMs) → Overview; panelFor(overview, focus)
  overview.tsx        view switch + focus state + <StatsRow> + <Picture> + <Ticker> + <DrillDown>
  board-view.tsx  flow-view.tsx  radial-view.tsx  timeline-view.tsx
  drill-down.tsx      the aside, four panel shapes from one PanelModel
  stats-row.tsx  ticker.tsx  use-view-choice.ts
apps/dashboard/src/styles/overview.css     (added to tokens.test.ts and class-coverage.test.ts)
apps/dashboard/src/app.tsx                 rewritten: header, overview route, detail routes in the same frame
apps/dashboard/src/styles/shell.css        rewritten: base, header, menus, page frame; rail/command-bar rules deleted
apps/dashboard/src/styles/tokens.css       mono palette; new tokens
deleted: pulse/pulse-view.tsx (+test), components/nav-icon.tsx, scopePulseSnapshot, the Pulse-only rules in pulse.css
```

`model.ts` is pure and owns every derivation (tones, badges, tile plan, Sankey stacking, radial
geometry inputs, Timeline packing, rate, blocked evidence, token grade). The views only place what
the model says. `main.tsx` keeps its data plumbing; the only change is the `limit=200` read.

## Error handling

Every count that comes from a resource that can fail stays a `CountValue`; the model never turns
`unavailable` into `0`. A project past the git fan-out cap renders `UNAVAILABLE` as its eyebrow and
the truncation is disclosed in the runtime panel. An event with an unparseable `occurredAt` is
counted as ignored by `bucketRetainedWindow`, never bucketed. A session with an unknown status
renders `Unknown` and the quiet tone. A hash the switcher does not know is the runtime focus.

## Testing

- `overview/model.test.ts`: badges, tones, tile plan, token grade selection (never summed), rate
  and span, blocked evidence picks the newest `lease.denied` for the session and nothing for a
  session without one, Timeline clipping and packing, Sankey unit scaling, unavailable stays `—`.
- `overview/overview.test.tsx`: the four views switch and persist; a tile click focuses the aside;
  the PROJECT switcher focuses and clears; the aside's `Inspect …` opens the existing inspector; the
  ticker holds while paused.
- `app.test.tsx`: adapted, not discarded — every honesty assertion that still has a surface keeps
  its assertion on the new surface (empty vs unavailable, no Redis line without a daemon answer, no
  vendor map, no mutation capability without a prop, partial snapshot offers retry, inspector and
  routed drawers never mount together). Rail, command-bar and old-Pulse assertions are removed with
  the components they described.
- Guards: `tokens.test.ts`, `class-coverage.test.ts`, `shell.test.ts` updated to the new sheets and
  the new shell contract (`minmax(0, 1fr) 360px`, no rail track).

## Out of scope

No new daemon read; no per-project token attribution; no focus in the hash; no server-side search.
The detail routes are not restyled beyond what the tokens give them.
