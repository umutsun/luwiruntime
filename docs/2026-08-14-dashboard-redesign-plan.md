# Dashboard redesign to the Luwi mockup — plan

Date: 2026-08-14  
Design source: `temp/Luwi Runtime Dashboard Mockup/Luwi Runtime - Mono.dc.html` (and its colour sibling)  
Supersedes nothing; extends `docs/phase5-dashboard-mockup-audit.md`

## Why

The dashboard works and is honest, but it does not look like the design it was drawn from. The
2026-08-05 audit accepted the mockup's _visual language_ and reimplemented it plainly; the owner,
seeing the running product, asked for the design itself. This plan adopts the mockup's information
architecture, not only its palette.

## What the mockup is, and is not

140 distinct elements across the Pulse screen were classified against the daemon's 99 route pairs
and against `AGENTS.md` §18/§21:

| Verdict             | Count | Meaning                                       |
| ------------------- | ----- | --------------------------------------------- |
| buildable-now       | 67    | data exists, an endpoint serves it            |
| buildable-with-work | 47    | data exists, needs derivation or one new read |
| needs-new-data      | 13    | the runtime observes no such thing            |
| out-of-scope        | 13    | building it crosses a stated §21 prohibition  |

**The mockup's look is buildable almost in full. Several of its claims are not.** It was drawn as a
picture of a finished product, so it shows numbers this runtime cannot know. The audit already said
as much — "treat it as a style reference, not a backlog" — and two of its rows are now stale in
production's favour: path leases became real with ADR 0020, and the graph summary with ADR 0013.

## Decisions taken

1. **Elements we cannot source honestly get an honest replacement**, not a fabrication and not a
   blank. The layout survives; the claim changes.
2. **The inspector becomes a docked third column.** This deliberately invalidates its modal
   contract — `aria-modal="true"` on a permanently visible pane is a lie to assistive technology —
   so `inspectors/inspector-panel.test.tsx` is rewritten with that reason stated, not patched.
3. **Dark stays the base theme**, the OS still selects light, and the mockup's missing half — a
   theme toggle — ships. `tokens.css`'s two light blocks stay byte-identical.
4. **All six phases** are in scope for this round.

### The honest replacements

| Mockup claim                                    | Why it cannot ship as drawn                                                                 | Replacement                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Release Readiness` (402 tests, build, secrets) | No test, build or secret-scanning observer exists; §21 bans lifecycle/release scoring       | **Repository facts** — untracked count, clean flag, tags, `observedAt`, all stated Git facts |
| `⌘K` search over commits and files              | No unified search endpoint; files have no endpoint at all                                   | **Navigate-only palette** over the already-loaded snapshot plus the route list               |
| `Task lease: pkg-inventory-fix (queued)`        | §21 bans task orchestration; `WorkLease` has no subject or kind, only paths                 | Dropped                                                                                      |
| `5.1k tokens observed` as one total             | Sums across provenance, which `README` forbids                                              | One figure per source grade; a single figure only when there is a single source              |
| `Blocked — path lease conflict` as a cause      | Session status carries no reason; the nearest evidence is a correlated `lease.denied` event | Title reads `Blocked`; a separately labelled line states the observed lease denial           |
| Evidence grade column on stream rows            | The event envelope carries no confidence field                                              | Column dropped; width goes to the object column                                              |
| `Assigned` → `Effective` funnel narrowing       | Both are hardcoded `true` at the only writer sites, so they are always equal                | Five independent counts, designed so equal bars are the normal case — not a funnel           |
| `0 critical · 0 important findings`             | `OptimizationFinding` has no severity; inventing one is itself scoring                      | `N open findings`                                                                            |
| Per-agent vendor monogram hues                  | No vendor label map, and `tokens.test.ts` bans colour literals                              | Hash `agentId` into token palette; initials from `displayName`                               |
| `fnlib v9` footer                               | No route exposes function-library state, and production already removed this row            | Dropped                                                                                      |

**Adopted verbatim, because it is the best idea in the comp:** the evidence chip's _dual_ encoding —
colour **and** border style — which keeps grades legible without colour, exactly as the README
requires.

## The guards a redesign must respect

These fail loudly and are the real constraint on every phase:

- `styles/tokens.test.ts` — both light blocks must define the same token **names and values**; every
  colour token on dark `:root` must be overridden in the media block; no opaque colour literal may
  appear in a `background`/`color`/`border-*-color` declaration in the listed stylesheets. **A sixth
  stylesheet must be added to this list and to `class-coverage.test.ts` in the same change**, or it
  is silently unguarded.
- `styles/class-coverage.test.ts` — every literal `className` in the listed views must match a rule.
  Blind spot: it reads literal strings only, so a template-literal className becomes invisible to it.
- `styles/shell.test.ts` — the rail width and the `minmax(0, 1fr)` content track.
- `app.test.tsx` — skip link, nav accessible name, `aria-current`, the scope-summary label, and the
  assertion that Runtime health shows neither "Function library" nor "Projection health".
- `product-independence.test.ts` — vendor names may not appear, even in a comment; and
  `api/config-mutations.ts` remains the only module permitted a non-GET call.

## Phases

Each ends in something visible. Verification for every phase is `/verify` (§19 order) plus a
screenshot captured over the DevTools protocol with a real wait — never `--virtual-time-budget`,
which makes every panel lie about being stuck on "Loading". The daemon serves the built dashboard, so
a visual check needs `pnpm build` and a restart, and the owner lease needs ~15 s to expire first.

1. **Foundation** — tokens (micro type scale, evidence/capability/event families, monogram palette),
   `grid-template-columns: 220px minmax(0, 1fr) 344px`, a 52 px top bar, the rail toggle, and the
   theme toggle. No information moves.
2. **Docked inspector** — `aside.inspector` becomes grid column 3 with a designed empty state; the
   modal contract is rewritten rather than patched.
3. **Pulse rows 1–2** — the stat strip with its sparkline (labelled as a rate over the retained
   window, empty buckets rendered as gaps and never as zero), Active Work with its dual-line columns,
   Project Pulse with monogram tiles.
4. **Pulse row 3** — Realtime Stream, the five context counts, Repository facts.
5. **Remaining routes and nav** — Monitor / Intelligence / System grouping with badges, **keeping
   every built route** (the mockup omits Messages, Capabilities and Configuration; they stay), plus a
   Runtime view over `GET /api/v1/runtime`.
6. **Enrichment** — the navigate-only palette, and any per-row reads whose request cost is accepted.

## Honesty rules that bind every phase

- A failed read renders `Unavailable`; it never renders `0`.
- Session status keeps its nine-value vocabulary. "Running" is not an observed state.
- An agent name falls back to the raw `agentId`; a session's opaque agent id never implies a
  definition.
- Truncation is disclosed wherever a bounded read can hit its limit.
- No vendor branching, and no colour that carries meaning alone.

## Status after phase 2

Phases 1 and 2 are committed at `09b152a`. Tokens, the rail (icons, counts, collapse), the 52 px top
bar, the theme toggle and the status dual encoding are in; the inspector is docked as grid column
three with its modal contract removed and its tests rewritten. **Phase 3 is the next work and has not
started.** `pulse-view.tsx`, `pulse/model.ts` and `styles/pulse.css` are still the pre-redesign
versions.

## Phase 3 — the panel anatomy, and what each field may honestly say

Written from the mockup so the next session does not have to re-derive it. Every row below is
"what the comp draws" → "what the runtime may put there".

### Stat strip

The comp: one inline row of dotted counts — `7 projects · 4 agents · 8 sessions · 2 waiting ·
1 blocked · 42ms latency · Redis connected` — with `events/min`, a sparkline and `246` pushed right.

- projects / agents / sessions / latency / Redis: **already in the snapshot**; they are the six boxed
  tiles today, so this is a layout change, not a data change. Each stays a `CountValue`.
- `waiting` and `blocked`: derive by counting `sessions` on their real status values
  (`waiting_for_input`, `waiting_for_agent`, `blocked`). Do **not** invent a `running` bucket.
- The sparkline: there is **no server-side event rate** — `GET /api/v1/events` takes `limit`, not a
  time bound. Bucket the retained activity window client-side, label it as such, and draw an empty
  bucket as a **gap, never a zero**. On a quiet runtime that window may span days, so the label has
  to say "retained window" rather than "per minute".
- Each stat is a link into its route.

### Active Work

The comp: four dual-line columns — `AGENT · PROJECT` / `TASK · SCOPE` / `CONTEXT · USAGE` /
`STATUS · AGE`. The header carries `4 running · 2 waiting · 1 blocked · 1 idle` on the left and
`agent · project · status` (the sort control) on the right. A blocked row gets a left rail and a
raised background.

| Comp cell                        | Honest content                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Agent name / project name        | `session.agentId` → `AgentDefinition.displayName`, **falling back to the raw id**; project name                                       |
| Task title                       | **No task domain exists.** Use the session's own status sentence, not an invented task name                                           |
| `3 files · branch feature/graph` | branch is on the session record; "3 files" is not observed — use the session's held lease paths, labelled as advisory claims, or omit |
| `12 loaded · 4 invoked`          | real context counts, already in the snapshot                                                                                          |
| `18.4k` magnitude chip           | per-session usage is **not** in the batched reads; either accept the fan-out (Decision 4) or omit                                     |
| Status pill                      | the nine-value vocabulary, never "Running"                                                                                            |
| `01:24:32 · 8s ago`              | duration from `startedAt`, age from `lastHeartbeatAt` — both already derived for the inspector                                        |
| Blocked row treatment            | keep the rail; the **reason** may not be stated as a cause (see the honest-replacement table)                                         |

Row selection drives the docked inspector, which phase 2 already mounted.

### Project Pulse

The comp: a monogram tile, bold name, a dim meta line `active dev · 1a 2s · 31c4f54`, a right-aligned
status word, and a seven-bar trace.

- Monogram: initials from `displayName`, tile colour by hashing the id into the five graph-family
  tokens (they are already OKLCH-checked in both themes). No vendor palette.
- `1a 2s`: agents and sessions bound to the project — derivable from the snapshot.
- `active dev`: **not a real field.** Drop it.
- `31c4f54`: the HEAD sha needs one git read per project (Decision 4). Omit unless that cost is taken.
- **`Ready` / `Needs Attention` / `Blocked` / `Unknown`: there is no project status domain.** Do not
  invent one. Either drop the column or show a fact that is observed, such as held-lease count.
- The seven-bar trace: same rule as the sparkline — bucket the retained window, gaps for empty.

### Tests phase 3 will break

`app.test.tsx:391-405` pins the Active Sessions caption and the `cells[3]/[4]/[5]` indices; those go
when the table becomes four dual-line columns, and they should be rewritten with the reason stated.
Keep `app.test.tsx:243, 339` — the `Inspect project <name>` / `Inspect session <id>` button names.
`components/panel.test.tsx:107-115` still requires two confidence tones to produce different class
strings.

### Where the fixture and the capture tooling stand

The fixture survives between sessions: db15 holds the data, `%TEMP%/luwi-fixture` holds `LUWI_HOME`
and `LUWI_NATIVE_HOME`, and `%TEMP%/luwi-seed-workspace` holds the git repo. Start the daemon with
those four variables together and the screens have data; re-seeding is no longer required, and is
now safe if you do. Screenshot over the DevTools protocol with a real wall-clock wait.

Two traps that cost time in this round: `TaskStop` kills the `tsx watch` parent but leaves the daemon
listening on 4782, so check the port and `taskkill` the survivor; and the daemon's owner lease needs
~15 s to expire after an ungraceful kill before the next start succeeds.
