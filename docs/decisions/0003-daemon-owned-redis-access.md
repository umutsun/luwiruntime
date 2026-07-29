# ADR 0003: Daemon-owned Redis access

- Status: Accepted; reinforced by ADRs 0004 and 0005
- Date: 2026-07-28

## Context

Redis is LUWI's operational database and coordination fabric. Giving Redis credentials to
coding agents, CLIs, browsers, Session Bridges, or MCP adapters would let clients bypass
validation, atomic transitions, audit events, retention, and recovery rules.

## Decision

Only the LUWI daemon connects to Redis. The Redis client and all Redis-specific
representations remain inside `@luwi/redis`.

CLIs, future dashboards, Session Bridges, MCP adapters, and coding agents communicate through
versioned daemon HTTP or WebSocket protocols on `127.0.0.1`.

The daemon never returns `REDIS_URL` or Redis credentials. Browser and WebSocket transports
must validate origins and must not enable wildcard CORS.

## Consequences

The daemon is the enforcement point for validation, compatibility, Redis Functions,
retention, structured logging, and safe errors. Clients remain decoupled from key layouts and
can evolve with the versioned protocol.

The daemon must expose honest degraded health when Redis is unavailable. It is also
responsible for ensuring that disposable fan-out happens only after durable persistence.
