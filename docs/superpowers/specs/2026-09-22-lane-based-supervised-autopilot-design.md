# Lane-based supervised autopilot — design

Status: approved by the owner 2026-09-22. Not built.

## Problem

The Albanoosh fleet's three workers (`albanoosh-claude-coder`, `antigravity`, `codex`) share one
working tree, `C:/xampp/htdocs/albanoosh`. Concurrent tasks rebased and committed on the same tree
and collided (goals v3–v5, 2026-09-22), so `maxInFlight` was cut to 1. The fleet is now correct but
serial.

## Operating model (owner decisions)

1. **Constrained planner + supervisor.** The owner sets goals and routes them to a lane (the
   objective's `[claude-coder]` / `[antigravity]` tag plus the bindings' `role`/`flowRoles`, which
   the plan context already carries as `workerRoles`). The brain decomposes within that lane.
   Autopilot supervises; in `supervised` mode the owner gates each plan. The mode is the operator's
   (`luwi autopilot mode`); Albanoosh was measured in `autopilot` mode on 2026-09-22, which skips
   the `plan_review` gate.
2. **One worktree per role.** Roles run in parallel; tasks within a role serialize on its branch.
3. **Bounded recovery.** Rework once, then park the goal `blocked` with one question, then a
   retrospective feeds the next plan. All three already exist (`orchestrator-cycle.ts`,
   `judgment.ts:156`); nothing is built for this decision.

## Approach

The manager scaffold (`~/.luwi/managed-agents/albanoosh/`, outside this repository) owns the lanes.
The daemon gains no lane, worktree or flow concept (§21). Rejected: a first-class lane in the
daemon (§21), and rebuilding the loop in `flow.mjs` (discards the working orchestrator).

## Components

### 1. Lane worktrees (manager)

| Role    | Worker                   | Worktree                                            | Branch         |
| ------- | ------------------------ | --------------------------------------------------- | -------------- |
| backend | `albanoosh-claude-coder` | `C:/xampp/htdocs/albanoosh/.worktrees/lane-backend` | `lane/backend` |
| mobile  | `antigravity`            | `C:/xampp/htdocs/albanoosh/.worktrees/lane-mobile`  | `lane/mobile`  |
| review  | `codex`                  | `C:/xampp/htdocs/albanoosh/.worktrees/lane-review`  | `lane/review`  |

- At `serve` startup, for each missing lane: `git worktree add -b lane/<role> <path> main` (or
  without `-b` when the branch already exists), then `pnpm install --frozen-lockfile` in it once.
  An existing lane is never recreated, reset or deleted.
- `config.json` points each worker's `workingDirectory` at its lane.
- `native.mjs:8` `CLAUDE_WORKING_DIRECTORY` moves from the repository root to `lane-backend`.
- The orchestrator (brain) keeps the repository root as its cwd: `native.mjs:237` stops reading
  `config.workers[0].workingDirectory` and uses a `repositoryRoot` config value.
- `.worktrees/` already exists and is the claude allowlist's convention; the generated claude
  allowlist (`claudeMcpBindingArgs`) is path-independent and needs no change.

### 2. Lane sync: fast-forward only (manager)

At startup and on each tick of the manager's existing supervision loop, per lane:

- worktree clean **and** `lane/<role>` is an ancestor of `main` → `git -C <lane> merge --ff-only main`;
- otherwise → no change; log `lane <role>: ahead|behind|dirty` once per state change.

The manager never rebases, resets, force-moves or deletes. Merging a lane into `main` stays the
owner's (§13); after that merge, the next tick brings the lane up to `main`.

### 3. Reviewer reads across worktrees (daemon, text only)

Worktrees share one object database, so any commit a worker makes is visible from `lane-review`.
The review task brief (`apps/daemon/src/autopilot-service.ts:1260`) gains one lane-agnostic line:

> The work is committed in another worktree of the same repository. Check out the commit the
> worker cited as a detached HEAD in your own working directory before running any check.

No protocol, Redis, event or `luwi_v1` change. The daemon needs one restart to carry it.

### 4. Parallelism

`maxInFlight` returns from 1 to 3 in the Albanoosh autopilot policy. A native bridge claims one
message at a time, so two tasks for the same worker already queue; three in flight means at most
one per lane. No per-lane limit is built.

## Error handling

- `worktree add` or `pnpm install` fails, or a lane path is missing after setup → `serve` refuses
  to start, the same way it refuses a missing configured path today.
- A lane that cannot fast-forward is logged and never blocks dispatch.
- A reviewer that cannot check out the cited commit answers the review honestly; the existing
  rework → escalate path handles it.

## Known limit

`antigravity` cannot run commands headless (agy `--print` denies them), so `lane-mobile` gets no
Flutter toolchain step. Mobile tasks stay edit-shaped; command-bearing mobile work routes to
claude-coder, whose lane is `lane-backend`. Routing decides this, not the lane.

## Tests

- `native.test.mjs`: lane paths validate (claude pinned to `lane-backend`); the sync rule —
  clean + ancestor → fast-forward; dirty → skip; diverged → skip; missing lane → created.
- One daemon unit test pins the new review-brief line.

## Acceptance

1. After a manager restart, `git worktree list` shows the three lanes on their branches, and each
   worker session's `workingDirectory` is its lane.
2. One backend goal and one mobile goal run concurrently with no rebase or commit collision.
3. Codex reviews a backend commit from `lane-review`, citing that commit.
4. After the owner merges `lane/backend` into `main`, the next tick fast-forwards `lane/backend`
   and leaves a lane with unmerged commits untouched.

## Out of scope

A lane-assignment UI, per-lane in-flight limits, automatic rebase, automatic merge, and making
`antigravity` a verifier.
