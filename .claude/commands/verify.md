---
description: Run the AGENTS.md section 19 definition-of-done sequence and report the result honestly.
argument-hint: '[optional: what changed, to focus the review]'
allowed-tools: Bash, Read, Grep, Glob
---

Run the definition-of-done sequence from `AGENTS.md` section 19 for this repository.

Context for this change, if given: $ARGUMENTS

## Run these in order, from the repository root

Stop at the first failure. Do not run later steps and guess at their outcome.

1. `pnpm format` — Prettier check. If it fails, run `pnpm format:write`, then report exactly which
   files were reformatted. `AGENTS.md` is in `.prettierignore`, so formatting it is not expected.
2. `pnpm lint` — ESLint. The `no-restricted-imports` rule encodes the section 5 package
   boundaries; if it fires, the design is wrong, not the rule.
3. `pnpm typecheck` — two legs: the dashboard, then `tsc -b`. The root `tsconfig.json`
   `references` deliberately omits `apps/dashboard`, so a green `tsc -b` alone proves nothing
   about the dashboard.
4. `pnpm test` — unit tests. This already includes the dashboard's 14 test files; there is no
   separate dashboard leg.
5. `pnpm build` — dashboard `vite build`, then `tsc -b`.

If `.claude/hooks/` changed, also run `node .claude/hooks/guard-bash.test.mjs`.

If Redis behavior changed, integration tests are a separate step — use `/redis-it`. Do not silently
skip them and call the change done; say that they are outstanding.

## Then check the parts that are not commands

- Does every new or changed state transition have a test? Section 15 requires it.
- Does the working tree contain accidental files or secrets? Note that this repository has only
  one commit, so `git status` shows a very large pre-existing set of untracked and modified files —
  compare against that baseline rather than treating everything as new.
- Is `README.md` still accurate? Section 16 requires it to document current behavior honestly.
- Was any planned or designed behavior described as implemented?

## Report

Report per step: the exact command, whether it actually ran, and its result.

**Never report a command as passing unless it ran and succeeded.** For a command that could not
run, give the exact command, the error, the likely cause, and the next safe action — this is a
binding rule from section 19, not a style preference.

End with: files changed, commands run with results, and any remaining limitation stated plainly.
