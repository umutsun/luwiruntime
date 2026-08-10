# ADR 0019: The capability catalogue and the config chain, the last two item-ten domains

Status: Accepted  
Date: 2026-08-10

## Context

ADR 0017 deferred four of the 2026-08-09 audit's item-10 read domains on a measured condition —
each held zero records, so a route over any of them could not be verified by looking at it. ADR
0018 removed that condition with `pnpm seed` and built three of them. It left two, and was explicit
about why: not design, not data, but room. They remained new scope under section 21.

Both are approved and built here. Nothing else from the audit's numbered list is left open.

## Decision

### Two routes, not two panels

| Domain                            | Surface                                    |
| --------------------------------- | ------------------------------------------ |
| Capability and profile catalogue  | `#/capabilities`, Scope group after Agents |
| Config plans, snapshots and drift | `#/config`, Scope group after Capabilities |

Both endpoints behind the catalogue are unscoped inventories. Hanging them off the Projects route
would have put global-scope capabilities inside a project's frame and contradicted ADR 0008 on
screen. The config chain is the same argument: a plan names an agent, but snapshots and drift are
file-scoped and global, so no project or pair route contains them.

Detail is in-component selection, as `#/messages` does it. `routing.ts` gains two parameterless
routes and no new parsing.

### What the catalogue adds that the pair view cannot

The Projects route already resolves capabilities for one project-agent pair. The catalogue is the
inventory behind it, and it answers three questions that view structurally cannot: which packages
exist at all — including the ones no profile names and no pair resolves, which were invisible on
every surface — where each came from, and which profiles carry it.

It also resolves in the other direction. A profile's `capabilityIds` were rendered as bare
identifiers on the pair route; the catalogue turns each into a name, a kind, and an enabled state.

Resolution has four outcomes, not two. A reference with no match is either **beyond the loaded
page** or **not registered**, and those are opposite facts: one is a bound this view imposed, the
other is a profile naming a package the runtime does not have. When the catalogue read itself
failed, every reference is **unavailable** rather than either. The rule the rest of the dashboard
follows — empty is not not-observed is not unavailable — needed a third axis here.

### What the config chain renders

Three panels in the order a reader needs them: what is wrong now, what was proposed and what became
of it, and what the runtime preserved before it wrote.

Drift is classified from its two nullable hashes rather than reported as "drift". Expected and
observed both present and different is an **edit**; expected present and observed absent is a
**removal**; the reverse is a file that **appeared** where none was expected. Matching hashes are
not called drift at all, and two absent hashes are **unrecorded**. A deleted managed file and an
edited one need opposite responses, and one word for both gives the reader neither.

A snapshot file records whether the file existed before the apply. `false` means the apply created
it, so undoing that apply is a delete and not a restore — rendering both as "preserved" would
describe two opposite rollbacks with one word.

### Read-only, and here it matters more than elsewhere

Neither route offers a control that mutates. That is section 21 everywhere in this dashboard, but
the config domain is the one where the daemon's mutations — plan, approve, apply, rollback, drift
scan, reconcile — write to the developer's own agent configuration files. Both views carry a test
asserting that every button on them is `Open`, `Hide`, or `Copy`.

## Consequences

### A truncation the daemon asserted rather than measured

`GET /api/v1/capabilities` sent `truncated: false` as a literal while `listCapabilities` cut the
list at `limit` unconditionally. A runtime with more than 100 capability packages returned exactly
100 and called the page complete. This is the audit's second finding class — an unavailable or
partial read rendered as an observed fact — and it survived because nothing consumed the flag.

The route now over-fetches by one and compares, which is what every other bounded collection in
`app.ts` already did. `/api/v1/capabilities/scan` carried the same literal and is fixed with it.

The dashboard therefore does not derive a truncation of its own here, unlike the message list,
which has no flag to trust. Two independent derivations of the same bound can only disagree.

### A bound that is still silent

`/api/v1/config/plans`, `/api/v1/config/snapshots` and `/api/v1/config/drift` take no limit and
carry no `truncated` field, and the repository caps each at 1000. Beyond that they would truncate
in silence. Adding the flag means changing three collection schemas and their routes; it is not
done here, and the views make no completeness claim to compensate. A local single-user runtime with
a thousand config plans is not a state this defers lightly, only one it does not reach.

### Two defects the tests could not have caught

Both were found by looking at the fixture, which is the second time that has paid for itself.

- **A plan change ran its three parts together.** `.plan-change__head` was referenced in the view
  and never written in the CSS, so the path, the operation chip, and the management mode rendered
  as one unbroken string. Class names that do not exist fail silently; a render test asserting the
  three values are present passes on exactly this markup.
- **The config tables printed raw UUIDs.** Every other table in the dashboard uses `IdBadge` —
  abbreviated, full value in the title, copy control. Plan and snapshot identifiers are the row
  identity here, so the inconsistency was the widest thing on the page.

### The seeder was not re-runnable, and now says why

ADR 0018 made `seed-runtime.ts` reuse its project so project-scoped capabilities keep pointing at a
live one. That holds only while both halves of the fixture are cleared together: `FLUSHDB` drops
the project while `LUWI_HOME` keeps the capability that names it, because ADR 0007 makes that one
filesystem-canonical. The next run registers a new project and the assignment fails with a bare
`CAPABILITY_CONFLICT` naming neither cause nor remedy.

No endpoint reassigns a capability, so the script cannot repair this. It now detects the mismatch
one read after resolving the project and stops with the reset instructions instead.
