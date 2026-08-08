# Product-Independent Core

Status: Accepted

Date: 2026-08-05

## Context

LUWI coordinates local projects and generic agent sessions. Optional products and protocols
may disappear, change ownership, or become unavailable. The runtime must not depend on one
of them to start or preserve its operational model.

## Decision

Accepted:

- Redis is the operational datastore, durable event bus, and coordination fabric.
- Filesystem and Git are canonical configuration and source truth.
- A future local SQLite use requires an independent accepted ADR and must not duplicate
  Redis operational projections.
- Product and protocol integrations are optional adapters over the validated daemon API.
- Dashboard and core runtime remain agent-, provider-, product-, and protocol-independent.

Rejected:

- a core dependency on Goose, ACP, or any coding-agent vendor;
- direct adapter-to-Redis writes;
- vendor-specific event types in core domains;
- product-specific assumptions in generic session state;
- required external cloud services;
- making any one agent product mandatory.

The required boundary is:

```text
External agent or protocol
  -> optional adapter
  -> validated LUWI daemon API
  -> Redis Functions, Streams, and projections
```

The removal of any optional adapter must not prevent LUWI Runtime from starting, observing
native sessions, serving Pulse, or operating its Redis-native core.

## Consequences

Adapters receive no Redis credentials and cannot bypass daemon validation. Generic UI logic
may display product names supplied by runtime data but cannot branch on those names. New
storage, protocol, or vendor dependencies require separate evidence and architecture review.
