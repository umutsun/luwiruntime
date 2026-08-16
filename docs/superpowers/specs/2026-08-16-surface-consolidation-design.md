# Surface consolidation — CLI, REST, MCP, UI/UX tidy-up — design

Date: 2026-08-16
Owner request: "cli rest mcp ui ux toparla" — bring the four product surfaces to a consistent,
finished state before Phase B begins. Approved approach: one phase, five bounded workstreams, no
new domains, `AGENTS.md` §21 untouched.

## Measured findings this design answers

1. **An owner-requested dashboard change is built but uncommitted.** The project evidence drawer
   (detail docks into the third column instead of rendering below the registry) sits in five
   modified files with its tests written and passing (83 tests in the two touched test files).
   It has not been through the full §19 sequence and has no recovery point.
2. **Leases are the only domain invisible to the CLI.** The daemon serves five lease routes, the
   MCP server exposes four lease tools, the dashboard renders held paths — the CLI has no `lease`
   command at all. Every other domain the daemon serves has a CLI counterpart.
3. **`config/reconcile` means two different things in the documentation.**
   `POST /api/v1/config/reconcile` is implemented, unit- and integration-tested, and runs at every
   daemon start: it recovers _interrupted config apply operations_ by comparing expected against
   observed file hashes (`reconcileOperation` in `packages/runtime/src/config-policy.ts`). The
   `config/reconcile` that `AGENTS.md` §21 prohibits and `CLAUDE.md` lists as "not implemented" is
   a different, unbuilt thing: automatic drift reconciliation that would rewrite the developer's
   files to erase drift. The name collision makes the status list read as false.
4. **The MCP server is proven but unreachable in practice.** 36 tools verified end to end over
   stdio, but no `claude` CLI exists on this machine to register it, and the hand-edit path for
   `~/.claude.json` is recorded nowhere in the repository.
5. **Known but excluded:** the >50 s stall on `POST /api/v1/context/contributions` under
   background sweeps (needs its own debugging session), and B0 native declaration (ADR 0023 has
   its own approved plan). Neither belongs in a tidy-up.

## Workstream 1 — land the drawer

Run the §19 definition-of-done sequence on the working tree as it stands. If green, commit the
five files as one commit (checkpoint approved in advance by the owner with the plan). The drawer's
contract is what its tests state: the detail renders in a `complementary` region named
"Project evidence" inside the docked column, the registry never renders it inline
(`renderDetailInline={false}` from the shell), and closing returns to `#/projects`.

No design work here — the design already happened; this workstream is verification and a recovery
point.

## Workstream 2 — CLI lease family

Add `luwi lease` with five subcommands, mapping one-to-one onto the existing routes:

| Command                   | Route                             |
| ------------------------- | --------------------------------- |
| `lease acquire`           | `POST /api/v1/leases`             |
| `lease renew <leaseId>`   | `POST /api/v1/leases/:id/renew`   |
| `lease release <leaseId>` | `POST /api/v1/leases/:id/release` |
| `lease list`              | `GET /api/v1/leases`              |
| `lease get <leaseId>`     | `GET /api/v1/leases/:id`          |

Rules:

- Flags mirror the request schemas exactly (`leaseAcquireRequestSchema`,
  `leaseListQuerySchema`, `leaseParamsSchema` from `@luwi/protocol`) — the CLI invents no field
  and derives no holder. Unlike MCP, the CLI is an operator tool: the session id is an explicit
  flag, as it already is for `message ask`.
- A refused overlapping claim is a _successful_ command (exit 0) that prints the refusal with the
  holder named, because the runtime answered correctly — same contract as the REST 200.
- Output, error handling, `--url` handling and JSON printing copy the existing command pattern in
  `apps/cli/src/cli.ts` (leases are coordination state, so they live there, not in the
  control-plane or intelligence trees).
- TDD against the same mocked-fetch harness `cli.test.ts` already uses.

## Workstream 3 — MCP registration path

Documentation only; no server code changes. The existing `README.md` "MCP server" section (line 405) gains the registration material: the two working registration paths on a machine without
the `claude` CLI: installing the CLI, or the exact `mcpServers` stanza to hand-edit into
`~/.claude.json` local scope — including the two facts that make naive registration fail: session
ids are runtime identity that go stale on daemon restart, and the server exits 1 before speaking
MCP when the session is not live. Verify and restate the tool inventory honestly: 36 tools, 25
reads, 11 writes by daemon method. No new tools; the graph-tool asymmetry (neighbors and path
exposed, summary and subgraph not) is recorded in the doc as a deliberate curation note, not
changed.

## Workstream 4 — documentation consistency

- `CLAUDE.md` status list: rename the banned item so it no longer collides with the implemented
  route — "automatic drift reconciliation (`config/reconcile` as desired-state enforcement)" —
  and state that `POST /api/v1/config/reconcile` (interrupted-apply recovery) exists and runs at
  daemon start.
- `AGENTS.md` §21: add the same disambiguating parenthetical to the prohibition line. `AGENTS.md`
  is in `.prettierignore` and must be edited with the editing tools, never scripted (CRLF trap).
- Sweep `README.md` "Current status" and `AGENTS.md` §10's initial-subset note against the actual
  route list; fix only what is false, add nothing speculative.

## Workstream 5 — UX micro-pass

Bounded to defects found by inspection of the drawer's interaction seams, each fixed with a test:

- Closing the drawer must place focus somewhere sensible (the registry table or the row that
  opened it), not drop it to `body`.
- `Escape` should close the drawer if and only if the docked inspector already honours `Escape` —
  the two panes share the column and must share the contract.
- The drawer and the inspector contend for one column: selecting a session while a project is
  open replaces the drawer with the inspector. Verify the return path (closing the inspector
  restores the drawer) and assert it.
- Copy check on the drawer's empty/loading states against the registry's existing voice.

Anything discovered beyond these seams is recorded, not fixed, unless it is a one-line copy or
token fix.

## Testing and completion

Each workstream lands with its tests; the phase ends with the full §19 sequence
(`pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`) green, a phase commit,
and an honest report. Two commits total are pre-approved: the WS1 checkpoint and the phase end;
if WS2 grows larger than expected a third midpoint commit may be proposed, not assumed.

## Out of scope

`context/contributions` stall, B0 declaration surface, new MCP tools, new REST routes, any §21
domain, dashboard features beyond the listed seams.
