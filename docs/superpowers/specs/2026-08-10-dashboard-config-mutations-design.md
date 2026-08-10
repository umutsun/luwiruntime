# Dashboard configuration mutations — design

Date: 2026-08-10
Status: approved, not implemented

## Context

`AGENTS.md` section 21 records that the owner approved **dashboard mutations** on 2026-08-10 and
that nothing was built. It also names three decisions that belong to this phase and leaves them
open. This document settles those three, and specifies the first increment: the native
configuration plan chain.

What exists today:

- The daemon serves the whole chain — `POST /api/v1/config/import-plan`, `/render-plan`,
  `/plans/:planId/approve`, `/plans/:planId/apply`, `/snapshots/:snapshotId/rollback-plan`,
  `/drift/scan`, `/reconcile`, `/inspect` — with snapshots, target-path locking, precondition
  hashes and receipt reconciliation already implemented and tested.
- `#/config` reads three of the resulting collections and calls none of the writes.
- `apps/dashboard/src/api/client.ts` exposes `get` and nothing else. The dashboard has no
  mutation path of any kind.
- `apps/dashboard/src/product-independence.test.ts` asserts that no production module contains
  `method: 'POST'` or a path ending in `/apply`, `/approve`, `/rollback` or `/scan`. This test is
  the codified form of the read-only rule.
- Nothing on this machine creates configuration plans. The MCP server never exposes control-plane
  writes (section 12), and there is no CLI for them. Without plan creation in the dashboard, the
  chain has no producer and an approve button would have nothing to act on.

## The three decisions

### 1. Origin on state-changing requests

**Decision: method-aware hardening.**

`validateLocalHttpRequest` (`apps/daemon/src/websocket-hub.ts:168`) accepts a request whose
`Origin` header is absent, and validates it against the allowlist when present. For GET this stays
exactly as it is.

For **POST** the rule becomes: an `Origin` that is present must be allowlisted, and an `Origin` that
is absent is tolerated only when the request's media type is `application/json`.

The reasoning is the browser's own behaviour. A browser attaches `Origin` to every request whose
method is not GET or HEAD, so a cross-site POST is already refused by the allowlist. A browser
cannot send `application/json` cross-site without a CORS preflight, and the daemon answers no
preflight — there is no `Access-Control-*` header and no `OPTIONS` handler anywhere in it, and none
is being added, because the dashboard is same-origin with the daemon in production and reaches it
through the Vite proxy in development. So an absent `Origin` combined with a JSON media type is
reachable only from a non-browser client, which already has loopback access and is already trusted
by section 4.

The check is POST-only because POST is the only method that needs it. `GET` and `HEAD` change
nothing. `PUT`, `PATCH` and `DELETE` are not CORS-safelisted methods, so a cross-site one always
preflights and therefore never reaches a handler at all; demanding a body's media type on a
bodyless `DELETE` would refuse a legitimate CLI call and close no vector. POST is the exception: a
form submission, or a fetch with a safelisted content type, is sent for real.

This costs nothing at the existing callers: `apps/mcp-server/src/daemon-client.ts:241` sets
`content-type: application/json` on every POST, and every POST in `scripts/seed-runtime.ts` passes
a body, which is the condition under which that script sets the same header.

Requiring an allowlisted `Origin` outright was rejected. It would break the fourteen MCP writes,
the seed script and every `curl`, and the repair would be to have non-browser clients assert a
browser origin they do not have.

Leaving the rule unchanged was rejected because `approve`, `drift/scan` and `rollback-plan` accept
an empty body, so the `Origin` header's behaviour is the single barrier in front of them. It holds
today; it should not be the only thing holding.

### 2. What a confirmation is

**Decision: the confirmation dialog comes before `approve`, and `approve` and `apply` run in one
user gesture.**

`approvePlan` mints a one-time token and returns it once; `applyPlan` requires it. The plan state
machine in `packages/runtime/src/config-policy.ts:12` allows `approved → applying | expired |
superseded` and **not** `approved → approved`. A client that loses the token cannot ask for another
one: the plan is dead until its fifteen-minute TTL (`apps/daemon/src/config-control-service.ts:167`)
expires it.

Separate Approve and Apply buttons would therefore turn an ordinary page reload into a discarded
plan. Instead the dashboard never presents an `approved` plan as actionable and never holds a token
across a user interaction. The two deliberate acts are pressing Apply on a plan whose diff is on
screen, and confirming a dialog that re-lists the exact file paths. The client then calls `approve`
and `apply` back to back inside one handler, with the token in a local variable that is never
written to component state, `localStorage`, `sessionStorage`, the URL or a log.

The daemon does not hold the token either. The round trip through the client is preserved, so
`apply` still requires possession of what `approve` returned.

Plans already in `approved` state — from the seeded fixture, or from a client that died between the
two calls — render with no action available. That is honest: the dashboard does not hold their
token and cannot obtain one.

Amending the state machine to allow re-approval was rejected as out of scope. It touches
control-plane policy and weakens a one-time approval, and the failure it prevents is bounded by a
fifteen-minute TTL and repaired by creating another plan.

### 3. Which mutations are in

**Decision: the configuration plan chain, minus `reconcile`.**

In scope: `import-plan`, `render-plan`, `approve`, `apply`, `snapshots/:snapshotId/rollback-plan`,
`drift/scan`.

Out of scope and untouched: `reconcile`, which is a bulk recovery pass over every operation receipt
in an ambiguous state and offers the caller no selection — a break-glass operation rather than a UI
act; `inspect`, which has no consumer here; and optimization accept/reject/evaluate, graph rebuild,
Git mutation and lease release, each of which carries its own prohibition that section 21's
approval explicitly does not carry in.

## Design

### Daemon — method-aware request validation

`LocalHttpRequestInput` gains `method: string` and an optional `contentType: string`.
`validateLocalHttpRequest` keeps its host and loopback checks unchanged, keeps rejecting the literal
origin `null`, and then:

- requires an allowlisted origin whenever one is present, on every method;
- when no origin is present, requires the media type to be `application/json` on `POST`, and
  accepts every other method as it does today.

The media type is the substring before the first `;`, trimmed and lowercased, so
`application/json; charset=utf-8` passes.

The `onRequest` hook in `apps/daemon/src/app.ts` passes `request.method` and the `content-type`
header. A rejected request keeps today's response exactly: `403` with
`{ error: { code: 'REQUEST_ORIGIN_REJECTED', ... } }`. No new error code, no new header, no CORS.

### Protocol

The dashboard needs to validate a daemon error body rather than trust its shape, and it needs the
single-record schemas the mutations return. `browser.ts` already exports the three config
collections; it gains `configPlanSchema`, `configPlanApprovalResponseSchema` and
`configOperationReceiptSchema` from `control-plane.js`.

`publicErrorResponseSchema` cannot simply join them. It lives in `runtime-api.ts`, which imports
`realtime.js`, which imports `runtime-event.js`, which imports `node:crypto` — so re-exporting it
through `browser.ts` would pull a Node builtin into the browser bundle, which
`apps/dashboard/vite.config.test.ts` builds the bundle to catch and which section 5 exists to
prevent. `stream-id.ts` already documents this exact hazard and the remedy for it.

The schema therefore moves to its own leaf module, `packages/protocol/src/public-error.ts`, which
imports nothing but `zod`. `runtime-api.ts` re-exports it so existing consumers are unchanged, and
`browser.ts` exports it from the leaf.

### Dashboard — the mutation module

A new `apps/dashboard/src/api/config-mutations.ts` is the only production module in the dashboard
permitted to issue a state-changing request. It builds its own narrow client rather than extending
`createDaemonClient`, so the read client stays read-only by construction and the guard test can
express exactly that.

```ts
export type MutationResult<T> =
  | { state: 'ok'; data: T; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number }
  | { state: 'failed'; reason: 'http'; httpStatus: number; code: string; message: string };
```

The failure shape carries the daemon's own code and message, unlike `ResourceResult`, which
collapses every failure to `unavailable`. `CONFIG_PLAN_EXPIRED`, `CONFIG_PLAN_NOT_APPROVED`,
`NATIVE_CONFIG_UNMANAGED`, `CONFIG_APPLY_FAILED` and `RUNTIME_NOT_READY` each tell the reader a
different true thing, and the surface that writes their configuration files should say which one
happened.

Exported operations:

| Function                         | Calls                                             |
| -------------------------------- | ------------------------------------------------- |
| `createImportPlan(input)`        | `POST /api/v1/config/import-plan`                 |
| `createRenderPlan(input)`        | `POST /api/v1/config/render-plan`                 |
| `createRollbackPlan(snapshotId)` | `POST /api/v1/config/snapshots/:id/rollback-plan` |
| `scanDrift()`                    | `POST /api/v1/config/drift/scan`                  |
| `applyPlanWithApproval(planId)`  | `POST …/approve` then `POST …/apply`              |

`applyPlanWithApproval` is one function precisely so that the token cannot escape it. It approves,
holds the token in a local variable, applies, and returns the receipt or the first failure. If
`approve` succeeds and `apply` fails, it returns the `apply` failure and says in its message that
the plan was approved and could not be applied — the plan is then dead, which is the truth.

### Dashboard — the config route

Plan creation writes no file of the developer's. It prepares a plan and its artifact, and the plan
must still be applied deliberately. It therefore needs no dialog:

- a **New plan** form: an agent selector, an optional project selector, an `adoptUnmanaged`
  checkbox, and two submit buttons — Import plan and Render plan. The agent selector needs a list,
  so `GET /api/v1/agents` joins the config scope as a fourth read, loaded like the other three
  while `#/config` is open. `previewOverrides` is accepted by the request schema and is not
  surfaced: it is a free-form JSON object with no bounded set of keys to offer, and nothing here
  needs it.
- **Create rollback plan** on each snapshot row, which produces a `prepared` plan the same way. A
  rollback therefore cannot skip diff review either.
- **Rescan** on the drift panel, a single click, because it writes drift records and never the
  developer's files.

Apply is the only gate. A plan row in state `prepared` offers Apply. Pressing it opens a dialog
that states the agent, the plan kind, every target path with its operation, the number of warnings,
and the sentence that applying writes the developer's own agent configuration files. Confirming
runs `applyPlanWithApproval`.

The dialog is `role="dialog"` with `aria-modal="true"`, labelled by its heading, closes on Escape,
traps focus while open, and returns focus to the button that opened it.

While any mutation is in flight its control is disabled and the plan row shows a pending state.
Apply is not idempotent, so double submission must be impossible rather than merely unlikely.

On failure the daemon's message renders inline on the row or panel that owns the action. Nothing is
swallowed and no failure is reported as success.

On success the affected panels refresh explicitly. Realtime already invalidates them —
`apps/dashboard/src/main.tsx:435` maps each event through `configResourcesForEvent`, and
`config.applied`, `config.rolled_back` and `config.drift.detected` are all mapped — but that path is
silent while the socket is disconnected, and a write whose result does not appear is worse here
than a redundant read.

### The guard test

`product-independence.test.ts`'s mutation assertion becomes an allowlist rather than a ban. Every
production module except `api/config-mutations.ts` is still forbidden to contain a mutation method
or a mutation path. The assertions that keep optimization accept/reject/evaluate and graph rebuild
out are kept as they are and continue to apply to every module including the new one, because those
remain prohibited. The test's comment is rewritten to say what is now true and why.

## Testing

Section 15 item 13 already requires coverage of invalid origin rejection; this changes that
transition, so it is extended rather than added to.

Daemon:

- `websocket-hub.test.ts` — the validator across method × origin × content-type: GET unchanged in
  every combination; POST with an allowlisted origin passes regardless of media type; POST with an
  unlisted origin fails; POST with no origin passes with `application/json` and with
  `application/json; charset=utf-8`, and fails with `text/plain`, with a form media type, and with
  no header at all; origin `null` still fails.
- `app.test.ts` — a POST rejected through the hook returns 403 `REQUEST_ORIGIN_REJECTED` and never
  reaches its handler, and a GET with no origin still succeeds.

Dashboard:

- `config-mutations.test.ts` — each operation against a stubbed fetch: success, a 409 whose code and
  message survive into the result, a 503 `RUNTIME_NOT_READY`, a transport rejection, and a body that
  fails schema validation. For `applyPlanWithApproval`: the happy path calls approve then apply with
  the returned token; an approve failure never calls apply; an apply failure is returned as such.
- `config-view.test.tsx` — Apply opens the dialog and does not call approve; confirming calls the
  operation once; Escape and cancel close it without calling anything; the control is disabled while
  in flight; a failed mutation renders the daemon's message; an `approved` plan offers no action;
  focus returns to the invoking button.
- `product-independence.test.ts` — the rewritten allowlist, including a case proving a mutation
  planted in another module would still fail the test.

## Not built

`reconcile`, `inspect`, optimization accept/reject/evaluate, graph rebuild, Git mutation, lease
release. No new dependency, no new datastore, no new daemon route, no change to the plan state
machine, and no CORS.

## Known limits

A plan approved by this surface whose apply then fails is dead until its TTL expires. That is
inherent in a one-time token plus a state machine without re-approval, it is bounded at fifteen
minutes, and the repair is to create another plan. This design chooses to make that window as small
as one HTTP round trip rather than to widen the token's lifetime.
