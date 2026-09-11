# ADR 0032: The dashboard is an overview with four switchable lenses

Status: Accepted  
Date: 2026-09-11

## Context

Since ADR 0021 the dashboard has grown route by route: a thirteen-entry navigation rail, a command
bar with a scope select and a snapshot line, and a Pulse route of six dense panels of tables. Every
number on it is honest — the honesty rules of `docs/2026-08-14-dashboard-redesign-plan.md` were kept
at every step — but the owner's read of the running product on 2026-09-11 was that it presents data
detail, not how the runtime is going. The owner shared four new comps drawn in Claude Design
(`temp/Luwi Runtime Dashboard Mockup/Luwi Runtime - {Board,Flow,Radial,Timeline}.dc.html`) that
share one calmer shape — a 56 px header, one large picture of the whole runtime, a docked 360 px
drill-down and a stream ticker — and differ only in the picture, and asked for the dashboard to be
rebuilt to them with the pictures switchable.

The comps are drawn from fictional data. They show a release readiness per project, a lifecycle
stage, a task lease, a 7-day activity trend, tokens summed across provenance grades and a `running`
session status. `AGENTS.md` §21 prohibits the first three as domains, the runtime observes none of
the rest, and `product-independence.test.ts` fails the build on release readiness and lifecycle
stages by name. The design is `docs/superpowers/specs/2026-09-11-dashboard-overview-redesign-design.md`;
the owner instructed that the work run to completion without approval gates, so the decisions below
were taken by the implementer and are recorded with their reasons.

## Decision

### The overview is the front door; the detail routes stay behind it

`#/pulse`, the default route, renders the new shell: header, the chosen lens, the drill-down, the
ticker. The rail, the command bar, the scope select, the snapshot line and the old Pulse panels are
deleted. The twelve detail routes — Activity, Runtime, Projects, Agents, Sessions, Messages,
Capabilities, Configuration, Usage, Context, Optimization, Graph — **stay**, reachable from `Ctrl K`
and from the context links inside the drill-down. A `Details` menu in the header was built first and
removed the same day on the owner's read of the running product ("işlevsiz kaldı"): the overview's own
links reach what a reader opens from it, and a second route list was the rail coming back. They keep
their code and stylesheets and inherit the new palette through the tokens. Deleting Configuration
(the only write surface, ADR 0021) or Messages (ADR 0018) would be a scope decision the owner did not
take.

### Four lenses over one model

`Board · Flow · Radial · Timeline` is a segmented control in the header, persisted in `localStorage`
(`luwi.view`) the way the theme is. All four render from one pure model, `overview/model.ts`, built
from the Pulse batch and the retained activity — so switching a lens cannot change a number, and the
honesty rules are tested without a DOM. **No new daemon read and no new mutation.**

### Every fictional claim has a stated replacement

| Comp claim                               | Ships as                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Release readiness                        | A session-derived badge: `N ACTIVE`, `N BLOCKED` (blocked wins), `QUIET`                         |
| Lifecycle stage                          | The observed Git branch, `NOT OBSERVED` on 404, `GIT UNAVAILABLE` on failure                     |
| Flow's `Release` column                  | The nine-value session status vocabulary, one node per status present                            |
| Task lease                               | Dropped                                                                                          |
| 7-day trend                              | The retained window, bucketed and labelled with its real span                                    |
| Tokens summed across grades              | One figure from the best grade that reported a total, labelled with its grade; others in the sub |
| `running`                                | Labels verbatim; `thinking` and `tool_running` share an animation tone only                      |
| `WHY BLOCKED · Held by · Task lease`     | The newest `lease.denied` event for that session in the retained stream, or an honest "none"     |
| `Live / 24h / 7d` header range           | Dropped; Timeline alone has a window over observed session times                                 |
| Observers, worktrees, per-project tokens | Runtime facts, distinct session branches, Git facts                                              |

### One focus, one docked drill-down, the inspector unchanged

Focus is client state — runtime, project, agent or session — set from any lens and from the
`PROJECT` switcher. The docked aside renders one panel shape for the focus. It is not a modal and it
is not the inspector: `DetailDrawer` + `InspectorPanel` stay as the evidence-grade view, opened from
an `Inspect …` button inside the aside, and the ADR 0025 rule that only one drawer mounts still holds.

### The bootstrap activity read grows from 20 to 200

Twenty events cannot draw a rate, a histogram or Timeline marks. The in-memory store already caps at
200 and the daemon allows 1000; the read is bounded at the store's cap.

### Mono palette, dual encoding kept

Tokens move to the comps' neutral ink/paper palette in both themes. The semantic tones stay for the
detail routes and the status chips, whose dual encoding is tested. On the overview, colour never
carries meaning alone: blocked also gets the solid ink border and a halo, quiet the dashed border,
and every status is written in words beside its dot. Motion follows the comps and is switched off
under `prefers-reduced-motion`.

## Consequences

- `app.tsx`, `shell.css` and `tokens.css` are rewritten; `pulse/pulse-view.tsx`, `nav-icon.tsx`,
  `scopePulseSnapshot` and the Pulse-only rules in `pulse.css` are deleted. `overview/` is new.
- `class-coverage.test.ts` and `tokens.test.ts` guard `overview.css` and the overview views;
  `shell.test.ts` pins the new contract (header row over page, `minmax(0, 1fr) 360px`, no rail token).
- `app.test.tsx` was adapted, not discarded: every honesty assertion that still has a surface keeps
  its assertion on the new surface.
- The Timeline is the only lens with a real time axis, so it alone carries a window control.
- The focused project rides in the hash as `#/pulse/<projectId>` (owner, 2026-09-11: a reload must
  come back to the same project), written with `replaceState` so a click is not a history entry.
  Session and agent focus stay transient; the back link from a detail route carries the project.
- Nothing about the daemon, the protocol, Redis or `luwi_v1` changed.

## Follow-ups accepted on the owner's read (2026-09-11)

- The `Details` menu was removed; the twelve routes are reached from the drill-down's links and
  `Ctrl K`. `#/runtime` opens as a drawer over the overview rather than as a page.
- The project drill-down offers `Inspect` and `Detail`; the detail drawer opens over the overview at
  `#/pulse/<id>/detail` (ADR 0033 puts project editing inside it), and gained **Skills** — the
  project-scoped capability packages with the path each file lives at — and **Optimization**, this
  project's findings from the bounded set the snapshot carries, linking to `#/optimization` and
  `#/config`.
- The session drill-down keeps one copy icon for the session id beside the status badge, and its
  three facts read the attributed usage records' own counters: Model is the newest record's model,
  Tokens is one grade's total or else output and input (fresh plus cache written) summed each on its
  own, and Context is the newest request's prompt size — input plus cache read plus cache written —
  with the skills evidence in the detail. Nothing is summed across grades and no total is made up;
  a session with no attributed record says `not observed`, which for a bridge or a Codex/Antigravity
  session is the permanent, honest answer until a reader for that vendor's transcripts exists.
