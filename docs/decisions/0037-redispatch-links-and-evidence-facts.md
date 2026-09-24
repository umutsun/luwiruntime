# ADR 0037: Re-dispatch links and evidence-backed delivery facts

Status: Accepted
Date: 2026-09-17

## Context

The Delivery tile (Faz 3.2, 2026-09-16) states the answered rate, the p50 latency and the
failed/timed-out share of recent exchanges. Two facts were deferred with the reason written down:
nothing produced them. A re-dispatch — a new message sent because an earlier one ended without a
usable answer — was invisible because nothing linked the two messages (the create response's
`idempotent` flag is a retried request returning the **same** message, which is a different
thing). And whether an answer was backed by a test was invisible because the dashboard's message
read kept only `evidenceCount` while the verify prompt never asked for evidence, although a
response already carries typed `evidence[]` and `luwi_respond_to_message` accepts it unchanged.

Spec: `docs/superpowers/specs/2026-09-17-redispatch-and-evidence-facts-design.md`.

## Decision

### `retryOf` on the message record

`messageCreateRequestSchema` and `agentMessageSchema` gain `retryOf: identifierSchema.optional()`,
the correlation id of the exchange this one re-asks. The daemon reads and decides before the
Function: the referenced exchange must exist (`404 RETRY_OF_NOT_FOUND`), belong to the source's
project (`409 RETRY_OF_PROJECT_MISMATCH`) and be over (`409 RETRY_OF_NOT_TERMINAL`). The link is
then data: `message_request` validates its shape only, `HSET`s it on the message hash it already
declares, carries it in the `message.requested` payload, and `message_projection` returns it. No
new key, index, stream or event type. The request fingerprint includes it **only when present**,
so a re-ask under an old idempotency key with a new link is a different request while a request
without the link hashes exactly as it did before the field existed — the §7 review caught a
`retryOf: null` in the canonical object, which would have turned every idempotent replay that
straddles the deploy into `IDEMPOTENCY_KEY_CONFLICT`; a golden fingerprint test pins the shape. Because a stored record's shape
changed, `luwi_v1` is at **v13** (the registry's own rule); the loader reloads on the mismatch and
a daemon started before it must be restarted once.

Surfaces: `luwi message ask --retry-of <correlationId>` and `luwi_ask_agent` input `retryOf`. The
dashboard's Ask dialog does not gain it — a human re-asking from the UI is not a fleet re-dispatch.

### Evidence types reach the dashboard

`api/messages-scope.ts` keeps `evidenceTypes` (distinct, in the order attached) beside
`evidenceCount`; the `#/messages` detail pane lists them. The Delivery tile's sub-line gains two
facts: `N re-dispatched` (terminal exchanges carrying `retryOf`, `0` stated) and `verified X%`
(answered exchanges with at least one `test_result` or `build_result` item, over answered; `—`
when nothing was answered). Same `Stat` shape, no new class or token, never a score.

### The producer stays outside the daemon

`flow.mjs` (the repository-external implement→verify script) declares the link: a run of a task
whose newest receipt did not end in `verify-pass` carries `--retry-of` with that receipt's
implement correlation id (`redispatch.mjs`, pure, tested), and the receipt records it. Its verify
prompt tells the verifier to attach one `test_result` item per verification command it ran and a
`build_result` when it built. The runtime records what the script declares and the verifier
attaches; it re-dispatches nothing and validates no evidence (§21, and LUWI never runs a test).

## Consequences

- A verifier that attaches nothing reads as unverified; a re-run that the owner starts by hand
  after a failed receipt reads as a re-dispatch. Both are facts the tile can now state instead of
  proxies.
- `luwi_v1` v13 is the third record-shape version this year; the rule that a new Function alone
  does not move it still holds (34 Functions, unchanged).
- Declined: persisting the `idempotent` replay flag (a replay is not a re-dispatch and the create
  response already reports it to the one caller it concerns); automatic re-dispatch; a retry
  control in the dashboard; validating evidence.
