# LuwiBot HITL autopilot cockpit design — supervise a running goal, and hand it the wheel

Date: 2026-09-19. Builds on `2026-09-17-autopilot-orchestrator-design.md` and
`2026-09-17-project-autopilot-design.md` (ADR 0035: mode, policy, goal→plan→task→dispatch→verify,
operator-proxy). Nothing here is built. Written after the owner approved the cockpit framing and
added a "turbo mode" for when they are away.

## Problem

ADR 0035 gave autopilot three modes (off / supervised / autopilot) and a set of operator-proxy
transitions — approve a plan, reject it, answer a blocked goal, abandon it — gated on the acting
session being a policy-named operator proxy (`isOperatorProxySession`, `autopilot-service.ts`). But
there is no good human surface for them. The dashboard's LuwiBot widget
(`apps/dashboard/src/components/luwibot-chat.tsx`) is a read-only grounding chat over
`ws://127.0.0.1:3100/chat`; the drill-down shows the autopilot flow but cannot act on it. So
"supervised" autopilot has no operable approval surface: who approves the plan, from where, and how
does the human see the running goal to decide?

This session also proved the fleet works **hand-driven** (implement→verify via a CLI driver: real
commits, real verdicts) with autopilot `off`. Autopilot earns its place when there is a backlog to
grind and the human does not want to hand-drive each goal — which needs (a) a live cockpit to watch a
goal, (b) operable interventions, and eventually (c) an away mode where LuwiBot drives within bounds.

## Goal

A **human-in-the-loop cockpit inside the dashboard's LuwiBot widget** for one running autopilot goal:
the existing grounding chat grows into one LuwiBot surface that watches the
goal→plan→task→dispatch→verify loop live and lets the operator intervene — approve/reject the plan,
answer a blocked question, stop the goal — with the human load-bearing at every gate. Chat
(grounding), observe (live goal) and intervene (controls) live together in the one place the operator
already thinks of as LuwiBot. Plus a **turbo mode** the operator can hand the wheel to when away:
LuwiBot auto-operates the supervised loop within the policy's bounds, escalates anything outside them,
and never merges.

## Non-goals

- **No new dashboard daemon-mutation module.** Product-independence stays: the dashboard's write
  allowlist (`product-independence.test.ts`) is unchanged. Interventions leave the dashboard over the
  existing LuwiBot WebSocket; the mutation happens in the external LuwiBot server.
- **No auto-merge, ever — not even in turbo (§13).** The loop stops before merge/push; a human runs
  it. Turbo returns completed-but-unmerged goals with receipts.
- **No DeepSeek/AI holding the pen in supervised mode.** In supervised, the AI only grounds
  (explains the plan, why verify failed); every intervention is an explicit human click.
- **No task-level operator controls in phase 1–2** (dispatch/verdict/rework/cancel are the
  orchestrator's, not the operator's). The operator acts at goal scope.
- **No change to the orchestrator loop or its brain.** This is a surface + an operator-proxy
  executor, not a new agentic loop (that is `2026-09-17-autopilot-orchestrator-design.md`).

## Vocabulary

| Term | Meaning |
| --- | --- |
| Cockpit | The LuwiBot widget grown to show one running goal's live state + intervention controls. |
| Intent | A structured human action (approve/reject/answer/stop) sent from the dashboard to the LuwiBot server over the existing WS — distinct from a chat turn. |
| Operator-proxy session | A live LUWI session the LuwiBot server holds as agent `luwibot-chat` (a policy-declared operator proxy), used to call the daemon's operator-proxy endpoints. |
| Turbo | An away mode where LuwiBot auto-fires the operator-proxy intents within the policy's bounds and escalates anything outside them. |
| Escalation | A goal turbo will not auto-decide; it parks it (blocked) for the returning human. |

## Architecture — two directions, separate channels

**Observe (read, pushed).** The LuwiBot widget is a dashboard component, so it reads the same daemon
event stream the dashboard already consumes. When a goal is focused/running the widget renders, for
that goal: the plan (its tasks), each task's dispatch/verdict/evidence, the blocked question if any,
and budgets/limits consumed — driven by `goal.*`, `task.*`, `orchestrator.judgment.*` events. No
mutation, richer render only.

**Intervene (write, human click).** An Approve/Reject/Answer/Stop control in the widget sends an
**intent** message over the existing LuwiBot WebSocket (a new message kind beside the chat turn). The
LuwiBot server executes it against the daemon with its operator-proxy session; the result lands on the
event stream and the widget updates. The dashboard never calls a daemon mutation endpoint itself.

```
LuwiBot widget cockpit ──(WS intent)──▶ LuwiBot server ──(operator-proxy session, HTTP)──▶ daemon
        ▲                                                                                     │
        └──────────────────────── daemon event stream (WS realtime, via dashboard) ◀──────────┘
```

## Components

### 1. LuwiBot server — promoted to operator proxy (`C:/xampp/htdocs/luwibot/server.mjs`)

Today a read-only grounding chat. Adds:

- **An operator-proxy session.** On start it registers a LUWI session as agent `luwibot-chat` for the
  target project and keeps it alive with the standard bootstrap (heartbeat + lease renew), re-binding
  on daemon restart (session ids are runtime identity, they go stale). It reads the daemon URL and
  project from config, not from a chat turn.
- **Intent handlers** (`approve_plan` / `reject_plan` / `answer_goal` / `abandon_goal`), each mapping
  to the daemon endpoint (`POST /api/v1/goals/:goalId/plan/approve` | `/plan/reject` | `/answer` |
  `/abandon`) called with the operator-proxy session. The daemon already enforces the operator-proxy
  gate and the state machine, so a stale or illegal intent (approve a plan not under review) is
  refused server-side; the server relays the refusal to the cockpit.
- **A hard separation between chat and intent.** A chat turn goes to the brain (DeepSeek/grounding)
  and can never emit an intent. An intent arrives only from an explicit dashboard control and carries
  no model call. This is the structural guarantee that the AI cannot approve on its own in supervised
  mode.

### 2. LuwiBot widget — grown into the cockpit (`apps/dashboard/src/components/luwibot-chat.tsx`)

The existing compact chat popup grows into an expandable cockpit panel. It has two states:

- **Idle (no goal focused/running):** the compact grounding chat as today.
- **Cockpit (a goal is focused/running):** above/beside the chat, the focused goal renders live —
  plan steps, per-task state and evidence types, the blocked question, consumed budgets. Plan
  `under_review` → **Approve / Reject**; goal `blocked` → the question + an **Answer** box; a running
  goal → **Stop**. The chat stays available for grounding ("explain this plan", "why did verify
  fail").

- Every intervention is behind a `ConfirmDialog` naming the goal and the action (approve/reject/stop
  are consequential). The Answer control submits free text.
- Controls dispatch intents over the same LuwiBot WS the chat uses. No entry is added to the
  write-module allowlist; a test asserts the widget contains no daemon-mutation call.
- The widget keeps its current design-token discipline (`tokens.test.ts`, `class-coverage.test.ts`)
  as it grows — every new class matches a rule, no raw pixels or opaque colours.

### 3. Intent protocol (WS)

A minimal, versioned message `{ kind: 'intent', action, goalId, payload?, requestId }` →
`{ kind: 'intent_result', requestId, ok, error? }`. The `requestId` correlates the reply and makes an
intent idempotent from the UI's view. Chat stays `{ message, history } → { reply | error }`
unchanged.

## Interventions (phase 1–2, goal scope)

| Control | Daemon endpoint | Precondition | Guardrail |
| --- | --- | --- | --- |
| Approve plan | `POST /goals/:id/plan/approve` | plan `under_review` | ConfirmDialog; human click only |
| Reject plan | `POST /goals/:id/plan/reject` | plan `under_review` | ConfirmDialog; reason optional |
| Answer blocked | `POST /goals/:id/answer` | goal `blocked` | free-text; human authored |
| Stop goal | `POST /goals/:id/abandon` | goal not terminal | ConfirmDialog naming the goal |

## Turbo mode (phase 4) — LuwiBot drives while you are away

Turbo is **the supervised loop with LuwiBot as the auto-operator**, not raw `autopilot` mode. When
on, LuwiBot auto-fires the approve/answer intents **within the autopilot policy's existing bounds**
and escalates anything outside them. It is strictly safer than raw daemon `autopilot` mode because it
knows when to stop and ask.

**Non-negotiables (hold even in turbo):**

- **Never merges or pushes (§13).** The human returns to completed-but-unmerged goals + receipts;
  "undo" is cheap because nothing was merged.
- **Verify stays independent.** Turbo auto-approves the plan and auto-answers questions; it never
  fakes verification. The reviewer (codex) still verifies; a FAIL reworks or parks per policy.
- **Full audit trail + kill switch.** Every auto-decision is a recorded transition (what LuwiBot
  decided and why); the operator can flip turbo off instantly and review/reverse.

**Strict escalation (default; configurable per goal).** Turbo parks the goal `blocked` for the
human — never auto-deciding — on any of:

- a plan or task touching a `protectedPaths` entry (AGENTS.md, `.luwi`, …);
- a budget or rate limit hit (`maxDispatchesPerHour`, `maxTasks`, `maxWallClockMs`, `maxReworksPerTask`);
- a plan/goal confidence below `minConfidence`;
- a verify still `FAIL` after `maxReworksPerTask`;
- the reviewer unavailable (e.g. codex out of credits — measured live this session; without this an
  away goal stalls silently on verify).

The operator sets the strictness when launching a turbo goal (a per-goal override of the policy
defaults); "loose" is available but strict is the default. Merge escalation is not overridable.

## Invariants

- **Human load-bearing in supervised; bounded-autonomous in turbo.** In supervised, a human clicks
  every gate; in turbo, LuwiBot clicks within bounds and escalates outside them.
- **The AI never both plans and approves in one closed loop.** The brain (planning) and the
  operator-proxy intent (approval) are separate paths. In supervised, approval comes only from a UI
  click; in turbo, approval is a bounded auto-operator with escalation and no merge — the merge gate
  keeps a human structurally in the loop of every shipped change.
- **Product-independence.** No dashboard daemon-mutation module; interventions leave over the LuwiBot
  WS; `product-independence.test.ts` unchanged.
- **Runtime identity, not config.** The operator-proxy session is re-bound on every daemon restart;
  it is never written to a manifest.

## Testing (per AGENTS.md §15)

- LuwiBot server: an intent handler maps to the right endpoint with the operator-proxy session; a
  chat turn can never emit an intent; a server-refused intent (stale plan) relays the refusal.
- Widget: the cockpit renders each goal state from a fixture event set; each control is present
  only in its valid precondition; a test asserts no daemon-mutation call is added.
- Turbo: each strict-escalation trigger parks the goal instead of auto-deciding; a merge is never
  auto-fired; every auto-decision writes an audit transition; turbo-off stops further auto-intents.

## Roadmap (phases)

- **Faz 0 — Ground.** Deploy LUWI fix #5 (coordinator read-batching, so the coordinator stops
  rotating every tick — a supervised goal runs for hours) and add "reviewer unavailable → escalate"
  so a down verifier does not stall a goal. Supervision is only meaningful once these hold.
- **Faz 1 — Observe.** The LuwiBot widget grown into a live goal cockpit (read-only). Valuable alone, no risk.
- **Faz 2 — Intervene.** LuwiBot server operator-proxy session + intent handlers; dashboard controls
  + ConfirmDialog. Supervised autopilot becomes operable.
- **Faz 3 — End to end.** Run one supervised goal on an isolated Albanoosh clone, human-approved from
  plan to verdict; compare against hand-driving.
- **Faz 4 — Turbo.** The auto-operator with strict-configurable escalation and the non-negotiables,
  built only after Faz 3 shows the supervised loop and LuwiBot's judgment are trustworthy.
