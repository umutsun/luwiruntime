# Faz 3 — fleet visibility + coordination pipeline (design)

Date: 2026-09-16. Follows Faz 2 (fleet effectiveness: safe-verify profile, single coordinator,
lease-injected prompts, honest deferred delivery — all built, reviewed, live-verified, committed
`940b6ee`). Faz 3 makes the fleet **visible at a glance** and turns the now-verified workers into a
**real implement→verify pipeline**. Sources: the owner's radial-label request, and codex's live
feedback #6 (quality telemetry) and #3 (implementer→verifier→integrator).

Owner decisions (2026-09-16): execution order **3.1 + 3.2 together (one dashboard pass) → 3.3**;
radial label **Option B** (title as a third visible line; the agent name stays visible).

## Key clearance — §21 is not breached by 3.3

The implementer→verifier→integrator flow is built **entirely as repo-external fleet-config** (a
`flow.mjs` beside `send.mjs`) that chains CLI verbs the daemon has served since Phase 2. §21 forbids
**LUWI (the daemon)** doing task orchestration; an external script chaining independent, correlated
messages is the same precedent ADR 0031 set. So 3.3 needs **no daemon/protocol/Redis change** and
opens no §21 boundary. The line: sequencing in an external script = in scope; a daemon-side flow
state machine / auto-advance / re-dispatch scheduler = crosses §21 and is **not** built here.

## 3.1 — Radial lens: session-name labels (Option B)

**Problem.** The radial lens already renders an always-visible label per session node, but that label
is `agentName` (which repeats across same-agent sessions) + a status/branch sub-line; the session's
distinguishing **name** (`session.title`, the native GUI chat title) is shown **only** as the hover
`title=`. The owner wants the name visible at a glance.

**Design (Option B).** Add a **third label line** — the session name — under the existing agent-name
and status lines, so agent + status stay visible and the name is added, not swapped.
- Model (`apps/dashboard/src/overview/model.ts`, `layoutRadial` session branch): expose the name on
  the `RadialNode` (e.g. a `title` field) = `truncate(session.title ?? \`Session <abbrevId>\`, ~18
  chars, ellipsis)`. Truncate model-side (precedent: `snippet`, `abbreviateId`) — a fixed char cap is
  what protects phone width and neighbour collisions. Keep `hint` (hover) carrying the **full**
  untruncated name so nothing is lost when truncated.
- View (`apps/dashboard/src/overview/radial-view.tsx`): render the new line as
  `<span className="radial__label-title">`.
- CSS (`apps/dashboard/src/styles/overview.css`): a new `.radial__label-title` rule — **must** use
  `color: var(--text-muted)`, `font-size: var(--font-size-2xs)` (or the existing clamp), spacing via
  `--space-*`; no raw px/hex/opaque colour (tokens.test.ts) and the new className must have a matching
  selector (class-coverage.test.ts). Inherits light/dark for free via tokens.
**Guards/risks.** New className ⇒ class-coverage + tokens guards apply (satisfied by the tokenised
rule above). Long titles **must** be truncated or they overflow `nowrap` and overlap neighbours
(the original reason for hover-only). Comments stay vendor-generic (product-independence guard). No
protocol/Redis/daemon change — pure client-side derivation.

**Tests.** `overview/model.test.ts`: a session node exposes the truncated title + a long title gets
the ellipsis; hover `hint` keeps the full name. `styles/class-coverage.test.ts` + `tokens.test.ts`
pass with the new rule.

## 3.2 — Fleet quality telemetry (codex #6)

**Problem.** The overview shows `events/min` — activity, not delivery quality.

**Design (dashboard-only, no new data).** The overview already loads the bounded `messages` list.
Add one pure helper beside `rateOf` in `model.ts` folding the ~100 most-recent messages into three
**honest, derivable facts**:
1. **Answered rate** — `state==='responded' && response.status==='answered'` over all terminal
   messages. (`partially_answered` counted separately, not as answered.)
2. **Response latency (p50)** — median `respondedAt − createdAt` over answered messages
   (reuse `formatDuration`).
3. **Fail/timeout rate** — share of terminal messages in `failed|timed_out|rejected` (the honest
   proxy for re-dispatch; named for what it is, never "re-dispatch").
Default UI: **repurpose the existing events tile** (key `events` → a delivery tile, route
`#/messages`); `events/min` survives on the Radial centre disc, so activity isn't lost. Sub-text
states the window ("recent N exchanges") so it never overclaims. Empty runtime → `—`/"no exchanges".
**Framing boundary.** Never an aggregate "quality score" or releaseReadiness/lifecycleStage naming
(§21 + product-independence.test.ts forbid it) — these are observed delivery facts. Reuse the `Stat`
shape ⇒ no new className/token ⇒ class-coverage/tokens guards untouched.

**Deferred (need new instrumentation, NOT in Faz 3):** true re-dispatch rate (the `idempotent` flag
is never persisted on the record; no attempt/retryOf field) and a real test-result signal (workers
don't reliably attach `test_result` evidence; the scope loader drops evidence types). Stated plainly
so the tiles don't fake a signal that doesn't exist.

**Tests.** `overview/model.test.ts` (stats key list + answered/latency/fail assertions with fixture
messages), `app.test.tsx` (tile label/route).

**Collision note (3.1 + 3.2).** `overview/model.ts` and `overview.css` are the hottest dashboard
files and a parallel session may be editing them. Do 3.1 + 3.2 in **one pass**, acquire a work lease
on `apps/dashboard/src/overview/model.ts` first, keep diffs tight, and re-run the overview suite
(`model.test.ts`, `overview.test.tsx`, `app.test.tsx`) + the token/class-coverage guards after.

## 3.3 — implementer→verifier→integrator flow (codex #3, repo-external)

**Design.** One `flow.mjs` in `~/.luwi/managed-agents/albanoosh/` (repo-external, beside `send.mjs`),
chaining primitives that already work, using the persistent coordinator as message source:
- **Stage 1 — implement.** `message ask --target-agent <implementer>`, poll `message await`/`get`
  (30 s cap → re-poll to the message `deadlineAt`) until terminal. **Advance gate:** state
  `responded` **and** `response.status==='answered'` (a genuine `answered` means the child's own MCP
  fired, not the bridge). Optional lease **observation** (not enforcement) in the receipt.
- **Stage 2 — verify.** On answered, `message ask --target-agent <verifier>` (a **different**
  agent) with the implementer's answer + evidence + branch/diff reference; poll to terminal. A
  turn-based GUI verifier is fine — its `delivery` is `deferred`, so the coordinator waits without
  reporting a false timeout. **Advance gate:** verifier answered with a pass verdict.
- **Stage 3 — integrate.** **STOP and hand off.** Write a receipt (like `receipt.json`) naming the
  branch/local commit + both correlation ids + verdicts. **A human runs the merge + push.**
- **Failure/re-dispatch:** `rejected|failed|timed_out` → stop, print the correlation id, human
  decides. Re-dispatch is explicit + bounded (fresh idempotency key), never silent.

**Hard gates (must stay human / must not be built).** Merge + push always human (§13; albanoosh
codex worker's sandbox even denies network so it *cannot* push — don't engineer around it). No
terminal injection (§3). Advisory leases are observation, not proof of isolation. **No daemon-side
flow state / auto-advance / scheduler** (that would cross §21 — out of scope, needs its own ADR).

**Size.** S–M, zero repo change (repo-external fleet-config).

## Also (operational, not a phase item)

Fast-forward the origin default `codex/deepseek-session-bridge` to `940b6ee` (or later), owner's
call — a clean FF, no force. Keeps the customer-facing default current with Faz 2.

## Out of scope (unchanged from §21, unless the owner opens it)

A daemon-side orchestration engine (persisted flow state, auto-advance, scheduling); automatic
merge/push; true re-dispatch + test-result telemetry (new instrumentation); everything else in the
§21 deferred list.
