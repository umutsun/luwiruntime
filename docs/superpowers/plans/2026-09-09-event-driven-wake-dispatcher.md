# Event-Driven Wake Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic unattended bridge routing and exactly-once durable Codex wake/continuation for explicit workflows while the source inbox remains authoritative.

**Architecture:** Pure policy belongs in `@luwi/runtime`; Redis Functions own state, atomicity, and fencing; the daemon owns validation and loopback APIs but never spawns; CLI owns providers and the exact queue command. Terminal response writes the inbox/event/wake atomically and a fenced coordinator advances the workflow.

**Tech Stack:** TypeScript 6, Zod, Vitest, Node 22, Redis Functions/Streams, daemon HTTP, Codex CLI, MCP, Pulse.

## Global Constraints

- Datastore `luwi_v1` is version **13**; daemon refuses incompatible Function source/version before wake operation.
- Preserve direct `targetSessionId` behavior and the existing public `MessageTargetSelection` `{ status: 'selected'; session: SessionView; reason: string }`. Agent routing ranks exact `metadata.bridge === 'native-headless'`, then existing status, heartbeat, lexical ID; bridge selection reason includes exact phrase `native-headless bridge preference`, all other reason strings remain unchanged.
- Slot identity is SHA-256 of `(workspaceId, projectId, agentId)`; owner token is random/process-local, TTL 15 seconds, renewal five seconds, and never public/logged. Validate it atomically in session registration/rotation Functions before writing session/link metadata.
- Supervised providers parse only strict effective `settings.luwiNativeBridge`; fixed argv templates run `shell: false`; reject free args, `additionalArgs`, shells and Windows shims (`cmd`, PowerShell, `.cmd`, `.bat`), mismatch and unsupported profiles. Codex supports measured read-only/workspace-write; Claude needs version fixtures; Gemini is disabled until safe live proof; Antigravity unavailable while bypass permissions is required.
- Automatic Codex wake accepts only trusted main-session exact-host/launcher bindings, same-session MCP proof and exact `hostWakeAdapter: 'codex-queue-v1'`; heuristic, subagent, stale/trimmed/conflicting evidence is inbox-only.
- Declare every Redis key to Functions. Terminal transition atomically writes terminal message, source inbox response, terminal event, one wake intent, Stream item and `wake.requested`; no duplicate terminal wake.
- Create wake group at `0-0` only after compatible owned daemon startup. Use blocking reads and `XAUTOCLAIM`; never trim pending/lagging Stream entries. `dispatching` ambiguity/crash is `indeterminate`, never replay.
- Wake dispatch completion and workflow continuation are independent facts: continuation is valid while the wake is durably `dispatching`; its revision decision receipt cannot be overwritten by a later `dispatched`, `fallback_only`, or `indeterminate` update.
- Exact spawn is `codex queue --thread <nativeSessionId> --message <wakePrompt>` with no shell and a ≤1KiB pointer prompt containing validated IDs/state only.
- `luwi_continue_workflow(workflowId, expectedRevision, wakeIntentId, decision)` atomically creates at most one next message or terminal/human-blocked state. MCP is request driven, daemon never launches vendors, Pulse is read-only.
- Run Redis integration checks only against a dedicated Redis-compatible process on `127.0.0.1:6391`; never use coordination Redis `6379` or Albanoosh Redis `6380`. Every invocation sets both `LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'` and `LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'`. Inside each suite derive `runId = run_${randomUUID().replaceAll('-', '')}`, pass `createRedisKeys('luwi:test:' + runId + ':v1')` and `createFunctionRegistry(runId)` into every repository/daemon collaborator, and delete only that namespace and exact registry library during teardown.
- Before Task 5 integration checks, create `C:\xampp\htdocs\luwiruntime\.worktrees\codex-event-driven-wake-dispatcher\.superpowers\sdd\redis-6391`, start `C:\Program Files\Memurai\memurai.exe` with fixed arguments `--port 6391 --appendonly no --save 1000000 1 --dir C:\xampp\htdocs\luwiruntime\.worktrees\codex-event-driven-wake-dispatcher\.superpowers\sdd\redis-6391` using `Start-Process -WindowStyle Hidden -PassThru`, record that exact PID, and stop only that PID after the final Redis check.

---

### Task 1: Make agent-targeted bridge routing deterministic

**Files:** Modify `packages/runtime/src/message-routing.ts`; test `packages/runtime/src/message-routing.test.ts`.

**Interfaces:** `selectMessageTarget(input): MessageTargetSelection` remains unchanged publicly.

- [ ] **Step 1: Write failing comparator tests**

```ts
expect(
  selectMessageTarget({
    sourceSession: source,
    targetAgentId: 'claude-code',
    sessions: [interactive, bridge],
  }),
).toEqual(
  expect.objectContaining({
    session: bridge,
    reason: expect.stringContaining('native-headless bridge preference'),
  }),
);
expect(
  selectMessageTarget({
    sourceSession: source,
    targetSessionId: interactive.id,
    sessions: [interactive, bridge],
  }),
).toEqual(
  expect.objectContaining({
    session: interactive,
    reason: `direct target session ${interactive.id}`,
  }),
);
```

Cover exact marker, duplicate deterministic choice, offline/terminal exclusion, unchanged no-bridge fallback.

- [ ] **Step 2: Run failing test**

Run: `pnpm exec vitest run packages/runtime/src/message-routing.test.ts`

Expected: FAIL because bridge rank is absent.

- [ ] **Step 3: Implement rank before existing comparator**

```ts
const bridgeRank = (s: SessionView) => (s.metadata.bridge === 'native-headless' ? 0 : 1);
```

Keep direct/no-bridge reasons verbatim; use bridge reason only when rank decides.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run packages/runtime/src/message-routing.test.ts`

Expected: PASS. Commit: `git add packages/runtime/src/message-routing* && git commit -m "feat(runtime): prefer native headless bridge routing"`.

### Task 2: Define strict bridge, wake, workflow, and event protocol

**Files:** Create `packages/protocol/src/bridge.ts`, `wake.ts`, `workflow.ts` and tests; modify `native-session.ts`, `native-session.test.ts`, `session.ts`, `session.test.ts`, `runtime-event.ts`, `runtime-event.test.ts`, `index.ts`, `browser.ts` and its export test.

**Interfaces:** Export strict public views/requests for slots, wakes and workflows, discriminated workflow decisions, and all bridge/wake runtime event names. Add `NativeIdentityProvenance = { source: 'host_launcher'; launcherInstanceId: string } | { source: 'filesystem_heuristic' }` and private `HostWakeDeclaration = { adapter: 'codex-queue-v1'; mcpSessionId: string }`; public/browser views expose only a boolean wake-capability projection and never either proof identifier.

- [ ] **Step 1: Write failing schema tests**

```ts
expect(() => parseBridgeSlotView({ ...slot, ownerToken: 'secret' })).toThrow();
expect(() => parseWakeIntentView({ ...intent, nativeSessionId: 'native' })).toThrow();
expect(() =>
  parseContinueWorkflowRequest({
    workflowId: 'w',
    expectedRevision: 1,
    wakeIntentId: 'i',
    decision: { kind: 'complete', targetAgentId: 'x' },
  }),
).toThrow();
expect(() =>
  parseHostWakeDeclaration({
    adapter: 'codex-queue-v1',
    mcpSessionId: 'other-session',
    extra: true,
  }),
).toThrow();
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/protocol/src/bridge.test.ts packages/protocol/src/wake.test.ts packages/protocol/src/workflow.test.ts packages/protocol/src/native-session.test.ts packages/protocol/src/session.test.ts packages/protocol/src/runtime-event.test.ts`

Expected: FAIL because schemas and event union entries are absent.

- [ ] **Step 3: Implement strict bounded Zod records**

```ts
export const wakeIntentStateSchema = z.enum([
  'pending',
  'claimed',
  'dispatching',
  'dispatched',
  'fallback_only',
  'indeterminate',
]);
export const workflowDecisionSchema = z.discriminatedUnion('kind', [
  nextMessageSchema,
  completeSchema,
  waitingForHumanSchema,
]);
export const nativeIdentityProvenanceSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('host_launcher'), launcherInstanceId: idSchema }),
  z.strictObject({ source: z.literal('filesystem_heuristic') }),
]);
export const hostWakeDeclarationSchema = z.strictObject({
  adapter: z.literal('codex-queue-v1'),
  mcpSessionId: idSchema,
});
```

Persist provenance separately from the opaque native reference. Reject undeclared fields and expose no launcher proof, MCP session proof, token, native ID, argv, or output through browser exports.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run packages/protocol/src/bridge.test.ts packages/protocol/src/wake.test.ts packages/protocol/src/workflow.test.ts packages/protocol/src/native-session.test.ts packages/protocol/src/session.test.ts packages/protocol/src/runtime-event.test.ts`

Expected: PASS. Commit: `git add packages/protocol && git commit -m "feat(protocol): add wake workflow contracts"`.

### Task 3: Add pure slot, provider, wake, and continuation policy

**Files:** Create `packages/runtime/src/bridge-slot.ts`, `wake-intent.ts`, `workflow.ts` plus tests; modify `index.ts`.

**Interfaces:** `deriveBridgeSlotId`, `canTransitionBridgeSlot`, `evaluateProviderProfile`, `canTransitionWakeIntent`, `classifyWakeProcessResult`, `authorizeWorkflowContinuation`.

- [ ] **Step 1: Write failing policy matrices**

```ts
expect(classifyWakeProcessResult({ started: true, exitCode: 1 })).toBe('indeterminate');
expect(canTransitionWakeIntent('dispatching', 'claimed')).toBe(false);
expect(
  authorizeWorkflowContinuation({
    expectedRevision: 3,
    actualRevision: 4,
    expectedWakeIntentId: 'i',
    actualWakeIntentId: 'i',
  }),
).toMatchObject({ allowed: false });
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/runtime/src/bridge-slot.test.ts packages/runtime/src/wake-intent.test.ts packages/runtime/src/workflow.test.ts`

Expected: FAIL because policies are absent.

- [ ] **Step 3: Implement no-side-effect policies**

Allow only `pending→claimed`, `claimed→dispatching|fallback_only|indeterminate`, `dispatching→dispatched|fallback_only|indeterminate`; all post-start uncertainty is indeterminate. Require trusted main Codex `codex-queue-v1` eligibility.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run packages/runtime/src/bridge-slot.test.ts packages/runtime/src/wake-intent.test.ts packages/runtime/src/workflow.test.ts`

Expected: PASS. Commit: `git add packages/runtime && git commit -m "feat(runtime): add wake safety policy"`.

### Task 4: Version Redis v13 keys and isolated Function libraries

**Files:** Modify `packages/redis/src/redis-keys.ts`, `redis-keys.test.ts`, `function-registry.ts`, `function-registry.test.ts`, `function-library.ts`, `function-library.test.ts`, `function-loader.ts`, `function-loader.test.ts`, and `index.ts`.

**Interfaces:** Production registry remains `createFunctionRegistry()` → `luwi_v1`; isolated suites reuse the existing `createFunctionRegistry(runId)` contract, which returns `luwi_test_${runId}_v1` and suffixes every Function name. `buildFunctionLibrary(registry).registry.version` becomes 13. Add declared slot/workflow/wake/index/Stream keys and export `WAKE_CONSUMER_GROUP = 'luwi-wake-v1'` separately because a consumer-group name is not a Redis key.

- [ ] **Step 1: Write failing keys/version/suffix tests**

```ts
expect(createRedisKeys('run-a').wakeStream).toBe('run-a:stream:wake');
const registry = createFunctionRegistry('run_abc');
expect(registry.libraryName).toBe('luwi_test_run_abc_v1');
expect(buildFunctionLibrary(registry).registry.version).toBe(13);
expect(new Set(Object.values(registry.functions)).size).toBe(
  Object.values(registry.functions).length,
);
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/redis/src/redis-keys.test.ts packages/redis/src/function-registry.test.ts packages/redis/src/function-library.test.ts packages/redis/src/function-loader.test.ts`

Expected: FAIL because v13/suffix support is absent.

- [ ] **Step 3: Implement declared keys and validated test suffix**

Keep the existing bounded suffix validation and route the same registry through source generation, compatibility checks, every `FCALL`, and teardown. Tighten loader verification to require the exact registry library name and non-null object reply; remove the legacy `libraryName: 'test'` wildcard. Add exact key constructors for the retained slot projection/private owner, workflow decision receipts, wake indexes/deadlines/Stream, and reject raw or malformed slot digests. Do not register dummy callbacks before their implementation tasks.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run packages/redis/src/redis-keys.test.ts packages/redis/src/function-registry.test.ts packages/redis/src/function-library.test.ts packages/redis/src/function-loader.test.ts`

Expected: PASS. Commit: `git add packages/redis/src && git commit -m "feat(redis): add v13 isolated wake functions"`.

### Task 5: Fence bridge slots inside registration and rotation

**Files:** Create `packages/redis/src/bridge-slots.ts`, tests/integration test; modify `function-library.ts`, `runtime-repository.ts`, native-session tests, `index.ts`.

**Interfaces:** `BridgeSlotRepository.acquire|renew|attachSession|release|expire|list`; session register/rotation takes `BridgeOwnerDeclaration`. Store the expiring private token separately from the retained public slot projection/revision and expiry index so takeover remains monotonic and emits exactly one expiry event.

- [ ] **Step 1: Write failing owner atomicity tests**

```ts
expect(
  (await Promise.all([slots.acquire(left), slots.acquire(right)])).filter(
    (x) => x.status === 'acquired',
  ),
).toHaveLength(1);
await expect(
  runtime.registerSession({ ...registration, bridgeOwner: staleOwner }),
).resolves.toMatchObject({ status: 'bridge_slot_not_owner' });
await expect(
  runtime.registerSession({ ...registration, metadata: { bridge: 'native-headless' } }),
).resolves.toMatchObject({ status: 'reserved_metadata_rejected' });
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/redis/src/bridge-slots.test.ts`

Expected: FAIL because slot repository and atomic registration validation are absent.

- [ ] **Step 3: Implement compare-and-set Functions**

Declare slot/session/link/event/index keys and preflight their types plus event append capacity before any mutation. In register/rotation verify tuple, token, expiry, provider/profile inside the same Function before any session/link write; synthesize reserved `bridge`, `bridgeSlotId`, `provider`, and `executionProfile` metadata there. Heartbeats preserve those fields. Stale renew/release cannot change a winner, and expiry/reacquire cannot lose the prior public revision or emit a duplicate expiry event.

- [ ] **Step 4: Verify isolated Redis and commit boundary**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts packages/redis/src/bridge-slots.integration.test.ts`

Expected: PASS. Commit: `git add packages/redis/src && git commit -m "feat(redis): atomically fence bridge slots"`.

### Task 6: Implement safe provider execution profiles

**Files:** Create `apps/cli/src/provider-execution-profiles.ts` and test; modify `agent-runner.ts`, `native-bridge.ts` and tests.

**Interfaces:** `resolveProviderExecutionProfile(...): ProviderLaunchPlan | ProviderProfileRejection`; plan holds fixed command/args, bounded cwd, overridden LUWI env, `shell: false`.

- [ ] **Step 1: Write failing no-shell tests**

```ts
expect(
  resolveProviderExecutionProfile(
    { ...codexProfile, additionalArgs: ['cmd.exe', '/c'] },
    definition,
    root,
  ),
).toMatchObject({ kind: 'rejected' });
expect(resolveProviderExecutionProfile(geminiProfile, definition, root)).toMatchObject({
  kind: 'rejected',
  reasonCode: 'provider_unsupported',
});
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run apps/cli/src/provider-execution-profiles.test.ts apps/cli/src/agent-runner.test.ts`

Expected: FAIL because strict resolver is absent.

- [ ] **Step 3: Implement fixed measured templates**

Reject shells/shims/free args; Codex uses measured profiles, Claude fixture gate, Gemini and Antigravity return unavailable.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run apps/cli/src/provider-execution-profiles.test.ts apps/cli/src/agent-runner.test.ts apps/cli/src/native-bridge.test.ts`

Expected: PASS. Commit: `git add apps/cli/src && git commit -m "feat(cli): constrain supervised profiles"`.

### Task 7: Atomically create workflow and first message

**Files:** Create `packages/redis/src/workflows.ts`, tests/integration; modify `function-library.ts`, `message-repository.ts`, `index.ts`.

**Interfaces:** `WorkflowRepository.create({ objective, coordinatorSessionId, rootCorrelationId, firstMessage })` returns active workflow revision 1 and first durable request.

- [ ] **Step 1: Write failing first-message atomicity test**

```ts
const result = await workflows.create(input);
expect(result.workflow).toMatchObject({
  revision: 1,
  state: 'active',
  currentMessageId: result.message.id,
});
expect(await messages.get(result.message.id)).toBeDefined();
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/redis/src/workflows.test.ts`

Expected: FAIL because create Function is absent.

- [ ] **Step 3: Implement one Function for workflow plus first durable request**

Validate all workflow/message/index/stream keys before any write; invalid coordinator/target writes neither record; no wake is created.

- [ ] **Step 4: Verify isolated Redis and commit boundary**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts packages/redis/src/workflows.integration.test.ts`

Expected: PASS. Commit: `git add packages/redis/src && git commit -m "feat(redis): atomically create workflow message"`.

### Task 8: Atomically create terminal wake intent

**Files:** Create `packages/redis/src/wake-intents.ts` plus tests/integration; modify `message-repository.ts`, message transition tests, `function-library.ts`, `index.ts`.

**Interfaces:** Terminal transition returns existing terminal state on replay; `WakeIntentRepository.getByMessage` exposes one redacted eligible intent.

- [ ] **Step 1: Write failing terminal atomicity test**

```ts
const terminal = await messages.transitionMessage('responded', input);
expect(await sourceInbox.get(terminal.message.id)).toBeDefined();
expect(await wakeIntents.getByMessage(terminal.message.id)).toMatchObject({ state: 'pending' });
expect(await messages.transitionMessage('responded', input)).toEqual(terminal);
```

Run the same atomicity assertions for `responded`, `rejected`, `failed`, and `timed_out`. Corrupt each newly declared key type and exhaust append capacity for either of the two Runtime events; every preflight failure must leave message, source inbox, workflow, wake projection, wake Stream, and event Stream unchanged.

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/redis/src/wake-intents.test.ts`

Expected: FAIL because terminal wake transition is absent.

- [ ] **Step 3: Extend winning terminal Function atomically**

Refactor the shared `message_transition` preflight/apply path so every terminal outcome uses the same two-event capacity proof. For a trusted eligible source/current workflow message, write projection, source response, terminal event, one wake record, wake Stream ID and `wake.requested` caused by terminal event. If no eligible host wake exists, atomically move the workflow to `waiting_for_human` and mint one bounded continuation token instead of leaving it active without a wake. Persist no content/native ID/token.

- [ ] **Step 4: Verify isolated Redis and commit boundary**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts packages/redis/src/message-transitions.integration.test.ts packages/redis/src/wake-intents.integration.test.ts`

Expected: PASS. Commit: `git add packages/redis/src && git commit -m "feat(redis): atomically create terminal wakes"`.

### Task 9: Claim, recover, and retain wake Stream work

**Files:** Modify `wake-intents.ts`, tests/integration, `message-retention.ts`, retention tests, `function-library.ts`.

**Interfaces:** `createGroupAtZero|claim|reclaim|markDispatching|complete|recoverDispatching|sweep|list`.

- [ ] **Step 1: Write failing recovery test**

```ts
expect(await wakeIntents.reclaim({ minIdleMs })).toMatchObject({ state: 'claimed' });
expect(await wakeIntents.recoverDispatching(intent)).toMatchObject({ state: 'indeterminate' });
expect(await retention.prune()).toMatchObject({ deferredWakeIntentIds: [intent.id] });
```

Also crash after `XAUTOCLAIM` transfers the PEL entry but before claim-state persistence; retry a lost dispatching-fence response; and let an old dispatcher attempt completion after a newer claim. Only the current claim/attempt fence may write, and an uncertain successful fence reply must be reread without launching twice.

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/redis/src/wake-intents.test.ts packages/redis/src/message-retention.test.ts`

Expected: FAIL because safe claim/recovery is absent.

- [ ] **Step 3: Implement state machine and retention**

Use `XREADGROUP BLOCK`/`XAUTOCLAIM`; only claimed reassigns. Fence dispatching with claim/attempt/dispatcher IDs, recover it as indeterminate and acknowledge. Sweep pending/claimed after five minutes to fallback-only and atomically expose the workflow's bounded human continuation token; defer terminal-message cleanup for nonterminal wake; never trim pending/lagging or claim source inbox.

- [ ] **Step 4: Verify isolated Redis and commit boundary**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts packages/redis/src/wake-intents.integration.test.ts packages/redis/src/message-retention.integration.test.ts`

Expected: PASS. Commit: `git add packages/redis/src && git commit -m "feat(redis): recover durable wakes safely"`.

### Task 10: Fence workflow continuation

**Files:** Modify `workflows.ts`, workflow integration/tests, `function-library.ts`, `message-repository.ts`.

**Interfaces:** `WorkflowRepository.continue({ workflowId, expectedRevision, wakeIntentId, coordinatorSessionId, decision })` stores a decision receipt keyed by workflow/revision and returns that committed result on exact replay after any number of later revisions; a conflicting decision at the same revision is rejected without recomputation.

- [ ] **Step 1: Write failing exactly-once test**

```ts
const first = await workflows.continue(nextDecision);
expect(await workflows.continue(nextDecision)).toEqual(first);
expect(await messages.listByWorkflow(first.workflow.id)).toHaveLength(2);
await expect(
  Promise.allSettled([workflows.continue(nextDecision), workflows.continue(conflictingDecision)]),
).resolves.toContainEqual(expect.objectContaining({ status: 'rejected' }));
```

- [ ] **Step 2: Run failing test**

Run: `pnpm exec vitest run packages/redis/src/workflows.test.ts`

Expected: FAIL because continuation Function is absent.

- [ ] **Step 3: Implement expected-revision Function**

Verify active workflow/coordinator/current wake/revision/target; atomically persist the revision decision receipt and create one next message or completed/waiting-for-human state. Permit this while the wake is `dispatching`; a later dispatcher completion updates only delivery history. A stale old wake/revision returns the retained committed outcome, never another child. Test concurrent differing decisions, replay after multiple later revisions, scope mismatch, and failure preflight with zero partial writes.

- [ ] **Step 4: Verify isolated Redis and commit boundary**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts packages/redis/src/workflows.integration.test.ts`

Expected: PASS. Commit: `git add packages/redis/src && git commit -m "feat(redis): fence workflow continuation"`.

### Task 11: Expose daemon bridge, workflow, and wake services

**Files:** Create `apps/daemon/src/bridge-slot-service.ts`, `wake-intent-service.ts`, `workflow-service.ts` and tests; modify `app.ts`, `runtime.ts`, `config.ts` and integration tests.

**Interfaces:** Loopback routes list/acquire/renew/attach/release slots; create/continue workflows; list/claim/dispatching/complete wakes. Claim resolves opaque target only from trusted binding reverse index.

- [ ] **Step 1: Write failing route/redaction tests**

```ts
expect((await app.inject({ method: 'GET', url: '/api/v1/wake-intents' })).body).not.toContain(
  'nativeSessionId',
);
expect(
  (
    await app.inject({
      method: 'POST',
      url: `/api/v1/wake-intents/${id}/dispatching`,
      headers: localJson,
      payload: { claimId, attemptId },
    })
  ).statusCode,
).toBe(200);
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run apps/daemon/src/bridge-slot-service.test.ts apps/daemon/src/wake-intent-service.test.ts apps/daemon/src/workflow-service.test.ts apps/daemon/src/app.test.ts`

Expected: FAIL because services/routes are absent.

- [ ] **Step 3: Implement loopback validation/startup**

Use existing origin/content protection, derive identity from path/claim not body, fail closed for missing/trimmed/subagent/wrong-adapter evidence. Owned startup validates v13, then creates group at `0-0` and starts sweeper; daemon does not spawn.

- [ ] **Step 4: Verify and commit boundary**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts apps/daemon/src/runtime.integration.test.ts`

Expected: PASS. Commit: `git add apps/daemon/src && git commit -m "feat(daemon): serve durable wake APIs"`.

### Task 12: Supervise bridge slots and lifecycle

**Files:** Create `apps/cli/src/wake-supervisor.ts` and test; modify `bridge-daemon.ts`, `native-bridge.ts`, `lifecycle.ts`, `cli.ts`, setup and tests.

**Interfaces:** `createWakeSupervisor().start|stop|status`; `luwi wake serve|start|stop|status`; `luwi setup --wake-autostart|--no-wake-autostart`.

- [ ] **Step 1: Write failing supervisor test**

```ts
await supervisor.start();
expect(daemon.acquireSlot).toHaveBeenCalledBefore(daemon.registerBridgeSession as never);
await daemon.emitRenewalRefused();
expect(worker.stop).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run apps/cli/src/wake-supervisor.test.ts apps/cli/src/lifecycle.test.ts apps/cli/src/cli.test.ts`

Expected: FAIL because supervisor/lifecycle are absent.

- [ ] **Step 3: Implement ownership-first process control**

Acquire before atomic register and await slot attachment after every guarded rotation before inbox polling. Stand by on held; a missing session backs off without spinning. Renew every five seconds and stop the dedicated cancellable blocking-claim connection, child, and session on lost ownership. Receipts enforce identity stop; serve waits bounded daemon readiness; Windows uses a hidden background process and fixed `schtasks /SC ONLOGON` arguments with no shell, while other operating systems report autostart unsupported.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run apps/cli/src/wake-supervisor.test.ts apps/cli/src/native-bridge.test.ts apps/cli/src/lifecycle.test.ts apps/cli/src/cli.test.ts`

Expected: PASS. Commit: `git add apps/cli/src && git commit -m "feat(cli): supervise wake lifecycle"`.

### Task 13: Dispatch Codex wakes and expose MCP workflow tools

**Files:** Create `apps/cli/src/coordinator-wake.ts` and test; modify `packages/adapters/src/native-identity.ts`, `native-identity-disk.ts` and tests, `packages/runtime/src/session-bootstrap.ts` and tests, `apps/cli/src/cli.ts`, CLI daemon client and tests, and `apps/mcp-server/src/daemon-client.ts`, `tools.ts` and tests.

**Interfaces:** `createCoordinatorWakeDispatcher().runOnce|recover`; environment/launcher native resolution returns `{ ref, provenance: { source: 'host_launcher', launcherInstanceId } }`, disk fallback returns `{ ref, provenance: { source: 'filesystem_heuristic' } }`; session bootstrap carries exact provenance and optional host-wake declaration to the daemon; MCP `luwi_create_workflow`, `luwi_continue_workflow` are thin bound-session calls.

- [ ] **Step 1: Write failing exact-command tests**

```ts
expect(spawn).toHaveBeenCalledWith(
  'codex',
  ['queue', '--thread', 'native-session', '--message', expectedPrompt],
  expect.objectContaining({ shell: false }),
);
expect(await dispatcher.runOnce()).toMatchObject({ state: 'indeterminate' });
expect(resolveNativeIdentityFromDisk(fixture)).toMatchObject({
  provenance: { source: 'filesystem_heuristic' },
});
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run packages/adapters/src/native-identity.test.ts packages/adapters/src/native-identity-disk.test.ts packages/runtime/src/session-bootstrap.test.ts apps/cli/src/coordinator-wake.test.ts apps/cli/src/cli.test.ts apps/mcp-server/src/daemon-client.test.ts apps/mcp-server/src/tools.test.ts`

Expected: FAIL because dispatcher/MCP tools are absent.

- [ ] **Step 3: Implement fence then no-shell queue**

Propagate resolver provenance without upgrading filesystem evidence; accept `hostWakeAdapter: 'codex-queue-v1'` only from the exact launcher path and bind its `mcpSessionId` to the registering LUWI session. Atomically mark dispatching before spawn. Fixed prompt points to `luwi_get_message`; pre-spawn proven failure is fallback-only, zero dispatched, timeout/signal/nonzero-after-start/lost handle/lost owner indeterminate and never replay. MCP never consumes Stream or starts processes.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run packages/adapters/src/native-identity.test.ts packages/adapters/src/native-identity-disk.test.ts packages/runtime/src/session-bootstrap.test.ts apps/cli/src/coordinator-wake.test.ts apps/cli/src/cli.test.ts apps/mcp-server/src/daemon-client.test.ts apps/mcp-server/src/tools.test.ts`

Expected: PASS. Commit: `git add packages/adapters/src packages/runtime/src/session-bootstrap* apps/cli/src apps/mcp-server/src && git commit -m "feat: dispatch trusted Codex wakes"`.

### Task 14: Add redacted read-only Pulse observability

**Files:** Create `apps/dashboard/src/api/wake-scope.ts` and test; modify Pulse API/model/view/styles/tests and `product-independence.test.ts`.

**Interfaces:** `WakeScope` has only public facts; Runtime shows supervisor/slot counts/age, Sessions/Messages show profile/health/routing/wake and inbox-only explanation.

- [ ] **Step 1: Write failing UI/redaction test**

```tsx
render(<PulseView snapshot={indeterminateWake} />);
expect(
  screen.getByText('Wake outcome is indeterminate; read the durable inbox response.'),
).toBeVisible();
expect(screen.queryByText('native-session-secret')).not.toBeInTheDocument();
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm exec vitest run apps/dashboard/src/api/wake-scope.test.ts apps/dashboard/src/pulse/model.test.ts apps/dashboard/src/pulse/pulse-view.test.tsx apps/dashboard/src/product-independence.test.ts`

Expected: FAIL because wake read model is absent.

- [ ] **Step 3: Implement reads only**

Render all states, stale data, duplicate warning, keyboard detail and HTTP reload parity. Add no start/stop/retry/release and no dashboard mutation module.

- [ ] **Step 4: Verify and commit boundary**

Run: `pnpm exec vitest run apps/dashboard/src/api/wake-scope.test.ts apps/dashboard/src/api/pulse.test.ts apps/dashboard/src/pulse/model.test.ts apps/dashboard/src/pulse/pulse-view.test.tsx apps/dashboard/src/product-independence.test.ts && pnpm --filter @luwi/dashboard typecheck`

Expected: PASS. Commit: `git add apps/dashboard/src && git commit -m "feat(dashboard): observe redacted wakes"`.

### Task 15: Prove recovery across daemon and CLI

**Files:** Create daemon/CLI wake dispatch integration tests; modify runtime integration tests.

**Interfaces:** Fake queue-spawn seam drives real daemon/Redis/client composition without vendors.

- [ ] **Step 1: Write failing recovery suite**

```ts
await terminalResponder.respond(message);
expect(await eventually(() => fakeQueue.calls.length)).toBe(1);
await killDispatcherAfterDispatching();
expect(await wakeIntents.get(intent.id)).toMatchObject({ state: 'indeterminate' });
```

Cover invalid binding fallback, WebSocket disconnect, restart from `0-0`, claimed reclaim, no dispatching replay, two supervisors, TTL stale token, source inbox untouched.

- [ ] **Step 2: Run failing isolated suite**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts apps/daemon/src/wake-dispatch.integration.test.ts apps/cli/src/wake-supervisor.integration.test.ts apps/cli/src/coordinator-wake.integration.test.ts`

Expected: FAIL until composition is wired.

- [ ] **Step 3: Wire tested seams only**

Retain no-daemon-spawn and no-uncertain-retry invariants.

- [ ] **Step 4: Verify and commit boundary**

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm exec vitest run --config vitest.integration.config.ts apps/daemon/src/wake-dispatch.integration.test.ts apps/cli/src/wake-supervisor.integration.test.ts apps/cli/src/coordinator-wake.integration.test.ts`

Expected: PASS. Commit: `git add apps/daemon/src apps/cli/src && git commit -m "test: prove wake dispatcher recovery"`.

### Task 16: Run isolated full verification and live acceptance

**Files:** Create `scripts/wake-live-acceptance.mjs` and `docs/runtime/event-driven-wake-dispatcher-acceptance.md`; modify `README.md`, `docs/decisions/0031-native-inbox-bridge.md`.

**Interfaces:** Document disabled-by-default rollout, per-binding `enabled: true`, v13 coordinated release, redacted evidence.

- [ ] **Step 1: Run automated gate**

Run: `pnpm format:write && pnpm lint && pnpm typecheck && pnpm test`

Expected: PASS.

Run: `$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6391'; $env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS='true'; pnpm test:integration`

Expected: PASS with only the isolated namespace/library touched.

- [ ] **Step 2: Record live checklist before run**

Record timestamps/opaque IDs/state/provider/profile/commit/test only. Exercise trusted Codex coordinator; Claude workspace-write lease/edit/test/commit; one wake/queue; continuation/replay; WebSocket disconnect; restart from `0-0`; kill dispatching; two supervisors; sleep TTL; Pulse reload/realtime. Never record content/native IDs/tokens/argv/paths/output.

- [ ] **Step 3: Run disposable live proof**

Implement `scripts/wake-live-acceptance.mjs` so it creates a disposable registered project and worktree at the supplied workspace, generates its own opaque namespace, starts the wake supervisor, executes the scripted assertions, and always removes only resources whose returned IDs and paths match that run.

Run: `pnpm build`

Expected: PASS.

Run: `node scripts/wake-live-acceptance.mjs --redis-url redis://127.0.0.1:6391 --workspace C:/xampp/htdocs/luwiruntime/.worktrees/wake-acceptance-fixture`

Expected: one owner/child or explicit standby/degraded, followed by the scripted durable wake/continuation evidence. Enable Gemini only after safe sandbox/no-shell/scoped-write/lease/response proof; prove Antigravity unavailable.

- [ ] **Step 4: Final verification and commit boundary**

Run: `pnpm build && pnpm lint && pnpm typecheck && pnpm test`

Expected: PASS. Verify disabled supervision preserves manual inbox/direct session/explicit bridge. Commit only after authorized checks: `git add README.md docs/runtime/event-driven-wake-dispatcher-acceptance.md docs/decisions/0031-native-inbox-bridge.md && git commit -m "docs: record wake dispatcher acceptance"`.
