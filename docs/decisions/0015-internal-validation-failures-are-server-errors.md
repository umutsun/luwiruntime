# ADR 0015: Internal validation failures are server errors

Status: Accepted  
Date: 2026-08-09

## Context

The daemon's single Fastify error handler maps every `ZodError` to
`400 REQUEST_VALIDATION_FAILED`. Routes parse their inputs and their outputs with the same
mechanism — a bare `schema.parse(...)` — so the handler cannot tell a malformed request from a
malformed response, and it blames the client for both. The same is true of validation on read from
Redis, which section 14 requires: a corrupted projection surfaces as a `ZodError` deep in a
repository and reaches the client as a request error.

The effect was observed live while building ADR 0013: a summary whose own output contradicted its
schema returned `400 REQUEST_VALIDATION_FAILED` to a `GET` request with no body at all. A phase-4
test documented the behaviour at the time rather than fixing it, because the mapping is daemon-wide
— roughly 190 parse sites across 80+ routes — and changing it deserved its own record.

The error taxonomy already distinguishes these cases everywhere else. `ApplicationError` carries a
code and status per failure, and `toPublicError` maps anything unrecognized to a fixed, non-leaking
`500 INTERNAL_ERROR` body. The defect is confined to the early `instanceof ZodError` branch that
intercepts every Zod failure before that taxonomy can classify it.

## Decision

Parsing request input becomes the only source of `400 REQUEST_VALIDATION_FAILED`. Routes parse
`request.body`, `request.params`, `request.query`, and request headers through one helper that
converts a `ZodError` into `ApplicationError('REQUEST_VALIDATION_FAILED', …, 400)`, preserving the
original error as `cause` so local logs keep the field-level detail that section 4 keeps out of
responses.

The blanket `ZodError` branch in the error handler is removed. A bare `ZodError` that still reaches
the handler is by construction an internal invariant violation — response validation, store-read
validation, or any other internal parse — and falls through to `toPublicError`, which already
returns the fixed `500 INTERNAL_ERROR` body without stack traces or connection details.

What is explicitly not done:

- **No new public error code.** `RESPONSE_VALIDATION_FAILED` was rejected because bare `ZodError`s
  also arise from reads of untrusted Redis state, and naming them all "response" would misdescribe
  them. `INTERNAL_ERROR` already means "the server violated its own contract" and adds no surface.
- **No migration to Fastify schema validation.** Replacing inline Zod parsing with route-config
  validators or a type provider would rebuild the validation mechanism of every route to fix what
  is a classification defect in one handler.
- **Response validation stays.** Output parsing is load-bearing beyond validation: it strips
  unknown keys from responses. Removing it to avoid internal `ZodError`s would trade a correct
  status code for a wider response surface.

The failure direction this chooses: a future route that parses input without the helper turns a
malformed request into a `500` — the wrong status, but it blames the server and leaks nothing. The
previous default turned server-side corruption into client blame, which is the direction worth
engineering away from.

## Consequences

A `400` from the daemon now reliably means the request was at fault, across every route, for every
client — dashboard, CLI, and MCP tools all branch on `error.code` and keep their semantics for
genuinely malformed requests. Server-side contract violations, including corrupted Redis
projections, surface as `500 INTERNAL_ERROR` and in local logs with full detail, where they are an
operator signal instead of a silently misfiled client error.

The helper is a convention, not a type-system guarantee. Nothing stops a new parse site from
bypassing it; the cost of that mistake is a misclassified status, not a leak, and a lint rule
restricting `.parse(request.` can be added if the mistake recurs rather than in advance.

Deployments that relied on the old behaviour — treating a `400` on a bodyless `GET` as "the
server's own output failed validation" — lose that (accidental) signal. The phase-4 test that
documented the old mapping is updated to assert the new one, so the contract lives in the test
suite rather than in a comment explaining a defect.
