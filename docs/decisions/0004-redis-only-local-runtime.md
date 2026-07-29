# ADR 0004: Redis-only local runtime

- Status: Accepted
- Date: 2026-07-28

## Context

LUWI Runtime is being simplified into a local-first, single-user developer runtime. Its
architecture needs one clear boundary between canonical project/configuration files and
operational state.

Adding multiple databases or an account platform before a demonstrated requirement would
create migrations, synchronization problems, credentials, failure modes, and package
boundaries that the initial product does not need.

## Decision

Redis is the only runtime datastore. It owns every runtime and operational record, including
events, sessions, presence, heartbeats, messages, tasks, leases, current-state projections,
cached metrics, delivery state, and audit history.

Git and the local filesystem remain canonical for source code and configuration, including
project code, LUWI configuration, native agent configuration, skills, hooks, policies,
profiles, and MCP definitions. Redis may contain runtime projections of those definitions,
but those projections are not canonical configuration.

Normalized Runtime events are the durable source for metrics, lifecycle views, project
activity, rankings, and knowledge-graph relations. Those views must be rebuildable
projections.

Local mode has no login, signup, account, OAuth, JWT, RBAC, organization, tenant, or
multi-tenant subsystem. The daemon accepts only `127.0.0.1`.

The initial architecture does not include PostgreSQL, SQLite, Neo4j, another datastore, or a
Redis Stack module.

Optional external storage may be added later only through an adapter, only after a
demonstrated requirement, and only through a separate accepted ADR. It cannot silently
replace Redis as the operational core or Git/filesystem as canonical code and configuration.

## Consequences

The local runtime has one operational consistency boundary and one storage failure domain.
Developers operate standard Redis plus the local daemon rather than a multi-database stack.

Filesystem and Redis projections need explicit synchronization rules. Projection rebuilds
and bounded event retention require tested operational policies.

The absence of an account system makes strict loopback binding, origin validation,
daemon-owned Redis access, and secret-safe logging mandatory rather than optional.
