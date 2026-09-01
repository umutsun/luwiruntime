# CLI-First MVP Increment 3: Passive Capability Observation Plan

> **For Codex:** Execute test-first inside `C:\xampp\htdocs\luwiruntime`. Never execute a
> discovered file and do not commit unless explicitly requested.

**Goal:** Discover native Claude/Codex/Gemini skills from bounded configured roots, preserve
them as explicitly observed evidence in the existing capability catalogue, and expose honest
scan diagnostics without turning observation into canonical LUWI declaration.

**Architecture:** Add a filesystem-only observer to `@luwi/adapters`, compose it in the
existing daemon control-plane service, and persist stable observed projections through the
existing Redis repository/events. Native files remain canonical evidence; no discovered
content is copied into LUWI manifests. The existing `/api/v1/capabilities/scan` route becomes
the explicit mutation trigger and returns a versioned diagnostic response. No package,
datastore, command runner, script execution, watcher, or automatic background scan is added.

**Tech Stack:** Node filesystem/path/crypto standard library, existing Zod protocol,
`@luwi/adapters`, existing control-plane repository, Vitest.

---

## Task 1: Specify the versioned scan result

**Files:**

- Modify: `packages/protocol/src/control-plane.ts`
- Modify: `packages/protocol/src/control-plane.test.ts`
- Modify: `packages/protocol/src/index.ts`

1. Add `capabilityScanResponseSchema` containing bounded capabilities plus counts for roots
   scanned/unavailable, malformed manifests, ignored entries, and truncation.
2. Keep ordinary `CapabilityPackage` wire compatibility. Mark observation explicitly inside
   its bounded `manifest` as `managementMode: "observed"` with native adapter/root evidence;
   absence remains a declared/legacy package, so existing projections need no migration.
3. Prove malformed or unbounded diagnostics are rejected.

## Task 2: Build the non-executing adapter observer

**Files:**

- Create: `packages/adapters/src/capability-observer.ts`
- Create: `packages/adapters/src/capability-observer.test.ts`
- Modify: `packages/adapters/src/index.ts`

1. Define injected filesystem collaborators for canonicalization, bounded directory listing,
   stat, and bounded text reads. There is deliberately no command-runner collaborator.
2. Observe only direct child directories containing a bounded `SKILL.md` with simple valid
   frontmatter name/description. Do not parse or execute instructions, hooks, scripts, plugins,
   MCP definitions, or package manifests.
3. Reject symlink/junction escapes after canonicalization. Bound roots, entries, bytes, and
   elapsed time; count unavailable, ignored, malformed, and truncated evidence.
4. Produce stable IDs/checksums and explicit global/project, adapter, agent-kind, source, and
   root provenance.
5. Test valid, malformed, missing, escaped, duplicate, oversized, and truncated fixtures and
   prove no execution API exists or is invoked.

## Task 3: Add explicit capability roots configuration

**Files:**

- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/config.test.ts`

1. Parse `LUWI_CAPABILITY_ROOTS` with the platform path delimiter into at most 32 trimmed,
   unique roots; empty means no additional roots.
2. Keep built-in roots separate: global and project-local `.claude/skills`, `.codex/skills`,
   and `.gemini/skills` are derived by the service from the injected native home and registered
   projects.
3. Reject excessive, blank-only, or invalid configured entries without reading the filesystem.

## Task 4: Persist observed projections without overwriting declarations

**Files:**

- Modify: `apps/daemon/src/control-plane-service.ts`
- Modify: `apps/daemon/src/control-plane-service.test.ts`
- Modify: `apps/daemon/src/runtime.ts`

1. Add `scanCapabilities()` to the existing service and inject the observer/configured roots.
2. Scan built-in global roots, all registered project roots, and configured additional roots.
3. Convert observations to `CapabilityPackage` projections with stable IDs,
   `source: "agent-native"` or `"local-path"`, and explicit observed manifest provenance.
4. Preserve `createdAt` on refresh. Upsert only records already marked observed; if a stable ID
   collides with a declared package, skip/count it and never overwrite canonical state.
5. Emit existing capability registered/updated events with observation evidence. Do not write
   canonical LUWI manifests or change assignments/profiles.

## Task 5: Expose diagnostics through daemon, CLI, and Pulse

**Files:**

- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/src/app-phase3.test.ts`
- Modify: `apps/cli/src/control-plane-cli.ts`
- Modify: affected CLI tests
- Modify: `apps/dashboard/src/api/capability-catalog.ts`
- Modify: `apps/dashboard/src/api/capability-catalog.test.ts`
- Modify: `apps/dashboard/src/routes/capabilities-view.tsx`
- Modify: `apps/dashboard/src/routes/capabilities-view.test.tsx`

1. Make `POST /api/v1/capabilities/scan` call the mutation service and validate the scan schema.
2. Make `luwi capability scan` print the diagnostic result.
3. Derive an `observed` catalogue flag only from the explicit manifest marker and display it
   separately from enabled/disabled state. Do not infer loaded or invoked state from discovery.
4. Preserve existing assigned/effective/loaded/invoked handling unchanged and unknown-safe.

## Task 6: Verification

1. Run focused protocol, adapter, daemon, CLI, and dashboard tests.
2. Run all affected package tests, workspace typecheck, lint, Prettier, build, and
   `git diff --check`.
3. Run a read-only live scan preview against known roots only after the daemon lifecycle slice
   is available; until then do not mutate a developer runtime merely to claim live proof.

## Acceptance

- `LUWI_CAPABILITY_ROOTS` and known Claude/Codex/Gemini roots are bounded and deterministic.
- A valid skill appears as observed with exact root/adapter/scope provenance.
- Malformed, unavailable, escaped, ignored, and truncated evidence is counted, not fatal.
- Declared packages and canonical manifests are never overwritten by observation.
- Nothing discovered is executed and no command runner exists in the scan path.
- Pulse distinguishes observed discovery from enabled state and does not equate it with loaded
  or invoked evidence.
