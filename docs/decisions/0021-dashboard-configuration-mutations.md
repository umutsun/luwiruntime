# ADR 0021: Dashboard configuration mutations

Status: Accepted  
Date: 2026-08-10

## Context

Every dashboard phase from 5A to ADR 0020 shipped a read. The daemon serves 48 reads and 41 writes;
the dashboard consumed every read and no write, and `product-independence.test.ts` enforced that
with a blanket ban on `method: 'POST'` in any production module.

On 2026-08-10 the owner approved dashboard mutations. `AGENTS.md` section 21 recorded the mandate
and left three decisions to this phase: whether state-changing requests must require an allowlisted
`Origin`, what a confirmation is, and which mutations the approval covers. This ADR settles all
three and records what was built.

The configuration plan chain was the natural first increment. Its approval-token, snapshot,
precondition-hash and rollback semantics were already implemented and tested; `#/config` already
read three of its collections and could act on none of them. It is also the domain where getting it
wrong costs the most: every one of these operations writes the developer's own agent configuration
files.

## Decision

### The `Origin` check becomes method-aware, and only on POST

`validateLocalHttpRequest` accepted a request with no `Origin` header, which is correct for the CLI
and MCP callers that legitimately have none. It now additionally requires, for a POST that carries
no `Origin`, that the media type be `application/json`.

A browser attaches `Origin` to every request whose method is not GET or HEAD, so a cross-site POST
is already refused by the allowlist. That is the browser's promise rather than the daemon's. A
browser cannot send `application/json` cross-site without a CORS preflight, and the daemon answers
no preflight — there is no `Access-Control-*` header and no `OPTIONS` handler anywhere in it, and
none was added. The dashboard is same-origin with the daemon in production and reaches it through
the Vite proxy in development, so it never needs one. An absent `Origin` combined with a JSON media
type is therefore reachable only from a non-browser client, which already has loopback access.

The check is POST-only, deliberately. `GET` and `HEAD` change nothing. `PUT`, `PATCH` and `DELETE`
are not CORS-safelisted methods, so a cross-site one always preflights and never reaches a handler;
requiring a body's media type on a bodyless `DELETE` would refuse a legitimate CLI call and close no
vector. An earlier draft applied the rule to every state-changing method and was caught by the
Phase 3 integration test doing exactly that.

Requiring an allowlisted `Origin` outright was rejected. It would break the fourteen MCP writes, the
seed script and every `curl`, and the repair would be to have non-browser clients assert a browser
origin they do not have. Leaving the rule unchanged was rejected because `approve`, `drift/scan` and
`rollback-plan` accept an empty body, so the `Origin` header's behaviour was the single barrier in
front of them.

### A confirmation gates apply, and the token never outlives the gesture

`approvePlan` mints a one-time token and returns it once; `applyPlan` requires it. The plan state
machine allows `approved → applying | expired | superseded` and **not** `approved → approved`. A
client that loses the token cannot ask for another: the plan is dead until its fifteen-minute TTL
expires it.

Separate Approve and Apply buttons would therefore have turned an ordinary page reload into a
discarded plan. Instead the dashboard never presents an `approved` plan as actionable and never
holds a token across a user interaction. The two deliberate acts are pressing Apply on a plan whose
diff is on screen, and confirming a dialog that re-lists the exact target paths. The client then
calls `approve` and `apply` back to back inside one function, with the token in a local variable
that is never written to component state, `localStorage`, `sessionStorage`, the URL or a log.

The daemon does not hold the token either, so `apply` still requires possession of what `approve`
returned. Amending the state machine to permit re-approval was rejected as out of scope: it touches
control-plane policy and weakens a one-time approval.

### The scope is the plan chain, minus `reconcile`

In: `import-plan`, `render-plan`, `approve`, `apply`, `snapshots/:snapshotId/rollback-plan`,
`drift/scan`. Plan creation is included because nothing else on this machine creates plans — the MCP
server never exposes control-plane writes and there is no CLI for them — so an approve button would
have had nothing to act on.

Out, and untouched: `reconcile`, a bulk recovery pass over every ambiguous operation receipt that
offers the caller no selection; `inspect`, which has no consumer here; and optimization
accept/reject/evaluate, graph rebuild, Git mutation and lease release, each of which carries its own
prohibition that section 21's approval explicitly does not carry in.

### One module may write, and the guard says so

`apps/dashboard/src/api/config-mutations.ts` is the only production module in the dashboard
permitted to issue a state-changing request. It builds its own request function rather than
extending `createDaemonClient`, so the read client every scope loader receives stays incapable of
writing.

`product-independence.test.ts` was narrowed rather than deleted: every module except that one is
still forbidden a mutation method or path, the test fails if the allowlisted module is absent so it
cannot pass vacuously, and a second test forbids the prohibited operations everywhere including
inside the allowlisted module.

### The public error schema moves to a leaf module

The dashboard validates a daemon error body rather than trusting its shape, which needs
`publicErrorResponseSchema` in the browser bundle. It lived in `runtime-api.ts`, which imports
`realtime.ts`, which imports `runtime-event.ts`, which imports `node:crypto`. Re-exporting it
through `browser.ts` from there would have pulled a Node builtin into the browser bundle.

It now lives in `packages/protocol/src/public-error.ts`, importing nothing but `zod`.
`runtime-api.ts` re-exports it so existing consumers are unchanged. This is the same remedy, for the
same hazard, that `stream-id.ts` already documents.

## Consequences

A plan this surface approves whose apply then fails is dead until its TTL expires. That is inherent
in a one-time token plus a state machine without re-approval; it is bounded at fifteen minutes and
repaired by creating another plan. The design makes the window one HTTP round trip rather than
widening the token's lifetime, but it does not remove it.

An `Origin`-less POST that sends no `content-type` is now refused. Every real caller in this
repository already sends one — the MCP daemon client on every POST, and the seed script on every
call, because it passes `{}` rather than nothing for bodyless operations. Four test files were
injecting bodyless POSTs and were corrected to model that; a future caller that does not send the
header will get a 403 whose message names the origin check rather than the media type, which is the
one place this decision is harder to debug than it looks.

The dashboard is no longer read-only, and the sentence "the dashboard calls no mutation endpoint"
is no longer true anywhere it appears. `#/config` gained a fourth read, `GET /api/v1/agents`, to
populate the plan form's picker; that is an existing route, not a new one.

Realtime already invalidates the chain, so a successful mutation would usually refresh on its own.
The view refreshes explicitly as well, because that path is silent while the socket is disconnected
and a write whose result never appears is worse here than a redundant read.

Nothing in this ADR makes the runtime able to undo a bad configuration write beyond what the
snapshot chain already offered. A rollback is still a plan that must itself pass the apply gate,
which is deliberate: the undo cannot skip the diff review the forward change needed.

No CORS header, no `OPTIONS` handler, no new daemon route, no new dependency, no new datastore, and
no change to the plan state machine.
