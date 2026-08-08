# ADR 0011: Local Git observation and attribution

Status: Accepted  
Date: 2026-07-30

## Context

Git and the local filesystem are canonical for project code. LUWI needs local activity and
code relationships without GitHub access, repository mutation, or claiming that a Git author
is a coding agent.

## Decision

The daemon runs bounded read-only Git commands using argument arrays, `shell: false`,
`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, output limits, and timeouts.

The allowlist consists of exact read-only argument templates for:

```text
rev-parse
symbolic-ref
status
branch
tag
worktree
log
show
diff-tree
config
rev-list
ls-files
```

Each command is accepted only with its expected flags and bounded arguments; the top-level
verb is not an authorization boundary. No fetch, checkout, reset, clean, commit, merge,
rebase, push, branch/tag/worktree creation or deletion, config write, or other
network/mutating command is available to the observer. Credential-bearing remote URLs are
redacted.

Attribution confidence is:

- `exact` for a validated, mutually consistent LUWI commit trailer set or equivalent future
  explicit SHA evidence;
- `correlated` for a unique bounded branch/time/working-directory match;
- `estimated` for explicitly labeled weaker evidence;
- `unknown` when evidence is absent or ambiguous.

LUWI parses but never adds or amends these optional trailers:

```text
Luwi-Agent: {agentId}
Luwi-Session: {sessionId}
Luwi-Project: {projectId}
```

If supplied trailers contradict one another or the registered session relationship, the
attribution is `unknown`, never partially upgraded to exact.

Package and technology inventory reads bounded manifests for Node, Python, Dart/Flutter,
PHP, Rust, and Go without executing package managers or scripts. Git commits relate to
path-derived file IDs and conservative manifest/top-level module boundaries. Source content
and complete diffs are not stored in graph projections.

For Git repositories, inventory file evidence comes from the exact read-only
`ls-files -z --cached -- .` template from the registered project directory. Non-Git projects use an explicitly labeled filesystem
fallback. File-bound truncation is part of the scan response and event.

## Consequences

Local repositories remain authoritative and unmodified by intelligence scans. Exact and
correlated attribution are visibly distinct. Remote hosting analytics, vulnerability
scanning, dependency updates, and lifecycle scoring remain outside Phase 4.
