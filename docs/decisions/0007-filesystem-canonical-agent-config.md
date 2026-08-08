# ADR 0007: Filesystem-canonical agent configuration

- Status: Accepted
- Date: 2026-07-29

## Context

LUWI must manage existing coding-agent configuration without replacing each agent's native
configuration system or making Redis the owner of user-authored files. A Redis-only apply
workflow would lose file ownership, Git review, native formatting, and offline recovery
semantics. Direct writes would risk silently destroying unmanaged developer configuration.

## Decision

The local filesystem and Git are canonical for LUWI manifests and native-agent
configuration. Redis stores validated operational projections, plan states, operation
states, drift reports, indexes, and bounded events; it does not store authoritative native
file blobs.

Canonical LUWI state uses human-readable JSON under `~/.luwi` and project `.luwi`
directories. A validated root manifest tracks project roots, and owned daemon startup
rebuilds missing or stale Redis control-plane projections from canonical manifests before
entering `ready`. Native files are classified as:

- `observed`: inspected but never written;
- `managed-fragment`: only a proven native include or fragment is owned;
- `managed-file`: the whole file was created by LUWI or explicitly adopted by an approved
  plan.

Every native write requires inspection, a deterministic `ConfigPlan`, a redacted
human-readable diff, current-hash preconditions, a one-time approval token, explicit CLI or
HTTP apply authorization, a local snapshot, atomic temporary-file replacement, and an
operation receipt. Existing unmanaged files require `adoptUnmanaged: true` during planning.
Adoption is rejected if the adapter cannot preserve an existing native field. The stored
file artifact must match the approved plan's adapter, exact target-path set, content hashes,
management mode, import settings, and optional rollback snapshot.
Target paths are canonicalized against approved roots after resolving their nearest existing
parent; symlink or junction escape by the target, parent, or allowed root is rejected.

The daemon serializes overlapping target-file operations with both in-process and
filesystem locks. It stages and fsyncs every sibling temporary file before the first target
rename, and journals `prepared`, `snapshotted`, `writing`, and `files_committed` states.
Failure after any rename is not silently compensated; the receipt becomes
`reconciliation_required`. If files commit but the Redis projection fails, the same rule
applies. Owned startup clears generated stale locks and explicit/startup reconcile rebuilds
the projection only when observed hashes match the receipt. Missing, malformed, or
contradictory operation evidence keeps the runtime degraded instead of guessing. A
dedicated canonical managed-target record, rather than an old receipt, defines current
ownership and drift expectations. Drift is reported and never automatically overwritten.
Rollback is itself a new planned, approved, precondition-checked operation; it verifies
snapshot payload hashes before any write and takes a new snapshot of the pre-rollback state.

Import is also a file operation: global import updates the canonical AgentDefinition
manifest, while project import updates agent-specific defaults in the project manifest.
Both use the same approval, precondition, snapshot, journal, and reconciliation protocol as
native rendering.

Adapters declare operation support as `full`, `partial`, `read-only`, or `unsupported`.
Codex and Claude Code have a tested writable subset. Gemini CLI and Kimi remain read-only
where native ownership and rendering behavior are not proven.

Snapshots and operation state remain local with restrictive permissions where supported.
Validated completed snapshots have a configurable count bound (50 by default); incomplete
or foreign snapshot directories are never pruned automatically.
Events, errors, logs, diffs, and snapshot manifests contain hashes and bounded metadata, not
secret values or complete configuration content.

## Consequences

- Files remain inspectable, reviewable, recoverable, and compatible with native tools.
- Redis loss does not erase canonical configuration, and projections can be reconciled.
- Apply is intentionally multi-stage and may require manual resolution after drift.
- The daemon needs filesystem transaction and local journal logic in addition to Redis
  Functions.
- Native write coverage expands only when an adapter's format and ownership semantics are
  proven with fixtures.
