# Phase 3 design: Agent and Capability Control

- Status: Implemented
- Date: 2026-07-29
- Governing decisions: ADR 0004, 0005, 0006, 0007, and 0008

## Scope

Phase 3 adds a local control plane for agent definitions, project-agent bindings,
capabilities, profiles, effective configuration, native configuration planning, local
snapshots, drift/reconciliation, and static context inventory. It preserves Phase 1
projects/sessions and Phase 2 request/reply/MCP behavior.

The dashboard, authentication, cloud sync, remote package installation, hook/plugin
execution, MCP process supervision, tasks, leases, exact token telemetry, and Smart Context
Optimization remain deferred.

## Boundaries

- `@luwi/protocol` validates control-plane HTTP, event, CLI, and MCP data.
- `@luwi/runtime` resolves inheritance, compatibility, plan state, reconciliation policy,
  secret policy, and generic context estimates.
- `@luwi/redis` owns operational projections, indexes, Function transitions, and events.
- `@luwi/adapters` passively detects and parses native agent configuration and proposes
  deterministic files; it never writes.
- `@luwi/daemon` owns canonical files, approved roots, plans, snapshots, locks, atomic
  replacement, drift, reconciliation, and routes.
- `@luwi/cli` remains an HTTP/WebSocket client.
- `@luwi/mcp-server` adds project-bounded read-only tools and exposes no config apply.

## Canonical layout

```text
~/.luwi/
  manifest.json
  agents/
  capabilities/{skills,plugins,hooks,mcp,policies,profiles,instructions}/
  snapshots/
  operations/
  state/capability-bindings/
  state/managed-targets/

{project}/.luwi/
  manifest.json
  agent-bindings.json
  capabilities/{skills,plugins,hooks,mcp,policies,profiles,instructions}/
  state/capability-bindings/
```

Canonical JSON envelopes contain schema version, stable ID, scope, content hash, and
timestamps. Secrets are rejected from canonical settings. Environment-variable names and
secret reference descriptors are allowed; secret values are not. The global root manifest
tracks registered project roots so owned startup can validate canonical manifests and
rebuild missing or stale Redis control-plane projections before becoming ready. Conflicting
IDs or malformed manifests keep the runtime out of `ready`.

## Adapter support

| Adapter     | Detect/version | Inspect/import | Render/apply       | Context |
| ----------- | -------------- | -------------- | ------------------ | ------- |
| Codex       | full           | full/partial   | tested full subset | full    |
| Claude Code | full           | full/partial   | tested full subset | full    |
| Gemini CLI  | full           | read-only      | read-only          | full    |
| Kimi        | full           | read-only      | read-only          | full    |

Detection invokes only the discovered executable with `--version`. Passive inspection does
not execute the CLI, skills, plugins, hooks, scripts, or MCP servers. Adapter filesystem,
home/project directories, executable resolution, and command running are injected for
tests.

Capability support is explicit as well: Codex reports native plugins and hooks unsupported;
Gemini reports hooks unsupported; Kimi reports plugins, hooks, and policies unsupported.
The remaining normalized capability kinds are read-only in this first adapter subset, and
all four adapters label policy handling `informational-only`. An assigned unsupported kind
makes effective configuration invalid rather than being emulated or silently omitted.
Vendor path/format evidence and the exact writable setting allowlists are recorded in
[`packages/adapters/README.md`](../../packages/adapters/README.md).

## Apply protocol

```text
inspect
  -> compile effective config and provenance
  -> validate adapter support
  -> create redacted ConfigPlan and file-hash preconditions
  -> approve once and return an ephemeral token
  -> explicitly confirm apply
  -> acquire process-local and filesystem target locks
  -> recheck paths and preconditions
  -> snapshot original files
  -> stage and fsync every sibling temporary file
  -> record snapshotted/writing state, then atomically rename
  -> record files_committed state
  -> atomically complete plan + operation projection + Stream event
  -> release locks
```

Existing unmanaged files are refused unless the plan request explicitly sets
`adoptUnmanaged: true`. Approval tokens are stored only as hashes and are invalid after the
plan leaves `approved`. A stored plan artifact is structurally validated and bound to the
approved plan's adapter, exact target-path set, content hashes, management mode, import
settings, and rollback snapshot before any write. Adoption is rejected when an existing
field cannot be preserved by the proven render subset. Rollback creates a separate plan,
verifies every snapshot payload hash before mutating any target, snapshots the current
pre-rollback state, and never bypasses preconditions.

If files commit but Redis cannot record completion, the local receipt is marked
`reconciliation_required`. Startup and explicit reconciliation compare committed hashes
before rebuilding Redis state. A lost Redis Function response is treated as an uncertain
transition, not as a failed apply; recovery checks both the plan and operation projection.
Missing, malformed, or contradictory receipts keep the daemon degraded for human review.
Managed-target ownership is stored separately from historical operation receipts so stale
receipts cannot create false drift. Drift creates or resolves a current report but never
writes a file.
If a multi-file operation stops after its first rename, LUWI deliberately leaves the
filesystem as canonical and requires reconciliation instead of guessing a rollback. Owned
startup clears only generated stale lock files before inspecting receipts. Completed
snapshots are locally bounded by `LUWI_CONFIG_SNAPSHOT_RETENTION_COUNT` (default 50).

Import uses the same approval, precondition, snapshot, journal, and atomic file engine as
render. A global import updates the exact canonical AgentDefinition manifest and supplies
precedence layer 2 defaults. A project import updates that agent's defaults in the project
`.luwi/manifest.json` and supplies precedence layer 5 defaults.

## Redis model

The Function library version is 4. Phase 3 adds generic atomic control-plane
create/update/delete transitions plus atomic plan transition and plan/operation completion.
The latter writes one normalized success event, avoiding duplicate `config.applied` or
`config.rolled_back` events.

Redis contains only validated projections and bounded metadata. Complete native files,
complete diffs, approval tokens, secrets, and instruction documents remain outside Redis.
The existing global/project Streams and consumer-group WebSocket relay are reused.

## Context estimates

Adapters inventory instruction sources, and the daemon inventories assigned skill, plugin,
hook, MCP, policy, and instruction manifests plus whitelisted static files under their
canonical package roots. It records canonical paths, byte/line counts, SHA-256, scope,
loading mode, and management mode. Source IDs are stable for an agent/project/path identity;
editing content changes its hash rather than creating a second projection. Estimates are
deterministic:

```text
estimatedTokens = ceil(UTF-8 bytes / 4)
source = "estimated"
method = "generic-character-estimate"
```

Only exact duplicate hashes and structural issues are reported. These values are not model
telemetry, billing data, semantic duplicate analysis, or automatic optimization.

## Security and recovery

The daemon remains loopback-only with exact origin validation and daemon-owned Redis access.
Every target is checked against the AgentDefinition's explicit `nativeConfigRoots` or the
canonical LUWI manifest roots. Canonicalization rejects a target, parent, or allowed root
that resolves through a symlink/junction outside its approved boundary. The test and demo
paths use explicit temporary LUWI/native homes. No adapter test reads the developer's real
configuration.
