# ADR 0036: Flow roles on the project-agent binding, and dashboard capability mutations

Status: Accepted
Date: 2026-09-17

## Context

Two things were measured before this decision (spec:
`docs/superpowers/specs/2026-09-17-flow-roles-and-skill-management-design.md`).

The project-agent binding already carries a free-text `role` (≤500 chars), persisted in
`<project>/.luwi/agent-bindings.json` and mirrored in Redis, and the pilot fleet uses it as an area
description — `"backend/migrations/infra/CI"`. Nothing rendered it and nothing read it: the external
implement→verify script (`flow.mjs`, ADR 0031/0035 precedent) took its implementer and verifier from
`argv`. The owner's "who does what" map existed on disk and was invisible to the runtime's own
surfaces.

Capability writes — register, update, enable/disable, assign, unassign, scan, profiles — exist on
the daemon and the CLI, and are absent from the dashboard, which `product-independence.test.ts`
holds to an allowlist of write modules. The ADR 0021 plan chain cannot add a skill package: every
plan change is one manifest or settings file. The capability scanner observes the agents' native
`skills` directories read-only. "Skill management" was therefore not a new domain; it was the
existing mutations not reaching the panel that already lists the packages.

The coordinator (ADR 0035) is the one enforced role, because it dispatches and must be single.

## Decision

### Flow roles are configuration on the binding, not a claimed identity

`projectAgentBinding.flowRoles?: Array<'implementer' | 'verifier'>` (unique, at most two), beside
the free-text `role`. It rides on the existing create/patch schemas, the canonical bindings file
and the Redis record without a new key, event type or Function; `project.agent.updated` carries it
in its payload. Every existing file and record stays valid: the field is optional and the record is
validated on read (§14).

- `coordinator` is **not** a member. It is a session-level claim with mutual exclusion; putting it
  beside agent configuration would suggest a binding could hold the dispatcher role, which it
  cannot.
- The daemon enforces **no uniqueness across agents**. A verifier needs no mutual exclusion — two
  bound verifiers are two opinions — and refusing "two verifiers" would be policy the consumer owns.
  The daemon records; `flow.mjs` refuses to dispatch when a role is bound to no agent, to more than
  one, to an agent that is not a configured worker, or when both resolve to the same agent. The
  dashboard shows the ambiguity instead of hiding it.

### The dashboard writes the roles through the project module

The project drawer's "Bound agents" table shows the free-text role and one chip per flow role, and
offers two toggles that `PATCH /api/v1/projects/:projectId/agents/:bindingId` through
`api/project-mutations.ts`. This widens ADR 0033's module from "the project's own fields" to "the
project's configuration the daemon already lets the owner edit"; the local path remains identity
and is still never edited.

### Skill management is a fifth allowlisted write module over existing endpoints

`api/capability-mutations.ts` issues exactly four requests: `PATCH /api/v1/capabilities/:id`
`{ enabled }`, `POST …/:id/assign` and `POST …/:id/unassign` with the daemon's own assignment shape
(`scope: 'project'`, the project, optionally one bound agent, `enabled: true`, empty settings), and
`POST /api/v1/capabilities/scan`. No daemon endpoint was added or changed. The project drawer's
Skills panel gains enable/disable (hidden for an `observed` package, which the daemon refuses to
update because its `SKILL.md` is the truth), assign/unassign to the project or to the selected
agent, and a rescan; every refusal is shown in the daemon's words. Assignment state is read where it
already is — the pair route's effective configuration — so no bindings-list route was added.

`product-independence.test.ts` allowlists exactly five modules and fails if one is missing.

## Consequences

- `flow.mjs` reads the roles from `GET /api/v1/projects/:projectId/agents` when `argv` names none,
  mapping a binding to a configured worker by `agentId`. The pilot's claude worker registers as
  `albanoosh-claude-coder` while the project's binding named `claude-code`; the binding for the
  worker's agent id is the owner's data fix, not a LUWI change.
- The CLI gains nothing: `luwi projects agent update <projectId> <bindingId> --body
'{"flowRoles":["verifier"]}'` already passes the body to the patch schema. `luwi_list_project_agents`
  returns the collection, so the field rides along.
- Declined, and recorded so they are not re-proposed by accident: LUWI writing a `SKILL.md` or any
  file under an agent's native skill directory (the plan chain writes one settings file per adapter
  and stays that way); a `.luwi/roles.md` beside `agent-bindings.json`; daemon-side verifier
  uniqueness; profile editing and capability writes in the MCP server; a flow-role chip on the
  sessions view (it would need the bindings on the pulse snapshot).
