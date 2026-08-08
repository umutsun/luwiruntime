# ADR 0010: Human-approved context optimization feedback loop

Status: Accepted  
Date: 2026-07-30

## Context

Static instruction and capability context can become large or duplicated, but assignment
does not prove loading and lack of observed invocation does not prove non-use. A safe
optimization feature must keep measurement provenance and reuse Phase 3 filesystem
protections.

## Decision

Phase 4 implements:

```text
observe -> measure -> recommend -> accept -> Phase 3 plan/approve/apply -> observe -> evaluate
```

- Exact, reported, adapter-extracted, estimated, and unavailable usage remain separate.
  Missing values stay absent and are never converted to zero.
- Static context estimates remain `generic-character-estimate`; reported observations are
  stored alongside them.
- Assigned, effective, loaded, and invoked are distinct facts. Unknown is not treated as
  unused.
- Findings are deterministic structural rules with evidence windows and confidence.
- Proposals never contain LLM-rewritten instruction prose.
- Acceptance changes no file. A supported deterministic action creates a Phase 3
  `ConfigPlan`; one-time approval, preconditions, snapshot, apply, rollback, drift, and
  reconciliation remain mandatory.
- Each proposal stores an immutable pre-change configuration/context/session/usage/Git
  baseline. A successful Phase 3 apply records the proposal apply timestamp.
- Post-change evaluation counts only explicit session/adapter observations and usage records
  recorded after apply; static contributions are not retimestamped into evidence.
- Apply is never automatic and is not exposed through MCP.
- Evaluation is `verified`, `inconclusive`, or `failed` and always has
  `causalClaim: false`. It may report an observed footprint change but cannot claim improved
  model or code quality.

## Prior art considered

`rebelytics/one-skill-to-rule-them-all` (the "task-observer" meta-skill) implements the same
loop shape — observe a working session, detect corrections and repeated manual work, propose
improvements, require human approval, then apply. Its existence is useful confirmation that the
observe/propose/approve cycle is the right structure for this problem.

Its mechanism is the opposite of the decision above, and the contrast is the reason to record it.
Task-observer derives its findings from model judgement about a session transcript, and its
approved output is rewritten instruction prose. This design derives findings from deterministic
structural rules over recorded evidence, keeps assigned, effective, loaded, and invoked as
distinct facts, and forbids any Phase 4 path from writing instruction prose. Where task-observer
produces a plausible suggestion, this loop produces an evidence-bounded finding that can be
inconclusive.

The tradeoff is accepted deliberately: judgement-derived observations would surface improvements
this loop cannot see, but they cannot carry provenance, cannot be re-derived from retained
observations, and cannot support `causalClaim: false` honestly.

## Consequences

LUWI can close a measurable configuration loop without becoming an autonomous prompt
rewriter. Sparse evidence produces an inconclusive result rather than a fabricated claim.
Users retain the same review and recovery guarantees as every Phase 3 configuration change.
