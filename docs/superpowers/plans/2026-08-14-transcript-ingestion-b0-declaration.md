# Transcript ingestion — declaration surface (B0) — implementation plan

> **For agentic workers:** this plan is executed inline in the session that adopts it. Steps use
> checkbox (`- [ ]`) syntax for tracking. **There are no commit steps** — per `AGENTS.md` §13 the
> owner commits only when they explicitly ask.

**Goal:** Give an already-registered, live session a way to declare its native identity, so that a
`NativeSessionBinding` and an open `NativeSessionLink` exist at all. Today there are **zero bindings
in either database** against nine sessions, so every transcript record falls outside every interval
and a reader built first would attribute nothing.

**Architecture:** A new daemon route accepts the same `native` block `POST /api/v1/sessions` already
takes and routes it into the **unchanged** `evaluateNativeDeclaration`. A new Redis Function
`native_declare` applies the outcome under A1's compare-and-set contract. No new policy is written —
`evaluateNativeDeclaration`'s `unchanged` outcome was designed for this surface and finally has a
caller.

**Tech Stack:** TypeScript strict ESM, Zod, Redis Functions (Lua 5.1 under Redis 7), Vitest.

## Global constraints

From `docs/superpowers/specs/2026-08-14-native-transcript-ingestion-design.md` §2, ADR 0023, ADR 0022
and `AGENTS.md`. Every task inherits these.

- **`evaluateNativeDeclaration` is not modified.** Its six outcomes, its refusal of a live holder, its
  conflict that writes nothing, and `NATIVE_BINDING_INCONSISTENT` all carry over untouched. If this
  work seems to need a policy change, the design is wrong.
- **A live holder is reported, never evicted.** Completing another client's session would be a lie.
- **A conflict writes nothing** and creates nothing.
- Lua **validates, it does not decide**: a CAS on the monotonic `version`, and it derives no key name
  (§7). Every key arrives **paired with the identity it must hold** — the lesson from A1's two
  boundary defects.
- A caller may declare **only for its own bound session**, never an arbitrary session id — the same
  principle that makes the MCP lease tools take the holder from the bound session and never from
  input.
- The session must be **live and non-terminal**; a declaration for a `completed` or `disconnected`
  session is refused.
- **No conversation content** is stored or logged anywhere in this increment (§4).
- `@luwi/protocol` and `@luwi/runtime` must never import `redis`; `@luwi/mcp-server` must never
  import `@luwi/redis`.

## Determinations the spec leaves open

### D1 — No `XGROUP CREATE` ordering constraint

A1 had to validate **before** `XGROUP CREATE` so a refused declaration left no inbox stream. Here the
session already exists and its inbox stream with it, so there is nothing to order against and no
cleanup to avoid. The Function is a straight validate-then-apply.

### D2 — The Function library version

A new Function forces a reload without a version bump: `isCompatible` hashes the source and compares
the function-name list. Follow A2's precedent and **leave the declared version at 11** unless the
record shape changes, and record the reasoning in the registry.

### D3 — Declaring twice is `unchanged`, not an error

A client that re-declares the same native identity for the same session gets `unchanged` and a 200.
Re-declaration is the expected steady state for anything that declares on a timer or at startup, and
making it an error would push callers into remembering whether they had declared.

## File structure

```
packages/protocol/src/native-session.ts     the declaration request/response shapes
packages/runtime/src/                       no change — policy is reused as-is
packages/redis/src/function-library.ts      native_declare
packages/redis/src/function-registry.ts     registration + the D2 note
packages/redis/src/runtime-repository.ts    the repository call
packages/redis/src/native-session.integration.test.ts
apps/daemon/src/session-service.ts          the service method
apps/daemon/src/app.ts                      the route
```

## Task 1: The protocol shapes

- [x] Add the declaration request shape, reusing the existing `nativeSessionRefSchema` rather than
      restating it.
- [x] Add the response shape carrying the outcome, the binding and the link.
- [x] Tests: a valid declaration parses; an unknown key is rejected (strict object); the outcome enum
      matches `evaluateNativeDeclaration`'s six results exactly, asserted against the runtime type so
      the two cannot drift.

## Task 2: The `native_declare` Redis Function

- [x] Write `native_declare` taking the binding hash, the links zset, the link hash, the session
      reverse index and the session hash — each declared with the identity it must hold.
- [x] CAS on the binding's monotonic `version`; on mismatch return a version conflict and **write
      nothing**.
- [x] Refuse when the declared session is terminal, when a live holder exists, and when any declared
      key does not hold the declared identity.
- [x] Increment `version` exactly once on success.
- [x] Register it and record the D2 reasoning next to the version.

## Task 3: Repository and service

- [x] Add the repository call that reads current state, runs `evaluateNativeDeclaration`, and applies
      the result through `native_declare`.
- [x] Bound contention at 3 attempts and surface `409 NATIVE_BINDING_CONTENDED`, matching A1's caller
      paths.
- [x] Emit `session.native.linked` on a new link, and nothing at all on `unchanged` — an event that
      records no change would be noise in the Activity feed.

## Task 4: The route

- [x] Add the declaration route under the session's own path.
- [x] Reject a declaration naming a session other than the caller's bound one.
- [x] Map every outcome to its status: created/linked/unchanged → 200, conflict → 409, inconsistent →
      `NATIVE_BINDING_INCONSISTENT`, contended → 409.
- [x] Per ADR 0021's rule, an `Origin`-less POST must carry `content-type: application/json`; the
      route's tests must pass a body so Fastify's `inject` sets it.

## Task 5: Integration coverage

- [x] Redis integration test: a refused declaration leaves **no** partial write — no binding, no link,
      no reverse index.
- [x] A live holder is reported and the holding session stays untouched and non-terminal.
- [x] A second declaration of the same identity returns `unchanged` and does not increment `version`
      a second time, per D3.
- [x] Run through `/redis-it`, never against `db0`.

## Task 6: Make something declare

- [x] `luwi session simulate` and `luwi session register` gain an optional native reference, so the
      fixture can produce a binding at all.
- [x] `scripts/seed-runtime.ts` declares for at least one seeded session, so `#/sessions` shows a
      bound one and B1 has an interval to attribute into.

## Task 7: Documentation

- [x] `README.md`, `AGENTS.md` §21 — B0 built; B1 and B2 specified and not started;
      `usage.sessionId` still unattributed.
- [x] `CLAUDE.md` — add the commit to the repository-state table when the owner commits.

## Task 8: Full verification

- [x] `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- [x] `/redis-it` for the integration leg.
- [x] Report honestly per §19: `usage.sessionId` remains unattributed until B1.

## Regression coverage map

| Risk                                                   | Covered by                          |
| ------------------------------------------------------ | ----------------------------------- |
| A refusal leaving a partial binding                    | Task 5 integration test             |
| A declaration evicting a live holder                   | Task 5 live-holder test             |
| Declaring for someone else's session                   | Task 4 bound-session test           |
| Policy quietly forked from `evaluateNativeDeclaration` | Task 1 outcome-enum-vs-runtime test |
| Re-declaration treated as an error or double-counted   | D3, Task 5                          |
| The fixture still producing zero bindings              | Task 6                              |
