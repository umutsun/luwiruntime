# Dashboard Detail Drawer and Spacing Design

## Status

Approved in conversation on 2026-08-25. This specification includes the later clarification that
all list-to-detail surfaces must open in a drawer instead of rendering below their source list.

## Problem

The dashboard permanently reserves a third column for an empty Inspector on wide screens and moves
that column below the main content on narrower screens. Several other routes independently render
their selected detail below a list. Both behaviors waste space, separate the selected row from its
evidence, and make long pages harder to scan.

Some non-table panel content also renders directly against the panel edge. The missing internal
padding is especially visible in configuration forms and detail cards. Moving detail into a drawer
does not by itself fix those remaining form and panel spacing defects.

## Goals

- Do not render or reserve space for an Inspector when nothing is selected.
- Open project, session, event, message, capability package, capability profile, configuration plan,
  and configuration snapshot detail in one consistent right-side overlay drawer.
- Never move a selected detail below its source list at a responsive breakpoint.
- Let the user close a drawer with its close button, Escape, or a click on the backdrop.
- Return keyboard focus to the control that opened the drawer.
- Give drawer and non-table panel content consistent token-based padding and vertical rhythm.
- Preserve every existing read-only data state, boundedness disclosure, and unavailable/not-observed
  distinction.
- Add no production dependency and no datastore.

## Non-goals

- No dashboard mutation is added.
- No generic window manager, resizable pane framework, or nested drawer stack is introduced.
- Detail selection is not made durable across a full page reload unless it is already represented in
  the route, as project and message selections are today.
- Graph exploration remains an exploration workspace rather than being forced into the evidence
  drawer in this increment.
- External project files and Git repositories are never modified.

## Chosen Interaction

The application shell always has two layout tracks: navigation rail and main content. A selected
subject mounts a single overlay drawer at the right edge. The drawer uses a backdrop and the dialog
accessibility contract: it receives initial focus, traps Tab while open, closes on Escape or backdrop
activation, and returns focus to its opener.

Opening another subject replaces the current drawer content rather than stacking a second drawer.
The selected source row remains visually marked while the drawer is open. Closing clears the local
selection; route-backed project or message selections return to their collection route.

At desktop widths the drawer is wide enough for evidence tables but bounded so the source context is
still visible. At narrow widths it occupies the viewport except for the spacing-token gutter. Drawer
content scrolls vertically inside the viewport; tables retain their bounded horizontal overflow.
Reduced-motion users receive no slide transition.

## Component Design

Create one `DetailDrawer` component in `apps/dashboard/src/components/detail-drawer.tsx`. It owns:

- portal rendering above the shell;
- backdrop and drawer surface;
- labelled dialog semantics;
- close button, Escape, backdrop close, focus trap, and focus restoration;
- eyebrow, title, optional metadata, and a padded scrolling body.

`InspectorPanel` becomes drawer content instead of owning a permanent `<aside>`. `InspectorEmpty` is
removed from the shell. `ProjectEvidenceDrawer` is replaced by `DetailDrawer` while keeping the
existing route-backed project detail behavior.

Messages, capability packages, capability profiles, configuration plans, and configuration
snapshots keep their selection state in their existing route component but render the selected
detail inside `DetailDrawer`. Their current inline `Panel` wrapper is removed or converted to drawer
body content so the drawer does not contain a redundant card header.

## Spacing Contract

All new spacing uses the existing `--space-*` and `--panel-pad-*` tokens.

- Drawer header: consistent horizontal and vertical padding, separated by the existing border token.
- Drawer body: one padded scrolling column with a standard section gap.
- Detail definition lists: preserve the responsive grid, add a consistent bottom rhythm, and never
  touch the drawer edge.
- Forms and non-table panel bodies: use an explicit reusable padded body wrapper.
- Tables may remain edge-to-edge inside collection panels; filters, explanatory notes, forms, and
  action groups receive panel body padding rather than relying on incidental margins.
- Empty states inside padded detail content do not add a second large horizontal inset.

The visual language remains LUWI's current operational console: no new palette, typeface, shadow
system, or decorative motion. The only new visual signature is the right-edge evidence drawer.

## Project and Git Inventory

Register these existing developer projects through the current loopback daemon API, using their
canonical local paths and without writing inside them:

- `C:\xampp\htdocs\luwilisting`
- `C:\xampp\htdocs\luwiruntime`
- `C:\xampp\htdocs\luwistudio`
- `C:\xampp\htdocs\arshahomes`
- `C:\xampp\htdocs\corenine`
- `C:\xampp\htdocs\flybydeniz`
- `C:\xampp\htdocs\luwipress`
- `C:\xampp\htdocs\luwi-dev`
- `C:\xampp\htdocs\glasshouse`
- `C:\xampp\htdocs\semantic-bridge`

Registration remains explicit and idempotent. For each Git worktree, populate the project
repository URL and default branch only when Git reports them. A folder without a usable repository,
remote, branch, or commit stays a valid project and reports that evidence as not observed rather
than inventing a value. Existing Phase 4 read-only Git observation remains the only source for worktree
state, refs, and commit information; no remote is contacted.

## Testing

- Component tests prove drawer opening, close button, Escape, backdrop close, Tab containment, focus
  restoration, and absent rendering when closed.
- Shell tests prove the empty Inspector and third grid track are gone and project/session/event
  selections use the drawer.
- Route tests prove message, package, profile, plan, and snapshot details no longer appear inline and
  close without losing their collection.
- Style tests prove the shell has no inspector track, the drawer stays fixed at every breakpoint,
  reduced motion is respected, and spacing properties use tokens.
- Existing dashboard tests, typecheck, lint, build, and repository verification must remain green.
- Operational verification lists all ten projects, confirms Git evidence where available, and proves
  no external project file was changed.

## Operational Limits

The project registration and Git scans are local-only. They do not clone, fetch, pull, push, checkout,
or write repository configuration. A remote URL is descriptive evidence, not a network integration.
