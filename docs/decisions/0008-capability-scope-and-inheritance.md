# ADR 0008: Capability scope and inheritance

- Status: Accepted
- Date: 2026-07-29

## Context

Developers need reusable skills, plugins, hooks, MCP definitions, policies, instructions,
and profiles across projects while preserving explicit project and agent choices. Native
agents do not share identical capability models, and filesystem enumeration order must not
change effective behavior.

## Decision

`AgentDefinition` is a stable logical registry entry and remains separate from both runtime
sessions and `ProjectAgentBinding`. Existing opaque session `agentId` values remain valid
without a definition. Disabling a definition or unbinding a project never rewrites
historical sessions or events.

Capabilities have stable IDs, a kind, global or project scope, checksum, compatibility,
dependency declarations, and enabled state. Profiles are named collections of capability
IDs, policy IDs, disable overrides, and adapter settings. Project-agent bindings select
profiles and project capability bindings and provide final persistent project-agent
overrides.

Effective configuration uses this deterministic precedence:

1. runtime defaults;
2. AgentDefinition defaults;
3. assigned global profiles;
4. global capability bindings;
5. project manifest defaults;
6. assigned project profiles;
7. selected project capability bindings;
8. project-agent overrides;
9. preview-only overrides.

Layers and IDs are sorted deterministically. Settings use recursive object merge; scalar and
array values are replaced by the higher-precedence layer. Capabilities merge by stable ID.
An explicit disabled assignment is a tombstone and suppresses lower-precedence enablement.
A disabled capability package cannot be assigned or satisfy a dependency. Project-scoped
packages and bindings must carry the owning project ID and cannot be used by another
project; global scope forbids a project ID. Dependency resolution is order-independent.
Version conflicts, missing dependencies, unknown profiles, and incompatible agent kinds are
reported; they are never silently resolved. Invalid effective configuration remains
inspectable but cannot produce an apply plan.

Every effective setting and capability decision includes provenance: source scope, optional
source ID/file, precedence, and override reason. The effective result also exposes each
capability kind's native adapter support and policy mode, including `read-only`,
`informational-only`, and `unsupported`, so passive awareness is not confused with native
write support.

Session-level persisted overrides are deferred. Phase 3 supports explicit preview-only
overrides that are not written into session history.

## Consequences

- The same catalog can produce reproducible agent-specific project configuration.
- Global reuse does not remove project control.
- Disable tombstones and provenance make overrides explainable.
- Capability compatibility is explicit rather than emulated across agents.
- Session history remains stable if later AgentDefinition records are introduced or changed.
