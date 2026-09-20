# LuwiBot Cockpit Faz 2 (Intervene) Implementation Plan

**Goal:** Make the LuwiBot widget cockpit operable: Approve / Reject a plan, Answer a blocked
goal, and Stop a goal, from the widget, with a human click at every gate. Interventions leave the
dashboard over the existing LuwiBot WebSocket as a new `intent` message; the LuwiBot server executes
them against the daemon. Spec: `docs/superpowers/specs/2026-09-19-luwibot-hitl-autopilot-cockpit-design.md`
(Faz 2). Builds on Faz 1 (observe cockpit, already built).

## Deviation from the spec — no operator-proxy session

The spec's Component 1 has the LuwiBot server hold a live LUWI session as agent `luwibot-chat` and
call the operator-proxy endpoints with it. **Dropped, deliberately.** The daemon's `requireOperator`
(`apps/daemon/src/autopilot-service.ts:206`) returns `'operator'` when `sessionId` is `undefined`,
and all three request schemas (`goalPlanDecisionRequestSchema`, `goalAnswerRequestSchema`,
`goalAbandonRequestSchema`, `packages/protocol/src/goal.ts:165-178`) make `sessionId` optional. A
session-less loopback POST is therefore accepted as the operator itself — the intended "operator
surface" path under §4's loopback-only trust model. The LuwiBot server is a trusted loopback process
relaying a human click, so it calls session-less; the goal transition records `by: 'operator'`.

This removes the spec's heaviest, most fragile piece — session register → heartbeat → lease-renew →
re-bind on daemon restart — and an unsolved sub-problem (a plain-HTTP session never leaves `starting`
without an MCP reader, so the starting-session reaper would kill it every 180 s). Every spec
invariant still holds: a human clicks every gate, the AI never approves (chat and intent are separate
code paths, no model call on the intent path), product-independence is intact (the mutation happens
in the external server, not the dashboard), and no auto-merge exists. Attribution reads `operator`
instead of `luwibot-chat` — arguably more honest for a single-user local system.

Owner setup note: none. Because it is session-less, the project's autopilot policy does **not** need
to name `luwibot-chat` as an operator proxy.

## Global constraints

- **Product-independence unchanged.** The widget adds no HTTP mutation verb and no import of the six
  mutation modules; it sends WS frames. `apps/dashboard/src/product-independence.test.ts` stays
  green as-is. Non-test dashboard source must not contain the words `claude|codex|gemini|kimi` or a
  quoted string ending `/approve` etc. (the daemon paths live only in `server.mjs`, which that guard
  does not scan).
- **Design tokens.** Every new `luwibot-cockpit*` class matches a rule in `src/styles/shell.css`
  (`tokens.test.ts`, `class-coverage.test.ts`).
- **Reuse.** Reuse `ConfirmDialog` (`components/confirm-dialog.tsx`) for the consequential gates and
  the Faz 1 `FlowPanelView` for the read-only body.

## Intent protocol (WS)

`{ kind: 'intent', action, goalId, payload?, requestId }` → `{ kind: 'intent_result', requestId, ok, error? }`.
- `action ∈ { 'approve_plan', 'reject_plan', 'answer_goal', 'abandon_goal' }`.
- `payload`: `answer_goal` carries `{ text }`; the others carry nothing (Faz 2 sends no note/reason).
- Chat frames stay `{ message, history } → { reply | error }` (no `kind`) unchanged; the widget
  routes an incoming frame by `data.kind === 'intent_result'`.

---

### Task 1 — Reader surfaces the blocked question

`FlowGoal` (Faz 1) carries `{ id, title, state, tasks }`; the Answer box needs the escalation
question text. Add one optional field.

**Files:** `apps/dashboard/src/api/autopilot-flow.ts`; test `apps/dashboard/src/api/autopilot-flow.test.ts`
(new if absent).

- [ ] Add `question?: string` to `FlowGoal`; in the goal map set `...(goal.escalation === undefined ? {} : { question: goal.escalation.question })`.
- [ ] Test (red→green): a `blocked` goal whose `escalation.question` is set surfaces `question`; a
  goal without escalation has none. Fixture goals go through `goalCollectionSchema` shape.
- [ ] Guard: `model.test.ts` and the drill-down are unaffected (optional field; `autopilotFlowPanel`
  ignores it).

### Task 2 — LuwiBot server intent handlers (session-less operator)

**Files:** `C:/xampp/htdocs/luwibot/server.mjs`; test `C:/xampp/htdocs/luwibot/test.mjs`.

- [ ] Export a pure mapper:
  ```js
  export function intentRequest(action, goalId, payload = {}) {
    const base = `/api/v1/goals/${encodeURIComponent(goalId)}`;
    switch (action) {
      case 'approve_plan': return { path: `${base}/plan/approve`, body: {} };
      case 'reject_plan':  return { path: `${base}/plan/reject`,  body: {} };
      case 'answer_goal':  return { path: `${base}/answer`, body: { text: String(payload.text ?? '').trim() } };
      case 'abandon_goal': return { path: `${base}/abandon`, body: {} };
      default: return null; // unknown action → refused, never a daemon call
    }
  }
  ```
- [ ] `handleIntent({ action, goalId, payload })`: validate `goalId` non-empty and `intentRequest`
  non-null and (for `answer_goal`) `text` non-empty; POST `cfg.luwiUrl + path` with
  `content-type: application/json` and the JSON body (session-less); return `{ ok: r.ok }` or
  `{ ok: false, error }` relaying a non-2xx body's message. Never calls `chat()`/DeepSeek.
- [ ] WS `/chat` handler: if `msg.kind === 'intent'`, `handleIntent` → send
  `{ kind: 'intent_result', requestId: msg.requestId, ...result }`; else the existing chat path,
  unchanged. Structural guarantee: the intent branch has no model call.
- [ ] `test.mjs` (assert-based, no live daemon): `intentRequest('approve_plan','g 1')` →
  `/api/v1/goals/g%201/plan/approve`, body `{}`; `answer_goal` carries trimmed `text`; unknown
  action → `null`. (Keeps the existing `aggregateUsage` test.)

### Task 3 — Widget cockpit controls + intent send

**Files:** `apps/dashboard/src/components/luwibot-chat.tsx`; test `luwibot-chat.test.tsx` (extend).

- [ ] In the flow-load effect, alongside the Faz 1 `FlowPanel`, derive the active goal target from the
  **raw** flow: `const goal = state.state === 'ready' ? state.data.goals[0] : undefined;` and keep
  `{ goalId, state, question }`. (Raw `goals` are already non-terminal — the reader drops terminal
  goals — so the first is the active one and Stop always applies.)
- [ ] Under `<FlowPanelView>`, render a controls bar from the target's raw `state`:
  - `plan_review` → **Approve** and **Reject** buttons.
  - `blocked` → the `question` (if any) + a textarea + **Send answer**.
  - always (target present) → **Stop**.
- [ ] Approve / Reject / Stop open a reused `ConfirmDialog` naming the goal and action; on confirm,
  send the intent. Answer sends on submit (human-authored free text, no confirm).
- [ ] WS: factor `rawSend(frame)` from the existing chat send (connect-or-queue-on-open); send
  `{ kind: 'intent', action, goalId, payload?, requestId }` where `requestId` is a ref counter
  (`intent-${n}` — no `crypto.randomUUID` dependency for jsdom). Track one in-flight intent
  `{ requestId, phase: 'pending' | 'error', error? }`; disable controls while pending.
- [ ] Message handler: branch `data.kind === 'intent_result'` → match `requestId`, set phase (ok →
  clear; the 5 s flow refresh reflects the new state) / error → show `error`. Chat frames (no
  `kind`) keep today's behaviour; `setBusy(false)` only on a chat frame.
- [ ] Tests (extend `luwibot-chat.test.tsx`, house style — `toBeTruthy`/`toBeNull`, `cleanup()`,
  `FakeSocket` stub capturing `send`): Approve/Reject present only on `plan_review`; Answer only on
  `blocked`; Stop present with any active goal; clicking Approve then confirming calls
  `socket.send` with `{ kind:'intent', action:'approve_plan', goalId }`; an `intent_result`
  `{ ok:false, error }` surfaces the error.

### Task 4 — Styling + full verify

**Files:** `apps/dashboard/src/styles/shell.css`.

- [ ] Add rules for the new `luwibot-cockpit*` control classes using the file's real tokens
  (`--text`, `--text-muted`, `--border`, `--space-*`, `--font-size-sm`, `--danger`); reuse
  `ConfirmDialog`'s `dialog*` classes as-is.
- [ ] `cd apps/dashboard && pnpm exec vitest run` (incl. product-independence, class-coverage,
  tokens); root `pnpm typecheck`; `pnpm exec eslint` on touched files; `prettier --write` touched
  files; `node C:/xampp/htdocs/luwibot/test.mjs`.

## Not in Faz 2 (later)

- Turbo / auto-operator (Faz 4), end-to-end supervised run (Faz 3).
- Note/reason inputs for approve/reject (endpoints accept them; UI can add later).
- Task-level operator controls (orchestrator's, per spec Non-goals).
