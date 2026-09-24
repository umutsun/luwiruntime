# Re-dispatch links and evidence-backed delivery facts — design

**Status:** implemented, 2026-09-17 (ADR 0037). The two facts Faz 3.2 deferred "because nothing
produces them", with their producers.
**Scope:** one optional field on the message (`retryOf`), evidence types kept in the dashboard's
message read, two facts on the Delivery tile, the flow script as the producer of both, and
`luwi_v1` moving to **v13** because a stored record's shape changes.

## Why

The Delivery tile (Faz 3.2) states answered rate, p50 latency and the failed/timed-out share. Two
facts were left out and the spec said why:

- **Re-dispatch.** The failed share was called "the honest proxy for re-dispatch" because nothing
  links a second ask to the first. The create response's `idempotent` flag is not that link: an
  idempotent replay (same `Idempotency-Key`, same fingerprint) returns the **same** message, so it
  is a retried request, not a re-dispatched task. A re-dispatch is a **new** message sent because a
  previous one ended without a usable answer — and today the two messages are strangers.
- **Test result.** A response already carries `evidence[]` with typed items (`test_result`,
  `build_result`, …); `luwi_respond_to_message` accepts them unchanged. But the dashboard's message
  read keeps only `evidenceCount`, and the verify prompt in `flow.mjs` never asks for evidence, so
  the runtime could not tell a verified answer from a bare "PASS".

Both are facts the runtime can record without judging them. Neither becomes a score.

## A. `retryOf` on the message

- **Protocol:** `messageCreateRequestSchema` and `agentMessageSchema` gain
  `retryOf: identifierSchema.optional()` — the correlation id of the message this one re-asks.
- **Daemon (read/decide before the Function):** when present, the service reads the referenced
  message; a missing one is `404 RETRY_OF_NOT_FOUND`, one in another project is
  `409 RETRY_OF_PROJECT_MISMATCH`, one that is not terminal is `409 RETRY_OF_NOT_TERMINAL` (you
  do not re-dispatch what is still running). The link is then passed as data; the Function
  validates its shape only, like `selectionReason`.
- **Redis:** `message_request` HSETs `retryOf` when present and `message_projection` returns it;
  the `message.requested` event payload carries it so the ticker can say "re-asked". No new key,
  index or stream. A stored record's shape changes, so per the registry's rule `luwi_v1` moves to
  **v13**; the loader reloads on the version mismatch and a daemon started before it must be
  restarted once. The idempotency fingerprint includes `retryOf` (a re-ask under an old key with a
  new link is a different request).
- **Surfaces:** `luwi message ask --retry-of <correlationId>`; `luwi_ask_agent` input `retryOf`.
  The dashboard's Ask dialog does not gain it (a human re-asking from the UI is not a fleet
  re-dispatch).

## B. Evidence types on the dashboard

- `api/messages-scope.ts`: `MessageResponseSummary` gains `evidenceTypes: string[]` (deduplicated,
  in the order attached) beside `evidenceCount`; the `#/messages` detail pane lists them.
- `overview/model.ts` `deliveryQualityOf`: the tile's sub-line gains two facts —
  `N re-dispatched` (terminal messages carrying `retryOf`, always stated, `0` included) and
  `verified X%` (answered responses with at least one `test_result` or `build_result` item, over
  answered). Same `Stat` shape, no new class or token. Never a score, never "quality".

## C. The producer: `flow.mjs`

- **Re-dispatch:** before the implement ask, the script looks for the newest
  `flow-receipt-*.json` with the same `task` whose `outcome` is not `verify-pass`; when one exists
  the implement ask carries `--retry-of <its implement correlationId>` and the receipt records
  `retryOf`. A pure helper (`redispatch.mjs`, node:test) picks the receipt; the script only wires
  it. No automatic re-run — the owner still starts the flow (§21).
- **Evidence:** the verify prompt tells the verifier to attach, through
  `luwi_respond_to_message`, one `test_result` item per verification command it ran (the command
  in `reference`, the outcome in `summary`) and a `build_result` when it built. A verifier that
  attaches nothing reads as unverified — which is the point of the fact.

## Tests

- Protocol: `retryOf` optional on request and record; refused when blank.
- Redis: `function-registry.test.ts` (v13, 34 functions); `message-request.integration.test.ts`
  (stored and projected when present, absent otherwise; fingerprint differs with it).
- Daemon: `message-service.test.ts` (the three refusals; passthrough on a terminal same-project
  message; event payload carries it). CLI and MCP option tests.
- Dashboard: `messages-scope.test.ts` (`evidenceTypes`), `overview/model.test.ts` (the two facts
  with fixture messages, including `0 re-dispatched` and `verified 0%`).
- Repo-external: `redispatch.test.mjs` (newest matching receipt, pass ignored, none → no link).

## Out of scope

Automatic re-dispatch or any daemon-side retry (§21). Validating evidence (LUWI never runs a
test). A retry control in the dashboard. Persisting the `idempotent` replay flag — a replay is not
a re-dispatch, and the create response already reports it to the one caller it concerns.
