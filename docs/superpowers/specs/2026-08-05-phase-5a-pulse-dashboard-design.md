# Phase 5A Pulse Dashboard Design

Phase 5A implements the first production, read-only LUWI Pulse slice. The binding product
specification is the user-approved Phase 5 mission, with detailed audit, capability, and
architecture decisions in:

- `docs/phase5-dashboard-mockup-audit.md`;
- `docs/phase5-dashboard-capability-matrix.md`;
- `docs/phase5-dashboard-architecture.md`.

The slice includes a production application shell, typed same-origin daemon client, a
bounded REST Pulse snapshot, connection-state presentation, and explicit loading, empty,
partial, degraded, and unavailable states. It preserves the graphite, dense, text-first
mockup character without copying generated code or static data.

Phase 5A does not apply WebSocket events, inspect sessions, render a graph, score releases,
create leases, search globally, integrate GitHub or ACP, or perform any mutation. Future
destinations may appear only as disabled, labelled development routes.

Success requires focused dashboard and daemon tests plus the repository format, typecheck,
lint, unit, integration, build, and `git diff --check` gates. No commit, tag, stage, or push
is authorized.
