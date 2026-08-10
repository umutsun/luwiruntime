# ADR 0018: A seeded fixture runtime, and three of item 10's domains

Status: Accepted  
Date: 2026-08-10

## Context

ADR 0017 deferred four of the 2026-08-09 audit's item-10 read domains on a measured condition:
each held zero records on the developer runtime, so a dashboard route over any of them could not be
verified by looking at it. It named the condition that would lift the deferral — records existing —
and left the way to produce them undecided.

That is the gap this record closes. The domains were never blocked by design; they were blocked by
an empty runtime.

## Decision

### A seeded fixture runtime

`scripts/seed-runtime.ts` populates a runtime with representative data over the daemon's own HTTP
API — no Redis client, no direct key writes — so everything it produces has passed the same
validation an agent's traffic would. It creates a project, two agent definitions, three capability
packages, a profile, capability bindings, two project-agent bindings, two sessions, three messages
covering answered, rejected, and in-flight, three usage records including one with no token figures
at all, context sources from a real adapter scan with contributions across loaded, not-loaded and
unknown, a config plan applied into the fixture, an out-of-band edit to the applied file so drift
has something to find, and a real git repository so the observation, commit and attribution reads
have a subject.

The fixture deliberately produces **both** effective-configuration outcomes: one agent binds a
plugin its adapter does not support, so its configuration resolves invalid with a real conflict,
and the other resolves valid. An invalid state that only exists in theory is not a state anyone
verifies.

### Isolating it needs four variables, not one

Pointing the daemon at `redis://…/15` is not isolation, and finding that out cost a real cleanup:
the first run wrote agent definitions, capability packages and a profile into the developer's own
`~/.luwi`, and two projects into its root manifest. ADR 0007 makes the filesystem canonical for
those records, so they survive `FLUSHDB` and are rebuilt into Redis on startup. They were removed
and the manifest restored to its pre-seed project, verified by re-reading the real runtime.

A fixture therefore needs `REDIS_URL`, `LUWI_HOME`, `LUWI_NATIVE_HOME`, and `WORKSPACE_ID` together.
The script refuses to run unless `LUWI_SEED_CONFIRM=1` is set **and** the daemon reports a
`workspaceId` beginning with `fixture`. That handshake is the only one of the four the daemon
reports back over HTTP, so it is the only one the script can check; it is a declaration that the
operator set the other three, not proof. The script says so rather than implying more.

### Three domains built

| Domain                                    | Surface                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| Inter-agent messaging                     | `#/messages` with a state filter and a per-message detail |
| Effective agent configuration             | Project route, on selecting a bound agent                 |
| Pair-scoped context summary and footprint | Project route, alongside the effective configuration      |

The Projects route's `profileCount` and `capabilityCount` — the audit's one coverage gap with a
concrete user-visible dead end — are now openable: selecting a bound agent addresses
`#/projects/<id>/agents/<agentId>` and loads exactly what those two numbers count.

Messaging renders what an Activity row cannot: who asked whom, the subject and body, why the
runtime chose that recipient, the state, and the response with its own confidence. A rejected
message is presented as an answer rather than a fault, because that is what it is.

### Two domains still deferred

The capability and profile catalogue, and config plans, snapshots and drift, are **not** built.
Both now have fixture data, so the ADR 0017 condition no longer blocks them — they are deferred
only because this change ran out of room to build them with tests and visual verification, and a
half-built route is worse than an honestly absent one. They remain new scope under section 21.

## Consequences

Three defects surfaced that no test had reached, all on the protocol boundary, all found by
building the first dashboard consumer of these schemas:

- **`node:crypto` reached the browser bundle.** `message.ts` imported `redisStreamIdSchema` from
  `realtime.ts`, which imports `runtime-event.ts`, which imports `node:crypto`. Re-exporting any
  message schema through `browser.ts` therefore pulled a Node builtin into the browser. The schema
  moved to a leaf module, `stream-id.ts`; `apps/dashboard/vite.config.test.ts` caught this.
- **`Buffer` was used inside schema refinements.** `message.ts` and `session.ts` measured UTF-8
  length with `Buffer.byteLength`, a Node global. The daemon parsed fine; the browser threw
  `ReferenceError: Buffer is not defined`. Both now use `utf8-bytes.ts`, which wraps `TextEncoder`.
  The bundle guard cannot catch this class — a bare global is not an import — which is why the
  helper exists rather than a rule.
- **A schema that throws left the UI loading forever.** `safeParse` returns validation failures; it
  does not contain a refinement that throws. The rejection escaped every caller, so the promise
  never settled and the panel sat on its loading state instead of reporting a fault.
  `createDaemonClient` now treats an unparseable response as unavailable however it failed to
  parse, which is the honest answer and is now tested.

The third is the most instructive: the dashboard's own honesty discipline — separating empty,
not-observed and unavailable — had no state for "the validator itself broke", and the default was
the one state that says nothing and never resolves.

Selecting a bound agent costs three further bounded reads, loaded only while that pair is
selected. `routing.ts` now parses `#/projects/<id>/agents/<agentId>`; an unknown sub-path degrades
to the project rather than to Pulse, because the hash is user-editable.

The seeding script is verification tooling and ships as `pnpm seed`. It is not product surface, it
calls no endpoint the dashboard calls, and it is the reason the three domains above could be
looked at before being called done.
