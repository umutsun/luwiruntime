# CLI-First MVP Pulse Ask-Agent Implementation Plan

> **Execution note:** Implement test-first against the approved CLI-first MVP design. This is the one new Pulse coordination mutation; it must not broaden into task assignment, prompt injection, lease acquisition, or agent management.

**Goal:** Let a developer send one bounded durable question from an eligible online LUWI session to another online session in the same project, then open the resulting correlation in Messages.

**Architecture:** Add one isolated `message-mutations.ts` browser module over the existing `POST /api/v1/messages` protocol. Sessions supplies the eligible source/target evidence and owns a focused Ask dialog. The daemon, Redis schema, message service, and delivery semantics remain unchanged. The successful result navigates to a correlation-aware Messages hash route; realtime/message-scope refresh continues to load the authoritative record.

**Technology:** React, existing dashboard tokens/components, `@luwi/protocol/browser`, native `fetch`, Vitest/jsdom. No dependency is added.

---

## Visual direction

**Subject and job:** Pulse is an operational console for one developer coordinating concrete agent sessions. The Sessions route's single new job is to dispatch a bounded request without pretending LUWI can type into a terminal.

**Existing palette and type:** Preserve the current token palette, body/display hierarchy, mono identifier treatment, radii, and focus styles. No new brand colors or typefaces are introduced for one form.

**Layout:** The session table gains a terse `Ask` action beside `Inspect`. It opens a focused modal form. The distinctive element is a compact, monospace dispatch line that shows the chosen source session flowing to the fixed target session; this encodes the actual route rather than decorating the dialog.

```text
+--------------------------------------------------------+
| Ask session                                      [x]   |
| source/session-id  -----------------> target/session-id |
|                                                        |
| From       [eligible source session v]                 |
| Subject    [optional bounded subject       ]           |
| Question   [bounded multi-line content      ]           |
| Deadline   [2 minutes v]                               |
|                         [Cancel] [Send request]         |
+--------------------------------------------------------+
```

**Signature restraint:** The route line is the only new visual motif. It is specific to inter-session delivery and uses existing colors. No gradient, animation, card stack, agent avatar, chat bubble, or vendor branding is added.

**Self-critique:** A generic chat composer would suggest synchronous conversation and prompt injection, both false here. The revised dispatch form uses runtime vocabulary (`source`, `target`, `deadline`, `request`) and navigates to the durable Messages record, so the UI's visual model matches the product's asynchronous semantics.

## Task 1: Add the browser mutation boundary

**Files:**

- Modify: `packages/protocol/src/browser.ts`
- Create: `apps/dashboard/src/api/message-mutations.ts`
- Create: `apps/dashboard/src/api/message-mutations.test.ts`

1. Add failing tests for exact JSON request shape, `content-type`, a bounded `idempotency-key`, validated success, validated daemon error, invalid response, transport failure, and client-side invalid input.
2. Export the browser-safe message create request/response schemas and message bounds from the protocol leaf.
3. Implement `createMessageMutations(fetchImpl)` as a separate write-capable object. It accepts explicit source/target session IDs, question fields, timeout, and idempotency key; it never selects identities itself.
4. Parse both success and public error bodies and return safe discriminated results. Never throw untrusted daemon payloads into the component.
5. Run focused protocol/dashboard API tests.

## Task 2: Carry correlation in the Messages route

**Files:**

- Modify: `apps/dashboard/src/routing.ts`
- Modify: `apps/dashboard/src/routing.test.ts`
- Modify: `apps/dashboard/src/bootstrap.test.ts`
- Modify: `apps/dashboard/src/routes/messages-view.tsx`
- Modify: `apps/dashboard/src/routes/messages-view.test.tsx`

1. Add failing tests for `#/messages/<correlationId>` parsing, bounds/encoding, fallback, round trip, and continued on-demand message loading.
2. Extend only the Messages route with an optional correlation ID; keep all other simple routes unchanged.
3. Let `MessagesView` select the message whose correlation matches the routed value after the bounded list arrives. Do not claim it exists if it fell outside the retained page; render the normal list without a fabricated record.
4. Run routing/bootstrap/messages view tests.

## Task 3: Build the bounded Ask dialog

**Files:**

- Create: `apps/dashboard/src/routes/ask-session-dialog.tsx`
- Create: `apps/dashboard/src/routes/ask-session-dialog.test.tsx`
- Modify: `apps/dashboard/src/routes/sessions-view.tsx`
- Modify: `apps/dashboard/src/styles/projects.css`

1. Add failing component tests for online-only target actions, same-project online source options, target exclusion, unavailable source state, fixed question kind, bounded fields/deadline, immediate duplicate-submit guard, retained idempotency on retry, success callback, safe errors, Escape, focus entry/return, and keyboard focus containment.
2. Implement the dialog with native labels/select/input/textarea/button controls and the dispatch line. Use existing tokens and reduced visual scope.
3. Generate one idempotency key when a draft opens. Keep it for an identical retry; rotate it when a field changes so changed content cannot conflict with the previous fingerprint.
4. Disable every mutation control while the request is in flight. The daemon remains authoritative for a target that went offline after the snapshot.
5. Add `Ask` only for an online target when mutations are available. Eligible sources are online, same-project sessions other than the target; no synthetic source identity is allowed.
6. Run dialog and route tests.

## Task 4: Wire the composition root and mutation guard

**Files:**

- Modify: `apps/dashboard/src/app.tsx`
- Modify: `apps/dashboard/src/app.test.tsx`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/product-independence.test.ts`

1. Add failing app tests proving Ask is absent without the optional mutation capability, successful submission navigates to the encoded Messages correlation, offline targets cannot open it, and same-project source selection is preserved under project scope.
2. Instantiate `messageMutations` once beside the existing config mutation object and pass it explicitly into `DashboardApp`.
3. On success set the correlation-aware Messages hash. Do not optimistically insert a message; the existing route read/realtime invalidation remains authoritative.
4. Narrow the static mutation allowlist to exactly the existing config module plus the new message module. Preserve every prohibited endpoint assertion.
5. Run app and product-independence tests.

## Task 5: Verify and document the slice

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/phase5-dashboard-capability-matrix.md`

1. Document the asynchronous request semantics, eligibility, idempotency, same-project boundary, Messages navigation, and explicit non-goals.
2. Run dashboard-focused tests, format, typecheck, lint, the full repository unit suite with repository-local test temp state, and build.
3. Inspect the built Sessions route at desktop and narrow viewport against the live loopback daemon; verify focus, empty/unavailable states, offline target behavior, and that no mutation occurs during visual inspection.
4. Inspect `git diff --check` and report any unavailable live scenario honestly.
