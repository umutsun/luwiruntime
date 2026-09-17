# Flow roles and skill management (F5) — design

**Status:** implemented, 2026-09-17 (ADR 0036). Owner decisions taken before this spec: the verifier /
implementer role lives on the project-agent binding as an enum field (not a convention on the
free-text `role`, not a separate `.luwi/roles.md`); skill management reaches the dashboard through
the **existing** capability endpoints as a fifth allowlisted write module; LUWI never writes a
`SKILL.md` or any file under an agent's native skill directory.
**Scope:** one protocol field, one dashboard write module, two dashboard panels, one ADR (0036), and
the repo-external `flow.mjs` reading the roles instead of `argv` defaults.

## Why

Two facts measured before writing this:

- `projectAgentBinding.role` already exists (free text, ≤500 chars) and the pilot uses it as an
  area description — `"backend/migrations/infra/CI"`, `"planning/contracts/architecture/review"`.
  It is written by `luwi projects agent bind|update`, persisted in `<project>/.luwi/agent-bindings.json`
  (canonical, hash-checked on load) and mirrored in Redis. **Nothing shows it** (the drawer's "Bound
  agents" table has no role column) and **nothing reads it**: `flow.mjs` takes
  `implementer=claude verifier=codex` from `argv`. The "who does what" map exists on disk and is
  invisible.
- Capability writes exist and are exposed over HTTP and the CLI (`register/update/assign/unassign/
enable/disable`, `profile create/update`, `scan`), and are absent from the dashboard (read-only by
  `product-independence.test.ts`) and the MCP server. The ADR 0021 plan chain cannot add a skill
  package — every plan change is one manifest or settings file — and the scanner observes native
  `.claude|.codex|.gemini/skills` directories read-only. So "skill management" is not a new domain:
  it is the four existing mutations reaching the panel that already lists the packages.

The coordinator (ADR 0035) stays the only **enforced** role: it needs mutual exclusion because it
dispatches. A verifier does not — two bound verifiers are two opinions, and the consumer chooses or
refuses. So the flow role is configuration on the binding, not a claimed session identity.

## A. Flow roles on the project-agent binding

### Protocol

```ts
export const flowRoleSchema = z.enum(['implementer', 'verifier']);
// on projectAgentBindingSchema, beside the free-text `role`:
flowRoles: z.array(flowRoleSchema).max(2).optional(),
```

- Duplicates refused (`superRefine`: unique). `coordinator` is deliberately not a member — it is a
  session-level claim (ADR 0035), not agent configuration; putting both in one enum would suggest a
  binding could hold the dispatcher role, which it cannot.
- `projectAgentBindingCreateRequestSchema` inherits it; `projectAgentBindingPatchRequestSchema`'s
  `pick` adds `flowRoles: true`. An empty array clears the roles.
- The field is optional, so every existing `agent-bindings.json` and every Redis record stays valid
  on read (§14: validate on read; a strict object with a new optional key admits old records).

### Daemon

- `updateProjectAgentBinding` already spreads the request over the record and re-validates; no new
  branch. The `project.agent.updated` payload gains `flowRoles` (null when absent) beside `enabled`,
  as `project.agent.bound` already carries `role`. No new event type, no Redis key, no Function.
- No uniqueness across agents is enforced by the daemon. The binding is configuration; refusing "two
  verifiers" here would be policy the consumer owns (ADR 0031/0035 precedent: the daemon records,
  the external script decides). The dashboard shows the ambiguity instead.

### Surfaces

- **Dashboard, project drawer, "Bound agents":** a **Role** column — the free-text `role`
  (truncated with the full text as `title`) and one `StatusChip` per flow role. Per row, two toggles,
  **Implementer** and **Verifier**, that `PATCH /api/v1/projects/:projectId/agents/:bindingId` with
  the new `flowRoles` through `api/project-mutations.ts` (`updateAgentBinding(projectId, bindingId,
{ flowRoles })`). This widens ADR 0033's module from "the project's own fields" to "the project's
  configuration the daemon already lets the owner edit", recorded in ADR 0036; no fifth-module
  allowlist entry is needed for it. A refusal is rendered in the daemon's words.
- **CLI:** nothing new — `luwi projects agent update <projectId> <bindingId> --body
'{"flowRoles":["verifier"]}'` already passes the body to the PATCH schema. README documents it.
- **MCP:** `luwi_list_project_agents` returns the collection, so the field rides along; no new tool.
- **`flow.mjs` (repo-external, `~/.luwi/managed-agents/albanoosh/`):** when `argv` names no
  implementer/verifier, read `GET /api/v1/projects/:projectId/agents`, take the enabled binding whose
  `flowRoles` holds `implementer` and the one holding `verifier`, and map each to the configured
  worker by `worker.agentId === binding.agentId`. Refuse — nothing dispatched — when a role is bound
  to no agent, to more than one, to an agent that is not a configured worker, or when both resolve to
  the same agent. `argv` keeps overriding for a one-off run.
  **Pilot data fix, the owner's:** the fleet's claude worker is agent `albanoosh-claude-coder`,
  while the project's binding names `claude-code`; the binding has to be created for the worker's
  agent id before the roles resolve. Not a LUWI change.

### Not in this increment

`.luwi/roles.md`; any daemon-side rule about how many verifiers a project may have. (A flow-role
chip on the sessions view and the drill-down facts were first left out because they need the
bindings on the pulse snapshot; they were built the same day as a `bindings` fan-out beside the
coordinator one.)

## B. Skill management in the dashboard

### The module

`apps/dashboard/src/api/capability-mutations.ts` — the fifth allowlisted write module, on the
`coordinator-mutations.ts` pattern (bounded input check, `fetch`, `publicErrorResponseSchema` on a
non-2xx, schema-parsed success, a `failed/http|transport|invalid` result the caller renders):

| Method                              | Request                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `setEnabled(capabilityId, enabled)` | `PATCH /api/v1/capabilities/:id` `{ enabled }`                                                                  |
| `assign(capabilityId, target)`      | `POST /api/v1/capabilities/:id/assign` `{ scope: 'project', projectId, agentId?, enabled: true, settings: {} }` |
| `unassign(capabilityId, target)`    | `POST /api/v1/capabilities/:id/unassign`, same body                                                             |
| `rescan()`                          | `POST /api/v1/capabilities/scan` `{}`                                                                           |

No `create` (registering a project-local package folder was declined), no profile writes, no
`DELETE` (none exists on the daemon). `product-independence.test.ts` allowlists exactly five modules
and keeps failing if one is missing.

### The panel

The project drawer's **Skills** table gains, per row: **Enable / Disable** (hidden for an
`observed` package — the daemon refuses to update one and the file is the truth; the row says so),
**Assign to project** or, when an agent is selected in "Bound agents", **Assign to `<agentId>`**, and
**Unassign** for the same target. The panel header gains **Rescan**. Every refusal is shown as an
`outcome outcome--bad` alert in the daemon's words (`CAPABILITY_CONFLICT` when a project package is
assigned outside its project, `CAPABILITY_NOT_FOUND` on an unassign that never existed). The
`capability.*` events already invalidate the drawer's capability resource, so a successful change
re-reads without a manual refresh; the per-agent effect is visible where it already is — the
pair route's effective configuration (`#/projects/<id>/agents/<agentId>`).

No read route for capability bindings is added: assignment state is answered per agent by the
effective configuration, and the mutation's own response (the binding) is shown once as the outcome.

### Not in this increment

Writing `SKILL.md` or anything under `.claude/skills`, `.codex/skills`, `.gemini/skills` (LUWI
observes native skills; the plan chain writes one settings file per adapter and stays that way);
profile editing; MCP write tools for capabilities; a bindings list route.

## ADR 0036

"Flow roles on the project-agent binding, and dashboard capability mutations" — records the enum,
why the coordinator is not in it, the ADR 0033 module widening, the fifth allowlisted module, and
the three things declined (SKILL.md writes, `.luwi/roles.md`, daemon-side verifier uniqueness).

## Tests

- Protocol: `flowRoles` accepts each role and both, refuses a duplicate and an unknown value; the
  patch schema accepts `{ flowRoles: [] }`.
- Daemon: `control-plane-service.test.ts` — an update with `flowRoles` rewrites
  `agent-bindings.json` with the field and emits `project.agent.updated` carrying it;
  `canonical-store.test.ts` — a bindings file with the field loads. `app-phase*.test.ts` — PATCH
  through `inject` returns the field.
- Dashboard: `capability-mutations.test.ts` (each method's request shape, 2xx parse, refusal
  mapping, transport failure); `project-mutations.test.ts` (`updateAgentBinding`);
  `projects-view.test.tsx` — the Role column renders text and chips, a toggle issues the PATCH, the
  Skills controls issue the right mutation for project vs selected-agent target, an observed row
  shows no enable control, a refusal is rendered; `product-independence.test.ts` — five modules.
- Repo-external `flow.mjs`: its existing `native.test.mjs`-style check gains the role resolution
  cases (none / two / not-a-worker / same agent → refuse; one each → resolves).

## Out of scope

Enforcing one verifier per project in the daemon. Auto-dispatch or any daemon-side flow (§21).
Skill authoring. Profiles UI. Sessions-view role chips.
