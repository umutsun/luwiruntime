# Dashboard Detail Drawer and Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are intentionally not used because the repository is already a shared dirty worktree and the user restricted work to `luwiruntime`.

**Goal:** Replace permanent and inline dashboard detail layouts with one accessible right-side overlay drawer, correct panel/form spacing, and register the requested local developer repositories with read-only Git evidence.

**Architecture:** A dependency-free `DetailDrawer` component owns portal, dialog, dismissal, focus, and responsive overlay behavior. Existing route components keep their bounded selection state and supply drawer content; the shell no longer reserves an Inspector grid track. Existing Redis-backed project registration and read-only Git observation APIs handle workspace inventory without modifying external repositories.

**Tech Stack:** React 19, TypeScript strict mode, CSS design tokens, Testing Library, Vitest, existing LUWI HTTP/CLI APIs.

## Global Constraints

- Work only in `C:\xampp\htdocs\luwiruntime`; external repositories are read-only observation targets.
- Add no production dependency and no datastore.
- Preserve loopback-only daemon access and every unavailable/not-observed distinction.
- Use existing `--space-*` and `--panel-pad-*` tokens for spacing.
- Follow test-first red/green/refactor for every behavior change.
- Do not create commits because repository instructions require an explicit commit request.

---

### Task 1: Shared accessible detail drawer

**Files:**

- Create: `apps/dashboard/src/components/detail-drawer.tsx`
- Create: `apps/dashboard/src/components/detail-drawer.test.tsx`
- Modify: `apps/dashboard/src/styles/activity.css`
- Modify: `apps/dashboard/src/styles/tokens.css`

**Interfaces:**

- Produces: `DetailDrawer({ eyebrow, title, meta?, onClose, children })`.
- Guarantees: portal rendering, one labelled modal dialog, close button, Escape/backdrop dismissal, Tab containment, initial close-button focus, opener focus restoration, and body scroll restoration.

- [x] **Step 1: Write failing component tests**

Add tests that render an opener and drawer, then assert `getByRole('dialog', { name: title })`, close-button focus, Tab wrapping, Escape close, backdrop close, focus restoration, and absence when the parent clears selection.

- [x] **Step 2: Verify the tests fail for the missing component**

Run: `pnpm --filter @luwi/dashboard test -- detail-drawer.test.tsx`

Expected: FAIL because `detail-drawer.js` does not exist.

- [x] **Step 3: Implement the minimal component**

Use `createPortal` and a fixed backdrop. Capture `document.activeElement` at mount. On keydown, close for Escape and cycle the drawer's enabled focusable elements for Tab/Shift+Tab. Close only when backdrop `event.target === event.currentTarget`. Restore the previous body overflow and opener focus on unmount.

```tsx
export function DetailDrawer({ eyebrow, title, meta, onClose, children }: DetailDrawerProps) {
  return createPortal(
    <div className="detail-drawer-layer" onMouseDown={closeFromBackdrop}>
      <section
        ref={surface}
        className="detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="detail-drawer__header">...</header>
        <div className="detail-drawer__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
```

- [x] **Step 4: Add token-based responsive styles**

The shell-facing layer is fixed for every breakpoint. Use `--z-dialog`, an existing neutral backdrop color, `width: min(42rem, calc(100vw - var(--space-8)))`, token-based header/body padding, internal body scrolling, and a reduced-motion override.

- [x] **Step 5: Verify Task 1**

Run: `pnpm --filter @luwi/dashboard test -- detail-drawer.test.tsx`

Expected: PASS.

---

### Task 2: Remove the permanent Inspector track

**Files:**

- Modify: `apps/dashboard/src/app.tsx`
- Modify: `apps/dashboard/src/app.test.tsx`
- Modify: `apps/dashboard/src/inspectors/inspector-panel.tsx`
- Modify: `apps/dashboard/src/inspectors/inspector-panel.test.tsx`
- Modify: `apps/dashboard/src/styles/shell.css`
- Modify: `apps/dashboard/src/styles/activity.css`
- Modify: `apps/dashboard/src/styles/shell.test.ts`
- Modify: `apps/dashboard/src/styles/tokens.test.ts`

**Interfaces:**

- Consumes: `DetailDrawer` from Task 1.
- Produces: a two-track shell and drawer-backed project/session/event detail.

- [x] **Step 1: Change shell tests first**

Assert that an unselected Pulse has no Inspector landmark or dialog, selecting a project/session/event opens a dialog, close clears it, and the source row remains selected while open. Change the CSS contract test to require two grid tracks and forbid the old static-inspector responsive rule.

- [x] **Step 2: Verify red**

Run: `pnpm --filter @luwi/dashboard test -- app.test.tsx shell.test.ts inspector-panel.test.tsx`

Expected: FAIL because `InspectorEmpty` and the third grid track still exist.

- [x] **Step 3: Refactor Inspector into drawer content**

Remove Inspector-owned close/focus effects and the permanent `<aside>`. Export a title helper and render the existing evidence body inside a neutral `.inspector-content` container. Delete `InspectorEmpty`.

- [x] **Step 4: Replace both shell pane implementations**

Delete `ProjectEvidenceDrawer`. In `DashboardApp`, render nothing for no selection, wrap project route detail in `DetailDrawer`, and wrap project/session/event Inspector content in `DetailDrawer`. Closing a project drawer routes to `#/projects`; closing transient evidence clears `selection`.

- [x] **Step 5: Remove reserved layout width**

Change both expanded and collapsed `.app-shell` grids to rail plus `minmax(0, 1fr)`. Remove the breakpoint that moves `.inspector` below content and remove obsolete `--inspector-width` coupling.

- [x] **Step 6: Verify Task 2**

Run: `pnpm --filter @luwi/dashboard test -- app.test.tsx shell.test.ts inspector-panel.test.tsx`

Expected: PASS.

---

### Task 3: Move route details from below lists into the drawer

**Files:**

- Modify: `apps/dashboard/src/routes/messages-view.tsx`
- Modify: `apps/dashboard/src/routes/messages-view.test.tsx`
- Modify: `apps/dashboard/src/routes/capabilities-view.tsx`
- Modify: `apps/dashboard/src/routes/capabilities-view.test.tsx`
- Modify: `apps/dashboard/src/routes/config-view.tsx`
- Modify: `apps/dashboard/src/routes/config-view.test.tsx`
- Modify: `apps/dashboard/src/app.tsx`

**Interfaces:**

- Consumes: `DetailDrawer`.
- Produces: exactly one open route-detail drawer for message, package, profile, plan, or snapshot.

- [x] **Step 1: Write failing route behavior tests**

For every detail kind, click its Open control and assert a labelled dialog exists while no inline `region` named `* detail` exists after the collection panel. Close via the drawer control and assert the collection remains. Add one test proving opening a profile replaces an open package drawer, and one proving opening a snapshot replaces an open plan drawer.

- [x] **Step 2: Verify red**

Run: `pnpm --filter @luwi/dashboard test -- messages-view.test.tsx capabilities-view.test.tsx config-view.test.tsx`

Expected: FAIL because detail is still an inline `Panel`.

- [x] **Step 3: Convert Messages detail**

Extract the message body into `MessageDetailContent`, render it in `DetailDrawer`, and add `onCloseRoutedDetail?: () => void`. `DashboardApp` passes a callback that routes `#/messages/<id>` back to `#/messages`.

- [x] **Step 4: Convert capability/profile detail**

Replace the two independent selected IDs with:

```ts
type CatalogSelection = { kind: 'capability'; id: string } | { kind: 'profile'; id: string };
```

Render one `DetailDrawer`; opening the other kind replaces the selection.

- [x] **Step 5: Convert plan/snapshot detail**

Replace the two independent selected IDs with a `ConfigDetailSelection` discriminated union and render one `DetailDrawer`. Keep apply/rollback confirmation dialogs independent from read-only detail selection.

- [x] **Step 6: Verify Task 3**

Run: `pnpm --filter @luwi/dashboard test -- messages-view.test.tsx capabilities-view.test.tsx config-view.test.tsx app.test.tsx`

Expected: PASS.

---

### Task 4: Establish consistent panel and form spacing

**Files:**

- Modify: `apps/dashboard/src/components/panel.tsx`
- Modify: `apps/dashboard/src/components/panel.test.tsx`
- Modify: `apps/dashboard/src/routes/config-view.tsx`
- Modify: `apps/dashboard/src/styles/pulse.css`
- Modify: `apps/dashboard/src/styles/projects.css`
- Modify: `apps/dashboard/src/styles/class-coverage.test.ts`
- Modify: `apps/dashboard/src/styles/tokens.test.ts`

**Interfaces:**

- Produces: `PanelBody({ children, className? })`, the explicit padded container for non-table panel content.

- [x] **Step 1: Write failing spacing structure tests**

Assert `PanelBody` renders `.panel__body`, Config `New plan` places its form/outcome/note inside it, and drawer detail uses `.detail-drawer__body` rather than relying on margins from its children.

- [x] **Step 2: Verify red**

Run: `pnpm --filter @luwi/dashboard test -- panel.test.tsx config-view.test.tsx class-coverage.test.ts tokens.test.ts`

Expected: FAIL because no reusable panel body exists and New plan is flush to the panel edge.

- [x] **Step 3: Implement and apply `PanelBody`**

```tsx
export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`panel__body${className === undefined ? '' : ` ${className}`}`}>{children}</div>
  );
}
```

Wrap the New plan form, its outcome, and explanatory note. Keep collection tables edge-to-edge unless their route already supplies an explicit body wrapper.

- [x] **Step 4: Add spacing styles**

Make `.panel__body` a minimum-width-zero vertical stack with `gap: var(--space-3)` and `padding: var(--panel-pad-y) var(--panel-pad-x) var(--space-4)`. Normalize first/last child margins, form wrapping, drawer definition-list rhythm, and narrow-screen action wrapping without raw spacing values.

- [x] **Step 5: Verify Task 4**

Run: `pnpm --filter @luwi/dashboard test -- panel.test.tsx config-view.test.tsx class-coverage.test.ts tokens.test.ts`

Expected: PASS.

---

### Task 5: Register developer projects and collect Git evidence

**Files:**

- No source files outside `luwiruntime` are modified.
- Runtime state: existing loopback daemon and Redis projections.

**Interfaces:**

- Consumes: `project list/register` and `git scan/status` CLI commands.
- Produces: ten idempotent project registrations and read-only Git observations where repositories are usable.

- [ ] **Step 1: Snapshot external repository state**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

For each approved path, capture `.git` presence and `git status --porcelain=v1` output hashes/counts before any LUWI operation. This is evidence that later scans caused no repository changes.

- [ ] **Step 2: Register only missing canonical paths**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Read `project list`, match canonical local paths case-insensitively, and invoke `project register` only for absent paths. Add `--repository-url` and `--default-branch` only when local Git reports non-empty values. Never execute clone/fetch/pull/push/checkout.

- [ ] **Step 3: Run bounded Git scans**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

For usable worktrees, run `node apps/cli/dist/main.js git scan --project <id>`. Record and continue past an honest repository-not-found result for a plain folder or empty/unusable Git directory.

- [ ] **Step 4: Verify registrations and immutability**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

List projects and Git status through LUWI. Recompute the external Git status evidence and assert it matches the pre-scan evidence. Confirm ten requested canonical paths are registered.

---

### Task 6: Full verification and live dashboard smoke test

**Files:**

- Modify only if verification reveals a defect covered by Tasks 1-4, returning to a failing test first.

- [x] **Step 1: Run focused dashboard verification**

Run: `pnpm --filter @luwi/dashboard test`

Expected: all dashboard tests PASS.

- [ ] **Step 2: Run repository verification**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run in order:

```text
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Rebuild/restart the owned daemon if dashboard assets changed**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Use the existing CLI lifecycle so only the verified owned daemon is stopped and restarted. Preserve Redis and its volume.

- [ ] **Step 4: Perform browser smoke checks**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

At desktop and narrow viewport widths verify: empty Pulse has no third column; clicking a project/session/event opens the drawer; Messages, Capabilities, and Configuration details open at the right rather than below; New plan has visible internal spacing; close, Escape, and backdrop dismissal work; light and dark themes remain readable.

- [ ] **Step 5: Inspect final diff**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Confirm no dependency, secret, build output, temp CLI, external repository file, or unrelated user change entered the diff. Report changed files, commands, results, project registrations, Git-scan limitations, and no commit.
