# CLI Runtime Reset and Project Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe CLI-first LUWI runtime-state reset and dry-run-first project discovery flow,
then use them to rebuild the approved ten-project local installation without touching other Redis
keys or project files.

**Architecture:** Redis namespace enumeration/deletion lives in `@luwi/redis` and is invoked only by
an `@luwi/daemon` maintenance entry point; the CLI remains a lifecycle orchestrator and HTTP client.
Filesystem-canonical projects are restored into Redis before dependent control-plane reconciliation.
Project discovery is a passive, one-level CLI service whose apply path uses the existing daemon HTTP
API.

**Tech Stack:** Node.js 22+, TypeScript strict ESM, Commander, Zod, Fastify HTTP client surface,
official `redis` client behind `@luwi/redis`, Vitest, pnpm.

## Global Constraints

- Delete only keys beginning with the compile-time production namespace `luwi:v1:`.
- Never use `FLUSHDB`, `FLUSHALL`, `KEYS`, volume deletion, container removal, or database changes.
- Preserve `LUWI_HOME`, canonical project IDs, native agent files, and every project/Git file.
- The CLI and project discovery service never connect to Redis.
- Discovery is immediate-child-only, dry-run by default, and requires explicit exclusions.
- No production dependency or datastore may be added.
- Use failing tests before every production behavior change.
- Do not commit, stage, push, or create a branch unless the user explicitly asks.

---

## File map

- `packages/redis/src/runtime-reset.ts`: bounded SCAN validation and UNLINK batches.
- `packages/redis/src/runtime-reset.test.ts`: parser, namespace, no-op, and partial-failure unit tests.
- `packages/redis/src/runtime-reset.integration.test.ts`: sentinel-preservation proof on an explicit
  test Redis database.
- `packages/redis/src/index.ts`: public maintenance export for the daemon boundary.
- `apps/daemon/src/runtime-reset-main.ts`: fixed-production-namespace maintenance executable.
- `apps/daemon/src/runtime-reset-main.test.ts`: safe arguments, result, and connection-close tests.
- `packages/redis/src/runtime-repository.ts`: canonical timestamp-aware project registration input.
- `packages/redis/src/function-library.ts`: validate and retain canonical project timestamps.
- `packages/redis/src/function-library.test.ts`: generated Redis Function contract tests.
- `apps/daemon/src/canonical-store.ts`: expose validated tracked projects.
- `apps/daemon/src/project-service.ts`: reconcile canonical projects into missing Redis projections.
- `apps/daemon/src/project-service.test.ts`: unchanged, restored, path mismatch, and identity conflict.
- `apps/daemon/src/runtime.ts`: run project restore before dependent reconciliation.
- `apps/daemon/src/runtime.test.ts`: startup ordering assertion.
- `apps/cli/src/lifecycle.ts`: stopped-daemon reset orchestration and confirmation rules.
- `apps/cli/src/lifecycle.test.ts`: lifecycle lock, daemon refusal, preview, confirmation, and apply.
- `apps/cli/src/project-discovery.ts`: passive one-level discovery plan.
- `apps/cli/src/project-discovery.test.ts`: selection, exclusions, names, boundaries, and idempotency.
- `apps/cli/src/cli.ts`: `reset --runtime-state` and `project discover` commands.
- `apps/cli/src/cli.test.ts`: human/JSON command contracts and HTTP mutation assertions.
- `apps/cli/src/index.ts`: public service/result type exports.
- `README.md`: clean-install command sequence and safety statement.
- `docs/guides/cli-lifecycle.md`: reset recovery and PowerShell discovery examples.
- `docs/architecture/overview.md`: maintenance boundary and canonical project restore ordering.

---

### Task 1: Restore canonical projects before dependent projections

**Files:**

- Modify: `packages/redis/src/runtime-repository.ts`
- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/function-library.test.ts`
- Modify: `apps/daemon/src/canonical-store.ts`
- Modify: `apps/daemon/src/project-service.ts`
- Modify: `apps/daemon/src/project-service.test.ts`
- Modify: `apps/daemon/src/runtime.ts`
- Modify: `apps/daemon/src/runtime.test.ts`

**Interfaces:**

- Produces: `CanonicalStore.loadTrackedProjects(): Promise<Project[]>`.
- Produces:
  `ProjectService.reconcileCanonical(projects: readonly Project[]): Promise<{ rebuilt: number; unchanged: number }>`.
- Extends `RegisterProjectInput.project` with optional canonical `createdAt` and `updatedAt` strings.

- [x] **Step 1: Write failing project-service tests**

Add tests proving that a missing projection is registered with the canonical ID/timestamps and that
an identical projection is unchanged:

```ts
await expect(service.reconcileCanonical([canonicalProject])).resolves.toEqual({
  rebuilt: 1,
  unchanged: 0,
});
expect(registeredInput.project).toMatchObject({
  id: canonicalProject.id,
  createdAt: canonicalProject.createdAt,
  updatedAt: canonicalProject.updatedAt,
});

await expect(matchingService.reconcileCanonical([canonicalProject])).resolves.toEqual({
  rebuilt: 0,
  unchanged: 1,
});
```

Add tests that a canonicalized path mismatch, an existing same-ID/different-facts projection, and a
path owned by another ID reject with `CONFIG_RECONCILIATION_REQUIRED`.

- [x] **Step 2: Run the project-service tests and verify RED**

Run:

```text
.\node_modules\.bin\vitest.cmd run apps/daemon/src/project-service.test.ts
```

Expected: failure because `reconcileCanonical` does not exist.

- [x] **Step 3: Add timestamp-preserving Redis registration tests and verify RED**

Assert the generated project Function uses supplied canonical timestamps only when both are valid
strings and otherwise uses the Redis clock. Assert the repository sends those optional fields in the
validated JSON payload.

Run:

```text
.\node_modules\.bin\vitest.cmd run packages/redis/src/function-library.test.ts packages/redis/src/runtime-repository.test.ts
```

Expected: failure because canonical timestamps are not retained.

- [x] **Step 4: Implement canonical project reconciliation**

Expose tracked projects from the canonical store, then implement:

```ts
async reconcileCanonical(projects) {
  let rebuilt = 0;
  let unchanged = 0;
  for (const project of projects) {
    const canonical = await canonicalizePath(project.localPath);
    if (!sameCanonicalPath(canonical.canonicalPath, project.canonicalPath)) {
      throw new ApplicationError(
        'CONFIG_RECONCILIATION_REQUIRED',
        'A canonical project path no longer matches the filesystem.',
        503,
        { projectId: project.id },
      );
    }
    const current = await options.repository.getProject(project.id);
    if (current !== null) {
      if (!sameProjectFacts(current, project)) throw reconciliationError(project.id);
      unchanged += 1;
      continue;
    }
    const result = await options.repository.registerProject({
      project: {
        ...project,
        identityPath: canonical.identityPath,
        pathIdentityHash: canonical.pathIdentityHash,
      },
      workspaceId: options.workspaceId,
      eventId: createId(),
    });
    if (result.status !== 'created') throw reconciliationError(project.id);
    rebuilt += 1;
  }
  return { rebuilt, unchanged };
}
```

Modify `project_register` so a restore payload with both validated `createdAt` and `updatedAt`
stores them; normal registration still uses the Redis clock. The emitted reconciliation registration
event occurs at the Redis clock and carries the restored project payload.

- [x] **Step 5: Order startup reconciliation**

Before `controlPlaneService.reconcileCanonicalState()`:

```ts
await projectService.reconcileCanonical(await canonicalStore.loadTrackedProjects());
for (const project of await projectService.list()) await canonicalStore.trackProject(project);
await controlPlaneService.reconcileCanonicalState();
```

Add a runtime test proving project restoration completes before project-agent binding projection.

- [x] **Step 6: Run targeted tests and verify GREEN**

Run:

```text
.\node_modules\.bin\vitest.cmd run apps/daemon/src/project-service.test.ts apps/daemon/src/runtime.test.ts packages/redis/src/function-library.test.ts packages/redis/src/runtime-repository.test.ts
```

Expected: all selected files pass.

---

### Task 2: Add bounded Redis namespace reset maintenance

**Files:**

- Create: `packages/redis/src/runtime-reset.ts`
- Create: `packages/redis/src/runtime-reset.test.ts`
- Create: `packages/redis/src/runtime-reset.integration.test.ts`
- Modify: `packages/redis/src/index.ts`
- Create: `apps/daemon/src/runtime-reset-main.ts`
- Create: `apps/daemon/src/runtime-reset-main.test.ts`

**Interfaces:**

- Produces:
  `inspectRuntimeNamespace(client, options): Promise<{ namespace: string; matched: number }>`.
- Produces:
  `resetRuntimeNamespace(client, options): Promise<{ namespace: string; matched: number; deleted: number; status: 'reset' | 'empty' }>`.
- Production entry always supplies `namespace: 'luwi:v1:'`; only tests may inject a unique prefix.

- [x] **Step 1: Write failing unit tests for SCAN validation**

Use an injected `RedisCommandClient` and assert the exact command sequence:

```ts
expect(commands[0]).toEqual(['SCAN', '0', 'MATCH', 'luwi:v1:*', 'COUNT', '500']);
expect(commands).not.toContainEqual(expect.arrayContaining(['KEYS']));
expect(commands).not.toContainEqual(expect.arrayContaining(['FLUSHDB']));
```

Test multi-page cursors, duplicate-key de-duplication, malformed replies, a returned key outside the
namespace, empty results, bounded `UNLINK` batches, and a failure after one completed batch.

- [x] **Step 2: Run unit tests and verify RED**

Run:

```text
.\node_modules\.bin\vitest.cmd run packages/redis/src/runtime-reset.test.ts
```

Expected: module-not-found failure.

- [x] **Step 3: Implement the reset service**

Use a strict SCAN parser:

```ts
function parseScanReply(value: unknown): { cursor: string; keys: string[] } {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    !Array.isArray(value[1]) ||
    !value[1].every((key) => typeof key === 'string')
  ) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid SCAN reply.');
  }
  return { cursor: value[0], keys: value[1] };
}
```

Validate every key with `startsWith(namespace)`. Use `UNLINK` with at most 100 validated keys per
command. Track completed deletions and rethrow a typed partial result without attempting rollback.

- [x] **Step 4: Write the daemon maintenance entry test and verify RED**

Test `runRuntimeResetMain({ argv, environment, connect, stdout })` with `--inspect` and `--apply`.
Assert that unknown arguments and a caller-provided namespace are rejected, JSON is bounded, and the
connection closes on success or failure.

- [x] **Step 5: Implement the fixed-namespace daemon entry**

```ts
export const PRODUCTION_RUNTIME_NAMESPACE = 'luwi:v1:';

export async function runRuntimeResetMain(dependencies = defaultDependencies): Promise<void> {
  const mode = parseMode(dependencies.argv);
  const connection = createManagedRedisConnection({ url: validatedLoopbackRedisUrl });
  try {
    await connection.connect();
    const result =
      mode === 'inspect'
        ? await inspectRuntimeNamespace(connection, { namespace: PRODUCTION_RUNTIME_NAMESPACE })
        : await resetRuntimeNamespace(connection, { namespace: PRODUCTION_RUNTIME_NAMESPACE });
    dependencies.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await closeConnection(connection);
  }
}
```

- [x] **Step 6: Add sentinel integration coverage**

With explicit `LUWI_TEST_REDIS_URL` and a per-run prefix, seed two matching keys and one unrelated
sentinel. Reset the matching prefix and prove the sentinel value is unchanged. Clean only keys
created by that test run.

- [ ] **Step 7: Run targeted unit tests and optional integration test**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run:

```text
.\node_modules\.bin\vitest.cmd run packages/redis/src/runtime-reset.test.ts apps/daemon/src/runtime-reset-main.test.ts
```

Then, when an explicit dedicated test URL is available:

```text
$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6379/15'
.\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts packages/redis/src/runtime-reset.integration.test.ts
```

Expected: matching test keys are gone and the unrelated sentinel survives.

---

### Task 3: Add lifecycle reset orchestration and CLI command

**Files:**

- Modify: `apps/cli/src/lifecycle.ts`
- Modify: `apps/cli/src/lifecycle.test.ts`
- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`
- Modify: `apps/cli/src/index.ts`

**Interfaces:**

- Produces:
  `LifecycleService.resetRuntimeState(options: { approved: boolean; interactive: boolean }): Promise<RuntimeResetResult>`.
- `RuntimeResetResult.status` is `confirmation_required | cancelled | reset | empty`.

- [x] **Step 1: Write lifecycle RED tests**

Add tests proving reset refuses a ready daemon, foreign listener, invalid owner, and busy lifecycle
lock. Verify it derives `apps/daemon/dist/runtime-reset-main.js`, runs `--inspect` first, and does not
run `--apply` when confirmation is denied or JSON mode lacks `--yes`.

- [x] **Step 2: Run lifecycle tests and verify RED**

Run:

```text
.\node_modules\.bin\vitest.cmd run apps/cli/src/lifecycle.test.ts
```

Expected: failure because `resetRuntimeState` is absent.

- [x] **Step 3: Implement lifecycle orchestration**

Inside the existing lifecycle lock:

```ts
const runtime = await fetchRuntime(config.daemonUrl);
if (runtime !== undefined || (await endpointPortOpen(config.daemonUrl))) {
  throw new ApplicationError(
    'DAEMON_MUST_BE_STOPPED',
    'Stop the LUWI daemon before resetting runtime state.',
    409,
  );
}
const preview = await runResetMaintenance(config, 'inspect');
if (!options.approved && !options.interactive) {
  return { ...preview, deleted: 0, status: 'confirmation_required' };
}
if (!options.approved && !(await dependencies.confirm(resetPrompt(preview)))) {
  return { ...preview, deleted: 0, status: 'cancelled' };
}
return await runResetMaintenance(config, 'apply');
```

Parse maintenance stdout through a strict local schema and never return stderr details to users.

- [x] **Step 4: Add CLI RED tests**

Assert:

```ts
await runCli(['reset', '--runtime-state', '--json'], dependencies);
expect(lifecycle.resetRuntimeState).toHaveBeenCalledWith({ approved: false, interactive: false });

await runCli(['reset', '--runtime-state', '--yes'], dependencies);
expect(lifecycle.resetRuntimeState).toHaveBeenCalledWith({ approved: true, interactive: true });
```

Also assert `reset` without `--runtime-state` fails command parsing and that human output prints the
fixed namespace and matched/deleted counts.

- [x] **Step 5: Implement and export the CLI command**

Register:

```ts
program
  .command('reset')
  .requiredOption('--runtime-state', 'Reset only the fixed LUWI Redis runtime namespace')
  .option('--yes', 'Approve the fixed namespace deletion')
  .option('--json', 'Print machine-readable output without prompting')
  .action(async (options) => {
    const result = await dependencies.lifecycle.resetRuntimeState({
      approved: options.yes === true,
      interactive: options.json !== true,
    });
    printResetResult(dependencies, result, options.json === true);
  });
```

- [x] **Step 6: Run lifecycle and CLI tests GREEN**

Run:

```text
.\node_modules\.bin\vitest.cmd run apps/cli/src/lifecycle.test.ts apps/cli/src/cli.test.ts
```

Expected: all selected tests pass.

---

### Task 4: Add passive project discovery and idempotent apply

**Files:**

- Create: `apps/cli/src/project-discovery.ts`
- Create: `apps/cli/src/project-discovery.test.ts`
- Modify: `apps/cli/src/cli.ts`
- Modify: `apps/cli/src/cli.test.ts`
- Modify: `apps/cli/src/index.ts`

**Interfaces:**

- Produces `ProjectDiscoveryService.createPlan(input): Promise<ProjectDiscoveryPlan>`.
- Produces `ProjectDiscoveryPlan.selected/excluded/invalid` arrays with canonical paths.
- Existing canonical paths carry `existingProjectId` and preserve the registered display name.

- [x] **Step 1: Write discovery RED tests**

Use an injected filesystem and assert immediate-child-only enumeration, exact Windows exclusions,
escaping-link rejection, unreadable classification, deterministic ordering, existing-name
preservation, and exact name overrides.

Include the approved fixture and expect exactly:

```ts
expect(plan.selected.map(({ displayName }) => displayName)).toEqual([
  'Arsha Homes',
  'Corenine',
  'Fly by Deniz',
  'Glasshouse',
  'LUWI Dev',
  'LUWI Listing',
  'LUWI Press',
  'LUWI Runtime',
  'LUWI Studio',
  'Semantic Bridge',
]);
```

- [x] **Step 2: Run discovery tests and verify RED**

Run:

```text
.\node_modules\.bin\vitest.cmd run apps/cli/src/project-discovery.test.ts
```

Expected: module-not-found failure.

- [x] **Step 3: Implement the passive discovery service**

The Node filesystem adapter uses `readdir(root, { withFileTypes: true })` and `realpath` only. It
rejects selected real paths outside the canonical root. Exclusion/name keys are basenames, not
paths or globs.

```ts
export type ProjectDiscoveryPlan = {
  root: string;
  selected: ProjectCandidate[];
  excluded: ProjectCandidate[];
  invalid: ProjectCandidate[];
};
```

Match existing projects by platform-normalized canonical path before applying name overrides.

- [x] **Step 4: Write CLI dry-run/apply RED tests**

Assert dry-run calls only `GET /api/v1/projects`. Apply registers only new candidates through
`POST /api/v1/projects`, treats existing paths as unchanged, captures safe 409 conflicts, and calls
the existing Git scan route for selected registered IDs. A Git 404 for `glasshouse` is classified as
`not_git`, not a registration failure.

- [x] **Step 5: Implement the `project discover` command**

Register repeated exact options and use JSON for the unambiguous first version:

```text
luwi project discover C:\xampp\htdocs \
  --exclude dashboard --exclude img --exclude webalizer --exclude xampp \
  --exclude luwi-clients --exclude luwi-themes-inspect \
  --apply --json
```

For PowerShell documentation, show backticks rather than POSIX backslashes. Dry-run prints the full
plan; `--apply` prints `registered`, `unchanged`, `conflict`, `failed`, and Git observation outcomes.

- [x] **Step 6: Run discovery and CLI tests GREEN**

Run:

```text
.\node_modules\.bin\vitest.cmd run apps/cli/src/project-discovery.test.ts apps/cli/src/cli.test.ts
```

Expected: all selected tests pass.

---

### Task 5: Document and run the complete quality gate

**Files:**

- Modify: `README.md`
- Modify: `docs/guides/cli-lifecycle.md`
- Modify: `docs/architecture/overview.md`

- [x] **Step 1: Document the exact clean-install flow**

Include human-reviewed commands for doctor, stop, reset preview/approval, setup, start, discovery
dry-run/apply, agent verification, Git observations, and smoke testing. State that runtime reset is
destructive to LUWI history but preserves every non-LUWI Redis key and all files.

- [x] **Step 2: Run formatting and diff checks**

Run:

```text
pnpm.cmd format
git diff --check
```

Expected: both exit 0.

- [x] **Step 3: Run static and unit verification in parallel**

Run:

```text
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
```

Expected: all exit 0 with zero failed tests.

- [ ] **Step 4: Run relevant Redis integration verification**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Use dedicated database 15 and the test's unique prefix:

```text
$env:LUWI_TEST_REDIS_URL='redis://127.0.0.1:6379/15'
pnpm.cmd test:integration
```

Expected: all Redis integration tests pass without flushing or touching unrelated keys.

- [ ] **Step 5: Run the production build**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run:

```text
pnpm.cmd build
```

Expected: dashboard and TypeScript builds exit 0.

---

### Task 6: Perform the approved live clean installation together

**Files/data:**

- Preserve: `C:\xampp\htdocs\luwiruntime\temp\live-home\manifest.json`
- Mutate only: Redis keys matching `luwi:v1:*`
- Read only: immediate children of `C:\xampp\htdocs` and their Git metadata

- [ ] **Step 1: Capture the pre-reset evidence**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run `doctor --json`, `status --json`, `project list`, and `agent list`. Parse the canonical manifest
and record the exact ten project IDs. Do not print secrets or full environment state.

- [ ] **Step 2: Stop the owned daemon**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run:

```text
node apps\cli\dist\main.js stop
```

Verify `status --json` reports `daemon.state: stopped` before reset.

- [ ] **Step 3: Preview and apply only the LUWI namespace reset**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run:

```text
node apps\cli\dist\main.js reset --runtime-state --json
node apps\cli\dist\main.js reset --runtime-state --yes --json
```

Verify the first returns `confirmation_required` with `deleted: 0`; the second returns
`reset` or `empty`, namespace `luwi:v1:`, and no command exposes a caller-controlled prefix.

- [ ] **Step 4: Start and verify canonical project restoration**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run setup/start/status. Compare post-start API project IDs, names, and paths with the pre-reset
manifest; require exact equality for all ten.

- [ ] **Step 5: Run discovery dry-run together**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Use these exact exclusions:

```text
dashboard, img, webalizer, xampp, luwi-clients, luwi-themes-inspect
```

Show the ten selected projects to the user before `--apply`. Require zero unexpected candidates.

- [ ] **Step 6: Apply the approved discovery plan**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Expect all restored paths to classify as `unchanged`, with no duplicate registration. Verify the
four XAMPP directories and two LUWI Press spillover directories remain absent from the project API.

- [ ] **Step 7: Verify Git and agents**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Require nine successful Git observations, one explicit `not_git` result for Glasshouse, and
filesystem-restored Codex, Claude, and Gemini definitions.

- [ ] **Step 8: Run the three-agent smoke flow and final health checks**

_not performed in this tranche — the definition-of-done sequence is re-run under `docs/superpowers/plans/2026-09-01-completion-program.md`; the integration/live proof is carried there._

Run the existing bounded three-agent request/reply smoke flow, then verify daemon ready, Redis
connected, ten projects, three agents, and dashboard/API visibility. Report all limitations and do
not commit.
