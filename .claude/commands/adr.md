---
description: Draft a new architecture decision record in docs/decisions/ following the existing convention.
argument-hint: '<the decision to record>'
allowed-tools: Read, Write, Glob, Grep, Bash
---

Draft an ADR for: $ARGUMENTS

## Before writing

1. `ls docs/decisions/` and take the next free number. ADRs 0001-0011 exist. Do not reuse a number
   and do not leave a gap.
2. Read at least two neighbouring ADRs — `0004-redis-only-local-runtime.md` and
   `0009-event-derived-operational-graph.md` are good models for tone and density.
3. Check whether an existing ADR already covers or contradicts this decision. If it contradicts
   one, say which, and record the new ADR as superseding it rather than quietly diverging.
4. Confirm the decision is actually binding architecture. Implementation preferences do not belong
   here.

## Format

File: `docs/decisions/NNNN-kebab-case-slug.md`

```markdown
# ADR NNNN: Title in sentence case

Status: Proposed
Date: YYYY-MM-DD

## Context

## Decision

## Consequences
```

Section 16 of `AGENTS.md` requires all four of context, decision, consequences, and status.

Convention details that matter, taken from the existing files:

- The `Status:` line ends with two trailing spaces so the `Date:` line renders on its own line.
- `Status: Proposed` for a decision not yet accepted; `Accepted` only once it is.
- Prose wraps near 100 characters. `docs/` is **not** in `.prettierignore`, so run `pnpm format`
  afterwards.
- State what is **not** being done as explicitly as what is. ADR 0009 naming Neo4j, RedisGraph,
  RediSearch, and Redis Stack as unused is the pattern — future readers need the rejected options
  as much as the chosen one.
- Consequences must include the costs and the limits, not just the benefits. If the decision
  bounds historical completeness, degrades under some failure, or defers a problem, say so.

## After writing

Report the path and the number chosen. Do not update `AGENTS.md` section 16's ADR list unless the
user asks — that list and the directory are checked separately.
