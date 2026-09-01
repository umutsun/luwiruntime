# LUWI Runtime Completion Program (2026-09-01)

> **For agentic workers:** This is the entry document for the completion program. Read `CLAUDE.md`
> first, then this file. Phases run in order; each phase names its own plan or the process that
> produces one. REQUIRED SUB-SKILL per phase: `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` for phases with a detailed plan;
> `superpowers:brainstorming` → ADR → `superpowers:writing-plans` for phases marked _design-first_.

**Goal:** Close every gap between the current tree and the product promise (`AGENTS.md` §1) that the
owner has approved for completion: land the uncommitted 2026-08-24/25 tranche with its decision
record, build B2, automatic lease renewal, Codex/Gemini identity resolvers, pay the UI token debt,
register MCP, and decide autostart.

**Architecture:** No new architecture is introduced by this program itself. Each design-first phase
mints its own ADR before code, per `AGENTS.md` §21 ("Shipping one phase does not authorize the
rest"). The owner's 2026-09-01 directive approves running this program to completion, including the
commits its plans call for — that satisfies §13's "commit only when the user explicitly asks" for
exactly the commits named in these plans, and nothing else.

**Tech Stack:** unchanged — Node 22+ (this machine: 26.3.0), TypeScript strict ESM, Fastify, Redis
(Memurai 4.1.2 / redis 7.2.5, `luwi_v1` at v12), Preact dashboard, Vitest, pnpm 11.9.0.

## Verified state at program start (2026-09-01)

Do not re-derive these; they were measured on 2026-09-01 on this machine:

- Branch `codex/deepseek-session-bridge` has **zero commits of its own** — it is a label on
  `master`'s tip `ddb9bd0`. The entire tranche lives uncommitted: 81 modified files (+5055/−952)
  plus 40 untracked files (~9277 lines).
- The dirty tree is green: `pnpm typecheck` clean (both legs), `pnpm test` **148 files / 1452 tests
  passed, 0 failed**, `pnpm lint` clean.
- `SESSION_CHANGED_FILE` has exactly one non-prose occurrence in the repo:
  `packages/protocol/src/intelligence.ts:545` (the enum member). No producer exists.
- Automatic lease renewal: no code, no plan, no timer. Renewal is manual only
  (`POST /api/v1/leases/:leaseId/renew`, `lease renew <leaseId>`).
- `packages/adapters/src/native-identity.ts:70-78` returns `undefined` for Codex and Gemini with an
  in-code comment that their layouts were never measured. Only `resolveClaudeCode` works.
- Autostart: zero code; every mention is a deferral statement.
- Dashboard style guards (30 tests / 3 files) pass, but 47 raw-px font declarations stand against
  37 `var(--font-size-*)` uses, unguarded; `class-coverage.test.ts` covers 6 of ~16 views.
- `AGENTS.md` is stale: lines 1029-1031 still claim a mutation allowlist of one while
  `product-independence.test.ts` allowlists two; §21 does not know the 2026-08-24/25 tranche.

## Global constraints (apply to every phase)

- `AGENTS.md` is binding; when a phase touches Redis Streams, consumer groups, or Functions, read
  §7 before editing, and run the `redis-invariants` agent over the change before completing it.
- Never claim a command passed unless it ran and succeeded (§19). Use `/verify` for the
  definition-of-done sequence.
- Commit only where a phase's plan has an explicit commit step. Never `git reset --hard`,
  `git clean -f`, `git stash`, or `git checkout/restore .` (hook-blocked).
- `AGENTS.md` is in `.prettierignore` — edit it with the editing tools only, never a scripted
  write (CRLF trap).
- Adapters and scanners never execute discovered content. Redis data is validated on read.
- Report progress honestly, in Turkish, per the owner's standing preference.

## Decision gates (defaults chosen 2026-09-01; the owner may override before or during execution)

| #   | Gate                                                                                                                                                                                                                                                                   | Default                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Keep the second dashboard write module (`api/message-mutations.ts`, the bounded Ask flow) even though the 2026-08-25 drawer spec's non-goal said "no dashboard mutation"? The collision is between two in-flight plans, and the code is built, tested, and documented. | **Keep**, and record the supersession in ADR 0025 (Phase 0).                                                                                                                                                  |
| G2  | Adopt a minimal elevation/motion token layer (the mockup's `--luwi-shadow-*`/`--luwi-ease`/`--luwi-dur` have no production counterpart and no recorded rejection)?                                                                                                     | **Adopt minimally**: 2 elevation shadows + `--ease`/`--dur-1/2`, dialogs and drawer only — or, if rejected during Phase 4, write the rejection into the redesign plan. Either way the decision gets recorded. |
| G3  | Build autostart (D)? §21 calls it unapproved; the owner's completion directive arguably covers it, but its design is genuinely open.                                                                                                                                   | **Ask the owner at Phase 6 entry**; do not start it silently.                                                                                                                                                 |

## Phase 0 — Land the tranche: commits, ADR 0025, documentation sync

**Plan:** `docs/superpowers/plans/2026-09-01-phase0-commit-split-and-doc-sync.md` (detailed,
ready to execute). **Do this first**; ~14 000 uncommitted lines currently have no recovery point.

Exit: six commits on this branch, tree clean, `/verify` green, `AGENTS.md`/README/plan records
truthful again.

## Phase 1 — B2: transcript file observation (`SESSION_CHANGED_FILE` producer)

**Plan already exists:** `docs/superpowers/plans/2026-08-17-transcript-ingestion-b2-file-observation.md`
(27 tasks, none started). ADR 0023 already approves B2 — no new ADR needed. Execute that plan as
written. Facts the plan rests on, measured from 20 real transcripts — do **not** re-derive them:

- 16 of 140 mutating tool paths point outside this project → write an edge only when the path
  resolves inside a registered project.
- `is_error: true` genuinely occurs on tool results → a refused edit is not a change; a `tool_use`
  with no result is counted, not assumed.
- `Read` carries `file_path` (278 calls) and is deliberately not a change → an allowlist of
  mutating tools, never "any tool with a path".

The plan names `apps/daemon/src/intelligence-service.ts` as the projection entry point. Close with
an `AGENTS.md` §21 / README status update in the same phase (B2 is currently documented as "not
started" — that sentence must flip only when it is true).

Exit: `SESSION_CHANGED_FILE` edges appear in the fixture graph from a seeded transcript; the edge
enum has no producer-less member left; `/verify` green.

## Phase 2 — Automatic lease renewal (_design-first_)

No plan exists. Run `superpowers:brainstorming`, draft **ADR 0026** with the `/adr` skill, then
`superpowers:writing-plans`. Requirements the design must satisfy:

- Renewal is **holder-side**. §3 keeps LUWI out of terminals and leases are advisory; the daemon
  gets no renewal timer. The natural holders are the `agent run` wrapper
  (`apps/cli/src/agent-runner.ts`) and the MCP-bound session path.
- Renew every lease the session holds at roughly half its TTL while the wrapped process lives;
  stop on exit. Whether clean shutdown releases or lets leases expire is an ADR decision — record
  it either way.
- Reuse `POST /api/v1/leases/:leaseId/renew` and `luwi_renew_lease`; no new Redis Function unless
  the record shape changes (registry rule: version moves only on a record-shape change).
- A failed renewal is surfaced to the terminal, not silently retried forever.
- Update `AGENTS.md` §21's "Automatic lease renewal … remain unapproved" sentence when the ADR
  lands.
- The two neighboring gaps `AGENTS.md` itself names — notification when a held path frees, and
  lease↔commit correlation — are **in scope for the brainstorm**: the ADR either designs them
  alongside renewal or defers each with a recorded reason. Neither may be silently dropped.

Exit: a long-running `agent run` session's lease outlives the TTL without manual renewal, proven
against the fixture daemon; ADR 0026 committed with the code.

## Phase 3 — Codex and Gemini native identity resolvers (_measurement-first_)

The repo's discipline: measure before specifying (B1's spec was corrected by measurement twice).

1. Measure the real on-disk layouts on this machine — Codex (`~/.codex` or wherever the two
   running `codex` helpers write) and Gemini CLI. Record the measurements in a dated spec under
   `docs/superpowers/specs/`, the way `2026-08-14-native-transcript-ingestion-design.md` did.
2. Extend `packages/adapters/src/native-identity.ts` with `resolveCodex` / `resolveGemini`
   mirroring `resolveClaudeCode` (line 34), replacing the deliberate `undefined` at lines 70-78,
   with unit tests per resolver against fixture layouts.
3. Wire through the existing session self-registration path (`session attach`, `agent run`) — the
   binding machinery (ADR 0022/0024) needs no change.
4. Kimi: only if evidence of an installation exists on this machine; otherwise record "not
   measurable here" in the spec and leave the resolver absent.

**Scope limit:** identity binding only. Transcript _ingestion_ for non-Claude vendors is not in
this phase — the B1 reader is Claude-format-specific, and a Codex reader would need its own
measured phase and owner approval.

Exit: `agent run codex` (and gemini, if installed) produces a native binding visible on
`#/sessions`; unbound-case counters unchanged for Claude.

## Phase 4 — UI token debt and the depth decision

Independent of phases 1–3; may run any time after Phase 0. Three tasks, one plan (write it with
`superpowers:writing-plans`; no ADR needed — this executes the existing design system):

1. **Font-size tokenization + guard.** Replace all 47 raw-px font declarations in
   `apps/dashboard/src/styles/{activity,projects,pulse,shell}.css` with the scale in
   `tokens.css:104-110` — mapping: 11px→`--font-size-2xs`, 12→`xs`, 13→`sm`, 14→`base`, 16→`lg`,
   18→`xl`, 22→`2xl`; any off-scale value rounds to the nearest token and the commit message names
   it. Expand `font: 12px var(--font-mono)` shorthands into `font-family` + `font-size` longhands
   (a `var()` inside the `font` shorthand grammar is fragile). Then add the missing guard to
   `apps/dashboard/src/styles/tokens.test.ts` beside the existing raw-pixel padding/gap check:

   ```ts
   it('font sizes reference the type scale', () => {
     for (const file of NON_TOKEN_STYLESHEETS) {
       const css = readFileSync(file, 'utf8');
       const offenders = [...css.matchAll(/font(?:-size)?\s*:[^;{}]*/g)]
         .map((m) => m[0])
         .filter((decl) => /\b\d+(\.\d+)?px/.test(decl))
         .filter((decl) => !decl.includes('var(--font-size-'));
       expect(offenders, `${file} hard-codes a font size`).toEqual([]);
     }
   });
   ```

   (Reuse the file-list constant the existing checks iterate; keep letter-spacing/line-height out
   of scope for the regex — it matches only `font`/`font-size` declarations.) Also fix the three
   surviving raw radii (`projects.css:366` 2px, `pulse.css:240` 4px, `pulse.css:830` 3px) and
   decide the `.eyebrow` letter-spacing (`shell.css:316-322`: 0.13em vs the design system's
   0.22em) — either adopt 0.22em or comment why 0.13em stays.

2. **Depth and motion (gate G2).** Default: add `--shadow-raise`, `--shadow-overlay`, `--ease`,
   `--dur-1`, `--dur-2` to `tokens.css` (values re-derived for the dark ground, not copied from
   `--luwi-shadow-*`'s light-glass assumptions), apply them to the detail drawer, dialogs, and the
   command palette only, and replace the three hardcoded durations (`pulse.css:249`,
   `activity.css:136`, the drawer animation). If instead rejected, back-annotate the rejection
   into `docs/2026-08-14-dashboard-redesign-plan.md`. Either outcome is recorded.
3. **Class-coverage guard extension.** Extend `apps/dashboard/src/styles/class-coverage.test.ts`
   VIEWS from 6 files to every view/component that carries literal classNames — including
   `projects-view.tsx`, `sessions-view.tsx`, `activity-view.tsx`, the usage/context/optimization/
   graph views, `detail-drawer.tsx`, `ask-session-dialog.tsx` — deleting any dead classes it
   surfaces rather than allowlisting them.

Exit: zero raw font-size/radius literals in the four stylesheets, guards enforcing it, depth/motion
decision recorded, `pnpm test` green.

## Phase 5 — MCP registration (user-assisted, small)

The server is proven but unregistered: this machine has no `claude` CLI, only the VSCode extension.
Either the owner installs the CLI and runs the `claude mcp add` block from `CLAUDE.md`, or the
session hand-edits `~/.claude.json` **with the owner's confirmation in chat**, using a freshly
registered session id (session ids are runtime identity — stale on every daemon restart, so
registration must document the re-registration step, not pretend the id is durable).

Exit: the 36 `luwi_*` tools reachable from a live Claude session, verified by one real
`luwi_list_leases` round-trip.

## Phase 6 — Autostart (gate G3, _design-first_, owner approval required at entry)

Do not start without the owner's explicit go in chat. If approved: brainstorm → ADR 0027 → plan.
Recommended shape to bring to the ADR: an **opt-in** `luwi setup --autostart` that writes a
Windows Task Scheduler entry (and `--no-autostart` that removes it), keeping the daemon's
single-owner lease semantics untouched; no service, no supervisor process. Update `AGENTS.md`
§21's autostart sentence when the ADR lands.

## Phase order and reporting

0 → 1 → 2 → 3 → 4 → 5 → 6. Phase 4 is order-independent after 0. After each phase: run `/verify`,
commit per that phase's plan, and report in Turkish what ran, what passed, and what was **not**
done. At program end, update the owner-memory project-position note if the session has memory
access, and `README.md` "Current status" one final time.
