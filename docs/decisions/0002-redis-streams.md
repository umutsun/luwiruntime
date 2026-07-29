# ADR 0002: Redis Streams for durable coordination events

- Status: Accepted; extended by ADR 0005
- Date: 2026-07-28

## Context

LUWI needs ordered operational events and delivery records that survive daemon or client
disconnects. Disposable Pub/Sub notifications cannot provide replay, pending-delivery
inspection, recovery, or durable audit history.

Unbounded Streams would eventually consume unlimited local storage.

## Decision

Phase 1 uses Redis Streams for:

- global and project Runtime events;
- a bounded dead-letter diagnostic stream.

Use consumer groups, explicit acknowledgements, pending-entry inspection, and `XAUTOCLAIM`
for recoverable processing. Consumers acknowledge only after successful processing and are
idempotent because delivery is at least once.

Transition Functions do not trim. A periodic service applies configurable approximate
retention only when compatible with pending recovery, as specified by ADR 0005.

Pub/Sub may be used only after durable persistence for disposable fan-out and invalidation.
Phase 1 does not use Pub/Sub.

Session inbox/outbox, task delivery, and message audit Streams are deferred until their
features are implemented.

## Consequences

Consumers can replay retained history, resume after disconnects, inspect pending work, and
recover abandoned deliveries. Retention prevents unbounded growth but requires policies that
do not trim still-required pending entries.

Stream payloads and consumer recovery paths require runtime validation and integration
tests. Metrics, lifecycle views, rankings, and graph relations are projections of these
normalized events.
