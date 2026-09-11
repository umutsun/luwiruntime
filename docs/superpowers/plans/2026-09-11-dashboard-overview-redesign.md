# Dashboard overview redesign — implementation plan

Spec: `docs/superpowers/specs/2026-09-11-dashboard-overview-redesign-design.md`  
Date: 2026-09-11 · executed in one pass on the owner's instruction (no approval gates)

## Tasks, in order

1. **Tokens.** Rewrite `styles/tokens.css` to the mono palette; add `--ink`, `--paper`, `--line`,
   `--line-soft`, `--stripe`, `--space-5h`, `--font-size-3xl`, `--overview-aside-width`; retire the
   rail and command-bar tokens. Both light blocks stay byte-identical.
2. **Model.** `overview/model.ts` — pure derivations for all four views and the drill-down, with
   `overview/model.test.ts` written against the honesty table in the spec.
3. **Views.** `overview/{stats-row,ticker,board-view,flow-view,radial-view,timeline-view,drill-down,
overview}.tsx`, `overview/use-view-choice.ts`, `styles/overview.css`.
4. **Shell.** Rewrite `app.tsx` (header, overview route, detail routes in the same frame) and
   `styles/shell.css`; delete `pulse/pulse-view.tsx`, its test, `components/nav-icon.tsx`,
   `scopePulseSnapshot`, and the Pulse-only rules in `styles/pulse.css`; bump the bootstrap events
   read to `limit=200` in `api/pulse.ts` and its test.
5. **Guards.** Add `overview.css` to `tokens.test.ts` and `class-coverage.test.ts`; add the overview
   views to `class-coverage.test.ts`; rewrite `shell.test.ts` for the new contract; adapt
   `app.test.tsx`; write `overview/overview.test.tsx`.
6. **Gate.** `pnpm format:write`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; then a
   real-browser check of all four views against the running daemon.
7. **Docs.** ADR 0032, README "Current status", CLAUDE.md status paragraph, a superseded note in
   `docs/2026-08-14-dashboard-redesign-plan.md`, memory update.
