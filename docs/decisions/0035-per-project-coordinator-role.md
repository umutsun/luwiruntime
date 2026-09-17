# ADR 0035: Per-project coordinator role

Status: Accepted
Date: 2026-09-16

## Context

The fleet needs one dispatcher — a coordinator — per project: the session that sends the
implement/verify messages and that `message ask --source` names. Faz 2.2 (ADR follow-up, albanoosh
scaffold) gave the managed fleet one persistent `albanoosh-coordinator` session, but "one" is only
the manager's own discipline. Nothing enforces it: a second manager, a manual `session register`, or
a stray script could create a second coordinator, and the runtime could not tell which is
authoritative. The owner requires that a session can be **assigned** the coordinator role and that a
project has **exactly one** coordinator — a second claim must be refused.

Worker↔worker communication already exists and is not the gap: the durable inbox request/reply
(ADR 0006) carries messages between sessions, and a bridge worker is a live reader (the delivery
signal, Faz 2.4). What is missing is the enforced, assignable single-coordinator identity.

Constraints. This is coordination-plane identity — IRIS owns "runtime sessions, presence,
heartbeats, task intents, messages, leases, project events" (§3) — and it must not become §21 task
orchestration (no work queue, no scheduler, no auto-advance). §3 keeps LUWI out of terminals. §7
governs the Redis Functions.

## Decision

A per-project coordinator role, enforced by the daemon, modelled on the native session binding
(ADR 0022) with the link/retention machinery removed. It is deliberately **not** a work lease.

### Single-holder key and CAS

- Redis: `luwi:v1:project:{projectId}:coordinator`, a HASH `{ projectId, sessionId, agentId,
claimId, claimedAt, version }`. One key per project makes single-holder structural.
- `claimId` is a fresh nonce minted on **every** claim, and the take-over CAS keys on it, not on
  `version` alone. This closes an ABA both the §7 reviewer and the adversarial review confirmed on
  the first cut: because release DELs the key and the next grant restarts at `version 1`, `version`
  is a **reused** token, so a take-over decided against a dead holder at v1 could match a newer,
  live holder that coincidentally also reached v1 — evicting it and producing two live coordinators.
  Native binding (ADR 0022) is immune because it never deletes (version never repeats) and also
  checks a stable id; the coordinator deletes on release, so the per-claim `claimId` is the
  incarnation check that makes the take-over safe. `version` stays for display and a cheap first CAS
  check. `sessionId` alone would not suffice — a same-session release-and-reclaim reuses it — but a
  fresh `claimId` per claim does.
- Two Lua Functions in `luwi_v1`: `coordinator_claim` and `coordinator_release`. The library stays at
  **v12** — a new Function reloads on its own content hash and no stored **record shape** that an
  older reader parses is changed (the registry's own version rule). A daemon started before these
  Functions land must be restarted once before a claim can succeed (the ADR 0033 `project_update`
  precedent).
- The read/decide/validate split of ADR 0022 is reproduced. Deciding "is the current holder still
  live?" means reading the holder session's status key, whose name is derived from the stored holder
  id, and §7 forbids a Function deriving a key name. So the daemon reads the holder's status in
  TypeScript, a pure `coordinator-policy.ts` turns `(holder, holderStatus, sessionId)` into one
  outcome, and Lua only compare-and-sets on the monotonic `version` before applying:
  - no holder → **grant** (expected version 0);
  - holder is the same session → **unchanged** (idempotent re-claim);
  - holder's session is not terminal → **conflict**, naming the holder;
  - holder's session is terminal (`completed`/`disconnected`) or gone → **takeover** (CAS on the
    holder's version **and** `claimId`).

### Assign, and enforce exactly one

- `POST /api/v1/projects/:projectId/coordinator { sessionId }` claims the role for the named session.
  The session must exist, belong to the project, and not be terminal (the lease-service validation).
  A second claim while a **live** holder exists is refused **409 `COORDINATOR_CONFLICT`**, naming the
  holder; a conflict writes nothing. CAS contention is bounded at three attempts, then
  `COORDINATOR_CONTENDED` 409 (the native-binding retry loop, event ids minted once so a retry cannot
  double-append).
- `DELETE /api/v1/projects/:projectId/coordinator { sessionId }` releases, **holder-only** (a role
  another session can drop is not the holder's) — the lease-transition holder CAS.
- `GET /api/v1/projects/:projectId/coordinator` returns the holder and a derived `live` flag (the
  holder session's status, read in TypeScript).
- Two new closed-enum event types: `coordinator.claimed` (a fresh grant or a take-over — the version
  delta tells them apart) and `coordinator.released`. (They must join `runtimeEventTypeSchema` or the
  repository parser and the realtime relay reject them — the ADR 0022 failure mode.) The proposal
  first listed four, adding `coordinator.denied` and `coordinator.superseded`; both were dropped as
  built. `denied` contradicts this ADR's own "a conflict writes nothing" (a refused claim leaves no
  event, the native-binding precedent), and `superseded` folds into `coordinator.claimed` with the
  version increment. Two events, not four.

### Auto-release is derived, not swept

The role's liveness is the holder session's own heartbeat and presence TTL, exactly as the native
binding's is. A dead holder — terminal, or `disconnected` once its ~15 s presence TTL lapses — is
treated as vacant by the next claim (takeover) and reported not-live by `GET`. Therefore: **no new
sweeper, no deadline set, and no edit to the four session-terminal Functions** (`session_close`,
`session_disconnect`, `session_status`→completed, `session_reap_starting`). `disconnected` counts as
vacant, so a dead coordinator process frees the role for a successor — native-binding semantics, not
the lease's reconnectable semantics.

### What it is not

- The record carries **no task, work, stage, or queue field** — it stores _who_ coordinates, never
  work state — so it does not drift into §21 task orchestration. The implement→verify sequencing
  stays in the external `flow.mjs` (Faz 3.3), and merge/push stays a human gate (§13).
- §3 is untouched: a claim spawns nothing and injects into no terminal. The claim is **hard-enforced
  at the daemon** (a second live claim is refused) but **execution-advisory** (the daemon cannot stop
  a rogue process from behaving as coordinator) — the same boundary as leases.
- No MCP tool in this increment. The albanoosh manager and `flow.mjs` drive the claim over
  HTTP/CLI. An MCP `luwi_claim_coordinator` (holder from the bound session, never input — the lease-
  tool precedent) is a clean later add if an in-session agent must self-claim.

### Consumers

The albanoosh manager claims the role for its persistent `albanoosh-coordinator` session at startup
(repo-external); a second manager or coordinator is then refused by the daemon. `flow.mjs` (Faz 3.3)
dispatches its implement/verify messages as the claimed coordinator.

## Consequences

- Exactly one coordinator per project is enforced at claim time; a second is refused with the holder
  named. The role frees itself when the holder session dies, with no new sweep.
- A daemon started before the Functions land must be restarted once (v12, content-hash reload).
- New/edited: `function-library.ts` (+2 Functions), `function-registry.ts`, `redis-keys.ts`,
  `packages/protocol/src/coordinator.ts` (new) + `index.ts` + `runtime-event.ts`,
  `packages/runtime/src/coordinator-policy.ts` (new) + `index.ts`,
  `apps/daemon/src/coordinator-service.ts` (new) + `runtime.ts` wiring, routes in `app.ts`. Tests per
  §15 (policy unit; claim/refuse/takeover/release integration; route inject). The redis-invariants
  reviewer sees the new Functions before completion.
- Review outcome: both the redis-invariants §7 review and a four-dimension adversarial review
  confirmed exactly one defect on the first cut — the version-reset ABA above — and nothing else.
  It was fixed with the per-claim `claimId` incarnation guard, and a `coordinator-transitions`
  integration test now reproduces the ABA (a stale v1 take-over against a newer v1 holder) and
  asserts it is refused, so the live holder is never evicted.

## Rejected alternatives

- **A work lease (ADR 0020) on a coordinator path.** Wrong semantics: a whole-project lease
  normalizes to the empty match form and would block every file lease in the project; a session may
  hold up to 100 leases (single-holder is not native); and leases free on the expiry sweep, not on
  session end.
- **Eager cleanup** (clear the key the instant the holder disconnects). Requires threading a release
  into all four session-terminal Functions — a large surface for a cosmetic `GET` benefit. Derived
  liveness is sufficient and matches how the native binding already behaves.
- **A daemon-side flow/state machine or scheduler.** That is §21 task orchestration — out of scope.
  The sequencing lives in the external `flow.mjs`.

## Amendment 2026-09-17: operator take-over of a live holder

The single-holder rule refuses a live holder rather than evicting it, so two agents racing never
oust each other. But that also blocks the one thing the dashboard's "Make coordinator" is for — an
operator deliberately reassigning the role to another session — and on a fleet-managed project the
manager re-claims the role every tick, so a plain release is undone within seconds and a reassign
`409`s forever. The rule was meant for automated races, not human intent.

So the claim request gains an optional `takeover` flag. Absent/false keeps the automated rule (a
live holder is `409 COORDINATOR_CONFLICT`). `true` is set only by an explicit operator gesture — the
sessions view's "Take over" button, a second click after the conflict, which is itself the
confirmation. The daemon then treats a live different holder as takeable. **The CAS is unchanged:**
the policy still returns `takeover` keyed on the observed holder's `version` and `claimId`, so the
`claimId` ABA guard still holds — an operator take-over evicts exactly the incarnation it observed,
never a newer one. No `luwi_v1`, Function, or stored-record change; the decision moved in the pure
policy only, so a daemon restart is enough to pick it up.

Its counterpart lives in the repo-external albanoosh manager: instead of claiming the role every
tick unconditionally, the manager claims only when the role is vacant or already its own, and yields
to any other live holder. So an operator's take-over sticks — the manager sees a live human-assigned
coordinator and does not fight it — while auto-recovery is preserved (a vacated role is re-claimed).
§3 still holds: the take-over reassigns identity, it stops no process; and §21 is untouched.
