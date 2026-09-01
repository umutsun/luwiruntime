# Phase 0: Commit Split, ADR 0025, and Documentation Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the uncommitted 2026-08-24/25 tranche (81 modified + 40 untracked files, verified
green on 2026-09-01) as six dependency-ordered commits with a decision record, and make
`AGENTS.md`, `README.md`, and the plan documents truthful again.

**Architecture:** No code changes. The tranche's files carry several features through the same
modules (`cli.ts` +909 lines spans five commands; `app.ts` carries two features), so — following
this repo's own precedent for the Phases 2–5C commit — the split is **whole-file, layer-ordered**
(packages → daemon → cli → dashboard → docs), with each commit message enumerating the features it
contains. Splitting single-file diffs across commits via patch surgery is explicitly out of scope:
the hook blocks the recovery tools that would make it safe.

**Tech Stack:** git, the editing tools (never scripted writes — `AGENTS.md` is in
`.prettierignore` and scripted writes produce CRLF on this machine), pnpm, the `/adr` skill.

## Global Constraints

- The owner's 2026-09-01 directive (recorded in `2026-09-01-completion-program.md`) authorizes
  **exactly the six commits in this plan** — no others, no push, no branch changes.
- Never `git reset --hard`, `git clean -f`, `git stash`, `git checkout/restore .` (hook-blocked).
- `git status` may lie about same-second mtimes: confirm any surprising "modified" with
  `git diff` before believing it.
- Edit `AGENTS.md` and all Markdown with the editing tools only.
- Intermediate commits are dependency-ordered but only the branch tip is verified — the same
  practice the repository history already records. Do not detach HEAD to test them.
- Only tick a pre-existing plan checkbox after verifying its deliverable exists in the tree.

---

### Task 1: Preflight verification

**Files:** none modified.

- [ ] **Step 1: Confirm the tree matches the plan's premise**

Run: `git log --oneline -3 && git status --porcelain | wc -l`
Expected: HEAD `ddb9bd0`, ~119 paths. If HEAD moved or the count differs materially, STOP and
report — this plan describes a specific tree.

- [ ] **Step 2: Run the full gate**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: both typecheck legs clean; 148 test files / 1452 tests passed; lint silent. Record the
actual numbers. If anything fails, STOP: fix nothing, report the output — the premise of this
plan is a green tree.

### Task 2: Write ADR 0025

**Files:**

- Create: `docs/decisions/0025-cli-first-mvp-and-deepseek-bridge.md`

**Interfaces:** Consumes the four specs under `docs/superpowers/specs/2026-08-24-*.md` and
`2026-08-25-*.md`. Produces the ADR number that Tasks 3–5 and the commit messages reference.

- [ ] **Step 1: Draft with the `/adr` skill**, following the house convention (`Status: Accepted`,
      Context / Decision / Consequences), recording ALL of the following decisions — each is already
      built and tested; the ADR retro-documents the tranche the way §16/§21 require:

1. **CLI-first lifecycle surface.** `luwi start|stop|status|doctor|setup|reset` in
   `apps/cli/src/lifecycle.ts`; `POST /api/v1/runtime/stop` gated by an `x-luwi-lifecycle-token`
   header compared with `timingSafeEqual`, refusing unmanaged daemons with
   `DAEMON_LIFECYCLE_UNMANAGED` (403) and bad tokens with `DAEMON_LIFECYCLE_FORBIDDEN` (403).
2. **Runtime reset as a daemon-boundary maintenance entry.**
   `packages/redis/src/runtime-reset.ts` (bounded `SCAN`+`UNLINK` over the compile-time
   `luwi:v1:*` namespace only) invoked solely by `apps/daemon/src/runtime-reset-main.ts`; the CLI
   never connects to Redis. `function-library.ts` accepts caller-supplied `createdAt`/`updatedAt`
   on project registration (both-or-neither) for timestamp-faithful canonical restore — verify and
   state in the ADR whether the library version moved, per the registry's record-shape rule.
3. **Project discovery.** Passive, immediate-child-only, dry-run by default; apply path uses the
   existing daemon HTTP API (`apps/cli/src/project-discovery.ts`).
4. **Capability observation.** Read-only root scanning in
   `packages/adapters/src/capability-observer.ts` (`managementMode: 'observed'`), roots from
   `LUWI_CAPABILITY_ROOTS`; `capabilities/scan` converted from a disguised read into a real
   `withMutation` with a `capabilityScanResponseSchema` diagnostics block. Nothing discovered is
   executed.
5. **Second dashboard write boundary (supersession).**
   `apps/dashboard/src/api/message-mutations.ts` owns exactly `POST /api/v1/messages` for the
   bounded Ask flow. This supersedes ADR 0021's allowlist-of-one and the 2026-08-05 audit's
   "no mutation buttons" line **for this one flow only**; `product-independence.test.ts` now
   allowlists two modules and still forbids the prohibited operations everywhere. State that the
   2026-08-25 drawer spec's "no dashboard mutation" non-goal is superseded by the
   2026-08-24-cli-first-mvp-pulse-ask plan, and this ADR resolves the collision in favor of the
   Ask flow (owner decision G1, 2026-09-01).
6. **Inspector column → modal detail drawer.** Supersedes redesign phase 2's docked third track;
   the plan's own accessibility argument (`aria-modal` on a permanently visible pane is a lie to
   assistive technology) is satisfied in the opposite direction by a genuinely modal
   `components/detail-drawer.tsx`.
7. **DeepSeek Harness ACP bridge — experimental edge adapter.** `session bridge deepseek`
   registers one DeepSeek Harness ACP process as one ordinary LUWI session (adapter id
   `deepseek-harness-acp-v1`); fresh ACP sessions only, no history import; no DeepSeek dependency
   in daemon/runtime/protocol/redis; no MCP injection at `session/new` (DeepSeek Harness rejects
   non-empty `mcpServers`); it routes around — does not resolve — the parked SQLite-store blocker
   of 2026-08-17.

- [ ] **Step 2: Cross-check** the ADR against the four specs' own decision sections; where a spec
      already states a decision, cite it rather than restating it.

### Task 3: Correct AGENTS.md

**Files:**

- Modify: `AGENTS.md:1029-1031` and the §21 tail (insert before the paragraph beginning
  `**Every other prohibition below still stands.**`).

- [ ] **Step 1: Fix the allowlist claim.** Replace exactly:

```
`apps/dashboard/src/api/config-mutations.ts` is the **only** production module in the dashboard
permitted to issue a state-changing request. `product-independence.test.ts` enforces that as an
allowlist of one and still forbids the prohibited operations everywhere, including inside it.
```

with:

```
`apps/dashboard/src/api/config-mutations.ts` and `apps/dashboard/src/api/message-mutations.ts`
(ADR 0025 — the second owns exactly `POST /api/v1/messages` for the bounded Ask flow) are the only
production modules in the dashboard permitted to issue a state-changing request.
`product-independence.test.ts` enforces that as an allowlist of two and still forbids the
prohibited operations everywhere, including inside them.
```

- [ ] **Step 2: Record the tranche in §21.** Insert as a new paragraph directly after the
      paragraph ending `…remain unapproved.` (currently near line 1125):

```
**Built since, under ADR 0025 (committed 2026-09-01):** the CLI-first lifecycle surface
(`luwi start`, `stop`, `status`, `doctor`, `setup`, `reset`) with the token-gated
`POST /api/v1/runtime/stop`; the daemon-boundary runtime reset over `luwi:v1:*`; one-level,
dry-run-first project discovery; read-only capability-root observation feeding a real
`capabilities/scan` mutation; the dashboard detail drawer with the bounded Ask flow behind the
second dashboard write module; and the experimental DeepSeek Harness ACP bridge as a CLI edge
adapter. Automatic lease renewal and autostart remain unapproved by that ADR.
```

- [ ] **Step 3: Verify line endings survived.** Run: `git diff AGENTS.md | head -40` and confirm
      the diff shows only these two edits (a whole-file CRLF rewrite would show every line changed —
      if so, the edit was scripted; redo with the editing tools).

### Task 4: Back-annotate the redesign plan

**Files:**

- Modify: `docs/2026-08-14-dashboard-redesign-plan.md:114-136`

- [ ] **Step 1:** In the `## Status after phase 3` section (line ~116), replace
      `built and verified, and not yet committed` with `built and verified, committed at \`4404b1a\``.
- [ ] **Step 2:** Replace the heading `## Status after phases 4-6 (2026-08-15, uncommitted)` with
      `## Status after phases 4-6 (2026-08-15, committed at \`4404b1a\`; completion recorded at
      \`3d2a679\`)`.
- [ ] **Step 3:** Append to the end of the `## Status after phase 2` section:

```
**Superseded 2026-08-25:** the docked inspector column was replaced by a modal detail drawer —
spec `docs/superpowers/specs/2026-08-25-dashboard-detail-drawer-spacing-design.md`, decision
ADR 0025. The aria-modal argument this phase made is satisfied in the opposite direction: the
drawer is genuinely modal, and `shell.test.ts` now pins the two-track grid instead.
```

### Task 5: Close out the stale plan checkboxes

**Files:**

- Modify: `docs/superpowers/plans/2026-08-17-phase-c-session-self-registration.md` (11 unchecked)
- Modify: `docs/superpowers/plans/2026-08-25-cli-runtime-reset-project-discovery.md` (0/38)
- Modify: `docs/superpowers/plans/2026-08-25-dashboard-detail-drawer-spacing.md` (0/31)
- Optionally the six other untracked `2026-08-24-*.md` plans, same rule.

- [ ] **Step 1:** For each unchecked task, verify its named deliverable (file, test, behavior)
      exists in the current tree — `Glob` the file, `Grep` the test name. Tick only what verifies.
- [ ] **Step 2:** For a task whose deliverable does not exist or was superseded, do NOT tick it;
      append a one-line italic note under it: _`superseded by <what>`_ or _`not done — carried to
2026-09-01-completion-program.md`_. (Known case: phase-C Task 4's capability-roots work was
      delivered later by `capability-observer.ts` — mark it superseded with that pointer, not done.)
- [ ] **Step 3:** Re-run `pnpm format` — plan files are Prettier-formatted; fix any complaint with
      `pnpm format:write` scoped to the touched files.

### Task 6: Extend README "Current status"

**Files:**

- Modify: `README.md` (the "Current status" section, which currently narrates through ADR 0023/B1)

- [ ] **Step 1:** Append a closing paragraph to the status narrative (before any section that
      follows it), adjusting phrasing to fit the section's voice:

```
ADR 0025 then landed the CLI-first tranche: the lifecycle surface (`luwi start|stop|status|
doctor|setup|reset`) with a token-gated `POST /api/v1/runtime/stop`, a daemon-boundary runtime
reset scoped to `luwi:v1:*`, dry-run-first project discovery, read-only capability-root
observation behind a real `capabilities/scan` mutation, the dashboard detail drawer with the
bounded Ask flow as the second (and only other) dashboard write module, and an experimental
DeepSeek Harness ACP bridge that registers one fresh ACP session as one ordinary LUWI session.
Tool and file observation (B2), automatic lease renewal, and autostart remain the open items.
```

- [ ] **Step 2:** Read the surrounding diff (`git diff README.md`) — the tranche already edited
      README heavily; make sure the new paragraph does not duplicate a statement the working tree
      already added, and reconcile rather than repeat.

### Task 7: The six commits

**Interfaces:** Consumes the ADR number from Task 2 and the doc edits from Tasks 3–6. Each `git add`
lists exact paths; each commit message ends with the trailer the executing harness requires.

- [ ] **Step 1 — C0, decisions and plans:**

```bash
git add docs/decisions/0025-cli-first-mvp-and-deepseek-bridge.md \
  docs/superpowers/specs/2026-08-24-cli-first-mvp-design.md \
  docs/superpowers/specs/2026-08-24-deepseek-acp-bridge-design.md \
  docs/superpowers/specs/2026-08-25-cli-runtime-reset-project-discovery-design.md \
  docs/superpowers/specs/2026-08-25-dashboard-detail-drawer-spacing-design.md \
  docs/superpowers/plans/2026-08-24-cli-first-mvp-agent-runner.md \
  docs/superpowers/plans/2026-08-24-cli-first-mvp-capability-observation.md \
  docs/superpowers/plans/2026-08-24-cli-first-mvp-lifecycle.md \
  docs/superpowers/plans/2026-08-24-cli-first-mvp-pulse-ask.md \
  docs/superpowers/plans/2026-08-24-cli-first-mvp-session-bootstrap.md \
  docs/superpowers/plans/2026-08-24-deepseek-acp-bridge.md \
  docs/superpowers/plans/2026-08-25-cli-runtime-reset-project-discovery.md \
  docs/superpowers/plans/2026-08-25-dashboard-detail-drawer-spacing.md \
  docs/superpowers/plans/2026-09-01-completion-program.md \
  docs/superpowers/plans/2026-09-01-phase0-commit-split-and-doc-sync.md
git commit -m "docs: ADR 0025 approves the CLI-first tranche and the completion program"
```

- [ ] **Step 2 — C1, packages:**

```bash
git add packages/protocol/src/browser.ts packages/protocol/src/control-plane.ts \
  packages/protocol/src/control-plane.test.ts packages/protocol/src/index.ts \
  packages/protocol/src/runtime-http.ts packages/protocol/src/runtime-http.test.ts \
  packages/redis/src/function-library.ts packages/redis/src/function-library.test.ts \
  packages/redis/src/index.ts packages/redis/src/runtime-repository.ts \
  packages/redis/src/runtime-repository.test.ts packages/redis/src/runtime-reset.ts \
  packages/redis/src/runtime-reset.test.ts packages/redis/src/runtime-reset.integration.test.ts \
  packages/runtime/src/index.ts packages/runtime/src/session-bootstrap.ts \
  packages/runtime/src/session-bootstrap.test.ts \
  packages/adapters/src/index.ts packages/adapters/src/node-collaborators.test.ts \
  packages/adapters/src/windows-process-cleanup.ts \
  packages/adapters/src/windows-process-cleanup.test.ts \
  packages/adapters/src/capability-observer.ts packages/adapters/src/capability-observer.test.ts
git commit -m "feat: package foundations — self-healing session bootstrap, runtime reset, capability observer, timestamped restore (ADR 0025)"
```

- [ ] **Step 3 — C2, daemon:**

```bash
git add apps/daemon/src/app.ts apps/daemon/src/app.test.ts apps/daemon/src/app-phase3.test.ts \
  apps/daemon/src/canonical-store.ts apps/daemon/src/canonical-store.test.ts \
  apps/daemon/src/config.ts apps/daemon/src/config.test.ts \
  apps/daemon/src/control-plane-service.ts apps/daemon/src/control-plane-service.test.ts \
  apps/daemon/src/git-observer.ts apps/daemon/src/git-observer.test.ts \
  apps/daemon/src/main.ts apps/daemon/src/project-service.ts \
  apps/daemon/src/project-service.test.ts apps/daemon/src/runtime.ts \
  apps/daemon/src/runtime.test.ts apps/daemon/src/runtime.integration.test.ts \
  apps/daemon/src/runtime-reset-main.ts apps/daemon/src/runtime-reset-main.test.ts \
  .env.example
git commit -m "feat: daemon lifecycle stop, runtime-reset entry point, capability-scan mutation, canonical restore ordering (ADR 0025)"
```

- [ ] **Step 4 — C3, CLI:**

```bash
git add apps/cli/package.json apps/cli/src/cli.ts apps/cli/src/cli.test.ts \
  apps/cli/src/control-plane-cli.ts apps/cli/src/index.ts \
  apps/cli/src/intelligence-cli.ts apps/cli/src/intelligence-cli.test.ts \
  apps/cli/src/lifecycle.ts apps/cli/src/lifecycle.test.ts \
  apps/cli/src/agent-runner.ts apps/cli/src/agent-runner.test.ts \
  apps/cli/src/project-discovery.ts apps/cli/src/project-discovery.test.ts \
  apps/cli/src/deepseek-bridge.ts apps/cli/src/deepseek-bridge.test.ts \
  apps/cli/src/deepseek-acp-client.ts apps/cli/src/deepseek-acp-client.test.ts \
  apps/cli/src/fixtures pnpm-lock.yaml
git commit -m "feat: CLI lifecycle family, agent runner, project discovery, DeepSeek ACP bridge (ADR 0025)"
```

- [ ] **Step 5 — C4, dashboard:** stage every remaining `apps/dashboard/` path — run
      `git status --porcelain apps/dashboard` first and confirm the list matches the tranche
      (modified: api/capability-catalog + pulse, app, bootstrap.test, command-palette, panel,
      inspector-panel, main, product-independence.test, projects-view, pulse model/view,
      capabilities/config/messages/sessions views, routes.test, routing, the five styles files +
      shell.test, tokens.css; new: api/message-mutations, components/detail-drawer,
      routes/ask-session-dialog, each with tests):

```bash
git add apps/dashboard
git commit -m "feat: detail drawer, bounded Ask flow behind a second write module, spacing pass (ADR 0025)"
```

- [ ] **Step 6 — C5, documentation sync:**

```bash
git add README.md AGENTS.md docs/architecture/overview.md docs/guides/cli-lifecycle.md \
  docs/phase5-dashboard-capability-matrix.md docs/2026-08-14-dashboard-redesign-plan.md \
  docs/superpowers/plans/2026-08-17-phase-c-session-self-registration.md
git commit -m "docs: sync AGENTS.md, README, redesign plan, and plan records with ADR 0025"
```

- [ ] **Step 7:** Run `git status --porcelain` — expected: **empty**. Any leftover path was missed
      by this plan: read its diff, assign it to the correct concern, and amend nothing — make a
      seventh commit naming it honestly.

### Task 8: Final verification

- [ ] **Step 1:** Run `/verify` (the §19 sequence). Expected: format, lint, typecheck, unit tests
      all green on the committed tree.
- [ ] **Step 2:** Run `git log --oneline -8` and report the commit list, the test numbers, and any
      deviation from this plan — in Turkish, honestly.
