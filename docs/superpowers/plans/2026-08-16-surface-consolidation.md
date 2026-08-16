# Surface Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the four product surfaces (CLI, REST, MCP, dashboard) to a consistent, finished state: land the built-but-uncommitted project evidence drawer, give the CLI the lease commands it is missing, document the MCP registration path, disambiguate `config/reconcile` in the docs, and close the drawer's interaction seams.

**Architecture:** No new domains and no new routes. WS2 adds a CLI command family over five existing lease routes, copying the exact command pattern already in `apps/cli/src/cli.ts`. WS5 extracts the uncommitted drawer JSX into a small component that adopts the docked inspector's Escape-and-focus contract. Everything else is verification and documentation.

**Tech Stack:** commander (CLI), zod schemas from `@luwi/protocol`, React + vitest + testing-library (dashboard), pnpm scripts.

## Global Constraints

- **Commits happen ONLY in Task 1 (checkpoint) and Task 8 (phase end).** AGENTS.md §13 forbids unprompted commits; the owner pre-approved exactly these two with the plan. No per-task commits.
- **Never claim a command passed without running it** (§19). Report failures verbatim.
- `AGENTS.md` is in `.prettierignore` and must be edited only with the Edit tool — a scripted rewrite leaves CRLF behind.
- `pnpm test` already includes the dashboard tests; `tsc -b` alone does NOT cover `apps/dashboard` (typecheck and build each have a separate dashboard leg).
- Bash tool is Git Bash; PowerShell is a separate tool. Do not mix syntaxes.
- The CLI invents no field and derives no holder: every lease flag maps 1:1 onto a `@luwi/protocol` request-schema field.
- A lease denial is a success (HTTP 200, exit 0) — the runtime answered correctly.

---

### Task 1: Land the drawer (verify + checkpoint commit)

The five modified dashboard files hold a finished, owner-requested change: project evidence docks into the third column as a drawer instead of rendering below the registry. Its tests exist and pass. This task runs the full §19 sequence and creates the recovery point.

**Files:**

- Commit (already modified, do not edit): `apps/dashboard/src/app.tsx`, `apps/dashboard/src/app.test.tsx`, `apps/dashboard/src/projects/projects-view.tsx`, `apps/dashboard/src/styles/activity.css`, `apps/dashboard/src/styles/pulse.css`
- Commit (new): `docs/superpowers/specs/2026-08-16-surface-consolidation-design.md`, `docs/superpowers/plans/2026-08-16-surface-consolidation.md`

**Interfaces:**

- Produces: committed baseline; the drawer markup in `app.tsx` (aside `.inspector.inspector--drawer`, aria-label "Project evidence", close button aria-label "Close project evidence") that Task 7 refactors.

- [ ] **Step 1: Run the §19 sequence in order**

```bash
cd c:/xampp/htdocs/luwiruntime
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: every leg green. If `pnpm format` fails on the two new docs, run `pnpm format:write` and re-run the sequence from the top. Any other failure: stop, diagnose with superpowers:systematic-debugging, do not commit red.

- [ ] **Step 2: Commit the checkpoint**

```bash
git add apps/dashboard/src/app.tsx apps/dashboard/src/app.test.tsx apps/dashboard/src/projects/projects-view.tsx apps/dashboard/src/styles/activity.css apps/dashboard/src/styles/pulse.css docs/superpowers/specs/2026-08-16-surface-consolidation-design.md docs/superpowers/plans/2026-08-16-surface-consolidation.md
git commit -m "feat: dock project evidence into the third column as a drawer

The registry stays put; scoped evidence no longer renders below the table.
Also records the surface-consolidation spec and plan.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CLI `lease acquire`

**Files:**

- Modify: `apps/cli/src/cli.ts` (imports at line 1; new `lease` command block after the `inbox` block, before `events` at ~line 1178)
- Test: `apps/cli/src/cli.test.ts` (new describe block at end of file)

**Interfaces:**

- Consumes: `leaseAcquireResponseSchema` from `@luwi/protocol`; `request`, `jsonBody`, `printJson` helpers already in `cli.ts`.
- Produces: `const leases = program.command('lease')` subcommand group that Tasks 3–4 extend; the `heldLease` test fixture Tasks 3–4 reuse.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/src/cli.test.ts`:

```ts
describe('lease commands', () => {
  const heldLease = {
    id: 'lease-1',
    projectId: 'p1',
    sessionId: 's1',
    agentId: 'codex-main',
    path: 'src/app.ts',
    matchPath: 'src/app.ts/',
    reason: 'editing the shell',
    state: 'held',
    acquiredAt: '2026-08-16T08:00:00.000Z',
    expiresAt: '2026-08-16T08:05:00.000Z',
  };

  it('acquires a lease through the daemon and prints the grant', async () => {
    let requestedUrl = '';
    let requestedBody: unknown;
    let output = '';
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url, init) => {
        requestedUrl = url;
        requestedBody = JSON.parse(init?.body ?? '{}');
        return response({ status: 'granted', lease: heldLease }, { status: 201 });
      },
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(
      [
        'lease',
        'acquire',
        '--project',
        'p1',
        '--session',
        's1',
        '--path',
        'src/app.ts',
        '--reason',
        'editing the shell',
      ],
      dependencies,
    );

    expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases');
    expect(requestedBody).toEqual({
      projectId: 'p1',
      sessionId: 's1',
      path: 'src/app.ts',
      reason: 'editing the shell',
    });
    expect(JSON.parse(output)).toEqual({ status: 'granted', lease: heldLease });
  });

  it('prints a denial as a successful answer, with the holder named', async () => {
    let output = '';
    const denied = {
      status: 'denied',
      conflict: {
        leaseId: 'lease-9',
        sessionId: 's2',
        agentId: 'claude-main',
        path: 'src',
        reason: 'refactoring the tree',
        expiresAt: '2026-08-16T08:10:00.000Z',
      },
    };
    const dependencies: Partial<CliDependencies> = {
      fetch: async () => response(denied),
      stdout: {
        write: (text) => {
          output += text;
        },
      },
    };

    await runCli(
      [
        'lease',
        'acquire',
        '--project',
        'p1',
        '--session',
        's1',
        '--path',
        'src/app.ts',
        '--reason',
        'edit',
      ],
      dependencies,
    );

    expect(JSON.parse(output)).toEqual(denied);
  });

  it('passes an explicit duration through to the daemon', async () => {
    let requestedBody: unknown;
    const dependencies: Partial<CliDependencies> = {
      fetch: async (url, init) => {
        requestedBody = JSON.parse(init?.body ?? '{}');
        return response({ status: 'granted', lease: heldLease }, { status: 201 });
      },
      stdout: { write: () => undefined },
    };

    await runCli(
      [
        'lease',
        'acquire',
        '--project',
        'p1',
        '--session',
        's1',
        '--path',
        'src/app.ts',
        '--reason',
        'edit',
        '--duration-ms',
        '60000',
      ],
      dependencies,
    );

    expect(requestedBody).toMatchObject({ durationMs: 60000 });
  });
});
```

Note: `heldLease` must satisfy `workLeaseSchema`'s superRefine — `matchPath` is the lowercased path plus a trailing slash, and a `held` state needs no `releasedAt`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest run apps/cli/src/cli.test.ts -t "lease"
```

Expected: FAIL — commander reports an unknown command `lease` (surfaced as a rejected promise or command error).

- [ ] **Step 3: Implement `lease acquire`**

In `apps/cli/src/cli.ts`, add to the `@luwi/protocol` import list (alphabetical position):

```ts
  leaseAcquireResponseSchema,
```

After the `inbox` command block (search for `const events = program.command('events')` and insert immediately before it):

```ts
const leases = program.command('lease').description('Hold and inspect advisory work leases');
leases
  .command('acquire')
  .requiredOption('--project <projectId>', 'Project ID')
  .requiredOption('--session <sessionId>', 'Holding session ID')
  .requiredOption('--path <path>', 'Project-relative path to claim')
  .requiredOption('--reason <reason>', 'Why the path is held')
  .option('--duration-ms <milliseconds>', 'Lease duration in milliseconds')
  .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
  .action(
    async (options: {
      project: string;
      session: string;
      path: string;
      reason: string;
      durationMs?: string;
      url: string;
    }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          '/api/v1/leases',
          leaseAcquireResponseSchema,
          jsonBody({
            projectId: options.project,
            sessionId: options.session,
            path: options.path,
            reason: options.reason,
            ...(options.durationMs === undefined ? {} : { durationMs: Number(options.durationMs) }),
          }),
        ),
      );
    },
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run apps/cli/src/cli.test.ts -t "lease"
```

Expected: the three new tests PASS. Then run the whole file: `pnpm vitest run apps/cli/src/cli.test.ts` — no regressions.

---

### Task 3: CLI `lease renew` and `lease release`

**Files:**

- Modify: `apps/cli/src/cli.ts` (extend the `leases` group from Task 2; extend imports)
- Test: `apps/cli/src/cli.test.ts` (extend the `lease commands` describe)

**Interfaces:**

- Consumes: `leases` command group and `heldLease` fixture from Task 2; `workLeaseSchema` from `@luwi/protocol`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Inside the `lease commands` describe block:

```ts
it('renews a lease for its holding session', async () => {
  let requestedUrl = '';
  let requestedBody: unknown;
  let output = '';
  const renewed = { ...heldLease, renewedAt: '2026-08-16T08:04:00.000Z' };
  const dependencies: Partial<CliDependencies> = {
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedBody = JSON.parse(init?.body ?? '{}');
      return response(renewed);
    },
    stdout: {
      write: (text) => {
        output += text;
      },
    },
  };

  await runCli(['lease', 'renew', 'lease-1', '--session', 's1'], dependencies);

  expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases/lease-1/renew');
  expect(requestedBody).toEqual({ sessionId: 's1' });
  expect(JSON.parse(output)).toEqual(renewed);
});

it('releases a lease for its holding session', async () => {
  let requestedUrl = '';
  let requestedBody: unknown;
  const released = {
    ...heldLease,
    state: 'released',
    releasedAt: '2026-08-16T08:04:30.000Z',
  };
  const dependencies: Partial<CliDependencies> = {
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedBody = JSON.parse(init?.body ?? '{}');
      return response(released);
    },
    stdout: { write: () => undefined },
  };

  await runCli(['lease', 'release', 'lease-1', '--session', 's1'], dependencies);

  expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases/lease-1/release');
  expect(requestedBody).toEqual({ sessionId: 's1' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest run apps/cli/src/cli.test.ts -t "lease"
```

Expected: the two new tests FAIL (unknown command `renew` / `release`).

- [ ] **Step 3: Implement**

Add `workLeaseSchema,` to the `@luwi/protocol` import list. Extend the `leases` group:

```ts
leases
  .command('renew <leaseId>')
  .requiredOption('--session <sessionId>', 'Holding session ID')
  .option('--duration-ms <milliseconds>', 'Lease duration in milliseconds')
  .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
  .action(
    async (leaseId: string, options: { session: string; durationMs?: string; url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/leases/${encodeURIComponent(leaseId)}/renew`,
          workLeaseSchema,
          jsonBody({
            sessionId: options.session,
            ...(options.durationMs === undefined ? {} : { durationMs: Number(options.durationMs) }),
          }),
        ),
      );
    },
  );
leases
  .command('release <leaseId>')
  .requiredOption('--session <sessionId>', 'Holding session ID')
  .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
  .action(async (leaseId: string, options: { session: string; url: string }) => {
    printJson(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/leases/${encodeURIComponent(leaseId)}/release`,
        workLeaseSchema,
        jsonBody({ sessionId: options.session }),
      ),
    );
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run apps/cli/src/cli.test.ts
```

Expected: PASS, whole file.

---

### Task 4: CLI `lease list` and `lease get`

**Files:**

- Modify: `apps/cli/src/cli.ts` (extend the `leases` group; extend imports)
- Test: `apps/cli/src/cli.test.ts` (extend the `lease commands` describe)

**Interfaces:**

- Consumes: `leases` group and `heldLease` fixture; `leaseCollectionSchema` from `@luwi/protocol`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists leases with filters as query parameters', async () => {
  let requestedUrl = '';
  let output = '';
  const dependencies: Partial<CliDependencies> = {
    fetch: async (url) => {
      requestedUrl = url;
      return response({ leases: [heldLease], truncated: false });
    },
    stdout: {
      write: (text) => {
        output += text;
      },
    },
  };

  await runCli(['lease', 'list', '--project', 'p1', '--session', 's1'], dependencies);

  expect(requestedUrl).toBe(
    'http://127.0.0.1:4782/api/v1/leases?limit=100&projectId=p1&sessionId=s1',
  );
  expect(JSON.parse(output)).toEqual({ leases: [heldLease], truncated: false });
});

it('gets one lease by id', async () => {
  let requestedUrl = '';
  const dependencies: Partial<CliDependencies> = {
    fetch: async (url) => {
      requestedUrl = url;
      return response(heldLease);
    },
    stdout: { write: () => undefined },
  };

  await runCli(['lease', 'get', 'lease-1'], dependencies);

  expect(requestedUrl).toBe('http://127.0.0.1:4782/api/v1/leases/lease-1');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest run apps/cli/src/cli.test.ts -t "lease"
```

Expected: the two new tests FAIL (unknown command `list` / `get` under `lease`).

- [ ] **Step 3: Implement**

Add `leaseCollectionSchema,` to the `@luwi/protocol` import list. Extend the `leases` group (URLSearchParams ordering: `limit` first, then conditionals, matching the `message list` pattern):

```ts
leases
  .command('list')
  .option('--project <projectId>', 'Filter by project')
  .option('--session <sessionId>', 'Filter by holding session')
  .option('--limit <count>', 'Maximum result count', '100')
  .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
  .action(async (options: { project?: string; session?: string; limit: string; url: string }) => {
    const query = new URLSearchParams({
      limit: options.limit,
      ...(options.project === undefined ? {} : { projectId: options.project }),
      ...(options.session === undefined ? {} : { sessionId: options.session }),
    });
    printJson(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/leases?${query.toString()}`,
        leaseCollectionSchema,
      ),
    );
  });
leases
  .command('get <leaseId>')
  .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
  .action(async (leaseId: string, options: { url: string }) => {
    printJson(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/leases/${encodeURIComponent(leaseId)}`,
        workLeaseSchema,
      ),
    );
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run apps/cli/src/cli.test.ts
```

Expected: PASS, whole file.

---

### Task 5: README — MCP registration path and honest inventory

Documentation only. No server code changes; no new tools.

**Files:**

- Modify: `README.md` — the `### MCP server` section (starts line 405)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Verify the inventory numbers before writing them**

```bash
grep -c "name: 'luwi_" apps/mcp-server/src/server.ts
```

Expected: 36. If it is not 36, the counts in the text below are wrong — recount reads/writes by the daemon method each tool calls before writing anything.

- [ ] **Step 2: Extend the section**

Append to the `### MCP server` section (after the existing structuredContent paragraph, before `## HTTP and WebSocket API`):

````markdown
The inventory is 36 tools: 25 read and 11 write coordination state (the messaging
transitions, a bounded optimization-analysis request, and three of the four work-lease
tools). Control-plane writes — config approval and apply, rollback, graph rebuild, Git
mutation — are never exposed. The graph surface carries the two rooted reads (neighbors
and path); the whole-runtime summary and subgraph reads stay on the HTTP API and CLI.

To register the server with Claude Code, build first (`pnpm build`), have the daemon
running and a session registered, then either use the CLI:

​`text
claude mcp add --scope local luwi-runtime \
  --env LUWI_DAEMON_URL=http://127.0.0.1:4782 \
  --env LUWI_SESSION_ID=<registered-online-session-id> \
  -- node <repo>/apps/mcp-server/dist/main.js
​`

or, on a machine without the `claude` CLI, hand-edit the local scope in `~/.claude.json`
— the entry lives under `projects.<absolute repo path>.mcpServers`:

​`json
{
  "luwi-runtime": {
    "type": "stdio",
    "command": "node",
    "args": ["<repo>/apps/mcp-server/dist/main.js"],
    "env": {
      "LUWI_DAEMON_URL": "http://127.0.0.1:4782",
      "LUWI_SESSION_ID": "<registered-online-session-id>"
    }
  }
}
​`

Two facts make a naive registration fail. A session id is runtime identity, not
configuration: it goes stale on every daemon restart, so the env value must name a
currently online session. And the server verifies that binding before connecting the
transport, so with a missing or terminal session it exits 1 without ever speaking MCP —
which a client reports as a startup failure, not a tool error.
​```
````

(The `​` marks above only protect this plan's own fencing — write plain triple-backtick fences in README.md.)

- [ ] **Step 3: Verify formatting**

```bash
pnpm format
```

Expected: green (run `pnpm format:write` and re-check if Prettier objects to the new block).

---

### Task 6: Disambiguate `config/reconcile` in CLAUDE.md and AGENTS.md; sweep README

The measured fact: `POST /api/v1/config/reconcile` is implemented, tested, and runs at daemon start (`apps/daemon/src/runtime.ts:828` calls `configControlService.reconcile()`); it recovers _interrupted config apply operations_ by hash comparison (`reconcileOperation`, `packages/runtime/src/config-policy.ts:89`). What §21 bans under the same name is an unbuilt _automatic drift reconciliation_ loop. The docs must stop letting one name mean both.

**Files:**

- Modify: `CLAUDE.md` (the "Not implemented" list, line ~156)
- Modify: `AGENTS.md` §21 (the prohibition sentence, line ~1083) — **Edit tool only, never scripted (CRLF trap)**
- Modify: `README.md` only if the sweep in Step 3 finds a false claim

**Interfaces:** none.

- [ ] **Step 1: Edit CLAUDE.md**

Replace:

```markdown
Not implemented, and per §21 still explicitly out of scope without approval: `config/reconcile`,
lifecycle/release scoring, task orchestration, semantic or vector knowledge graph, memory
```

with:

```markdown
Not implemented, and per §21 still explicitly out of scope without approval: automatic drift
reconciliation (distinct from the implemented `POST /api/v1/config/reconcile`, which recovers
interrupted apply operations at daemon start), lifecycle/release scoring, task orchestration,
semantic or vector knowledge graph, memory
```

Adjust the wrapped line boundaries so no line exceeds 100 characters, matching the file's style.

- [ ] **Step 2: Edit AGENTS.md §21 with the Edit tool**

Replace:

```markdown
**Every other prohibition below still stands.** Do not begin `config/reconcile`, lifecycle/release
```

with:

```markdown
**Every other prohibition below still stands.** Do not begin automatic drift reconciliation (the
unbuilt desired-state loop — not the implemented interrupted-apply recovery that answers
`POST /api/v1/config/reconcile`), lifecycle/release
```

Then verify no CRLF was introduced and the change is what git sees:

```bash
git diff AGENTS.md | head -30
file AGENTS.md
```

Expected: the diff shows only these lines; `file` does not report CRLF line terminators.

- [ ] **Step 3: Sweep README "Current status" and AGENTS.md §10 note**

```bash
grep -n "reconcile" README.md
grep -n "reconcile" CLAUDE.md
```

Read each hit in context. Fix only sentences the Task's measured fact proves false (a claim that reconcile does not exist, or that the route is unimplemented). Add nothing speculative. If every hit is already true, change nothing and record that in the task report.

---

### Task 7: Drawer interaction contract (Escape, focus return, contention round-trip)

The docked inspector already owns this contract (`inspectors/inspector-panel.tsx:149-185`): capture `document.activeElement` at mount, close on Escape, return focus on close, no focus trap. The drawer shares the same column and must share the contract.

**Files:**

- Modify: `apps/dashboard/src/app.tsx` (extract the drawer aside into a `ProjectEvidenceDrawer` component in the same file; the JSX to extract is the `<aside className="inspector inspector--drawer">` block added by the uncommitted change, committed in Task 1)
- Test: `apps/dashboard/src/app.test.tsx` (extend the `project evidence drawer` describe)

**Interfaces:**

- Consumes: the drawer markup committed in Task 1 (aria-labels "Project evidence" / "Close project evidence" are contract and must not change); `ProjectDetail` from `./projects/projects-view.js`.
- Produces: `ProjectEvidenceDrawer({ title, onClose, children })`, module-private to `app.tsx`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `project evidence drawer` describe in `app.test.tsx`:

```tsx
it('closes on Escape and returns focus to the row that opened it', () => {
  window.location.hash = '#/projects';
  const value = input();
  value.projects = {
    state: 'ready',
    data: [{ id: 'p1', name: 'Drawer Project', localPath: 'C:/work/drawer' }],
  };
  render(
    <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
  );

  const opener = screen.getByRole('button', { name: 'Drawer Project' });
  fireEvent.click(opener);
  expect(window.location.hash).toBe('#/projects/p1');
  expect(screen.getByRole('complementary', { name: 'Project evidence' })).toBeTruthy();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(window.location.hash).toBe('#/projects');
  expect(screen.queryByRole('complementary', { name: 'Project evidence' })).toBeNull();
});

it('restores the drawer when the inspector that displaced it closes', () => {
  window.location.hash = '#/projects/p1';
  const value = input();
  value.projects = {
    state: 'ready',
    data: [{ id: 'p1', name: 'Drawer Project', localPath: 'C:/work/drawer' }],
  };
  value.sessions = {
    state: 'ready',
    data: [
      {
        id: 's1',
        agentId: 'codex-main',
        projectId: 'p1',
        status: 'thinking',
        presence: 'online',
        startedAt: '2026-08-16T08:00:00.000Z',
        lastHeartbeatAt: '2026-08-16T08:00:05.000Z',
      },
    ],
  };
  render(
    <DashboardApp snapshot={buildPulseSnapshot(value)} websocketState="live" onRetry={vi.fn()} />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Inspect session s1' }));
  expect(screen.queryByRole('complementary', { name: 'Project evidence' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
  expect(screen.getByRole('complementary', { name: 'Project evidence' })).toBeTruthy();
});
```

Accessible names, all verified against the code: the registry opener button's name is the project name (`projects-view.tsx:591-597`), the inspector close button's aria-label is `Close inspector` (`inspector-panel.tsx:235`), and the Active Work inspect buttons are named `Inspect session <id>`. The session fixture shape above copies the existing fixtures in `app.test.tsx` (including `presence: 'online'`).

Focus assertion: after the Escape close, also assert `expect(document.activeElement).toBe(opener);` — include it in the first test after the hash assertion. If jsdom's microtask timing makes it flaky, wrap in `await vi.waitFor(...)` and make the test async.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm vitest run apps/dashboard/src/app.test.tsx -t "drawer"
```

Expected: the Escape test FAILS (nothing listens for Escape); the contention test may already pass — if it does, keep it as a regression guard and note it.

- [ ] **Step 3: Extract `ProjectEvidenceDrawer` and implement the contract**

In `app.tsx`, above `DashboardApp`, add (imports `useCallback`, `useEffect`, `useRef`, `type ReactNode` from `react` — extend the existing react import):

```tsx
/**
 * The drawer shares the inspector's column and therefore its contract
 * (inspector-panel.tsx): Escape closes, focus returns to what opened it,
 * and there is no focus trap because nothing behind the pane is inert.
 */
function ProjectEvidenceDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const close = useCallback(() => {
    const target = returnFocus.current;
    onClose();
    queueMicrotask(() => target?.focus());
  }, [onClose]);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);
  return (
    <aside className="inspector inspector--drawer" aria-label="Project evidence">
      <header>
        <div>
          <p className="eyebrow">Scoped evidence</p>
          <h2>{title}</h2>
        </div>
        <button ref={closeButton} type="button" aria-label="Close project evidence" onClick={close}>
          ×
        </button>
      </header>
      <div className="inspector__body">{children}</div>
    </aside>
  );
}
```

Then replace the inline `<aside className="inspector inspector--drawer" …>…</aside>` block inside `DashboardApp` with:

```tsx
<ProjectEvidenceDrawer
  key={route.projectId}
  title={
    snapshot.projects.find((project) => project.id === route.projectId)?.name ?? 'Project evidence'
  }
  onClose={() => {
    window.location.hash = routeHref({ name: 'projects' });
  }}
>
  <ProjectDetail
    snapshot={snapshot}
    selectedProjectId={route.projectId}
    {...(route.agentId === undefined ? {} : { selectedAgentId: route.agentId })}
    resources={projectResources}
    scopeLoading={projectScopeLoading}
    agentPairResources={agentPairResources}
    agentPairLoading={agentPairLoading}
    leaseResources={leaseResources}
    onSelectAgent={(agentId) => {
      if (route.projectId === undefined) return;
      window.location.hash = routeHref({
        name: 'projects',
        projectId: route.projectId,
        ...(agentId === undefined ? {} : { agentId }),
      });
    }}
  />
</ProjectEvidenceDrawer>
```

`key={route.projectId}` remounts the drawer per project so the mount-time focus capture and close-button focus re-run when the palette navigates between projects.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run apps/dashboard/src/app.test.tsx apps/dashboard/src/projects/projects-view.test.tsx
```

Expected: PASS, both files, including the pre-existing drawer tests from Task 1.

- [ ] **Step 5: Copy check on the drawer's empty and loading states**

Read the strings `ProjectDetail` renders for loading ("Loading project evidence…") and not-found ("Project not found in the current snapshot.") and the registry's empty-state voice in `projects-view.tsx`. Fix only a string that breaks the established voice (sentence case, period, honest evidence wording). If nothing breaks it, change nothing and say so in the task report.

---

### Task 8: Final verification and phase commit

**Files:**

- Commit: everything Tasks 2–7 touched (`apps/cli/src/cli.ts`, `apps/cli/src/cli.test.ts`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `apps/dashboard/src/app.tsx`, `apps/dashboard/src/app.test.tsx`, plus anything the sweep in Task 6 changed)

- [ ] **Step 1: Run the full §19 sequence**

```bash
cd c:/xampp/htdocs/luwiruntime
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: all green. On any failure: systematic-debugging, fix, re-run the whole sequence. Do not commit red; do not report a leg green that did not run.

- [ ] **Step 2: Review the diff before committing**

```bash
git status
git diff --stat
```

Expected: only the files listed above. Anything unexpected: stop and investigate before adding.

- [ ] **Step 3: Phase commit**

```bash
git add apps/cli/src/cli.ts apps/cli/src/cli.test.ts README.md CLAUDE.md AGENTS.md apps/dashboard/src/app.tsx apps/dashboard/src/app.test.tsx
git commit -m "feat: surface consolidation — CLI lease family, MCP registration doc, reconcile disambiguation, drawer contract

The CLI gains lease acquire/renew/release/list/get over the existing routes
(the one domain it could not see). README records the two MCP registration
paths and the honest 25-read/11-write inventory. CLAUDE.md and AGENTS.md
stop using config/reconcile to mean both the implemented interrupted-apply
recovery and the banned drift-reconciliation loop. The project evidence
drawer adopts the docked inspector's Escape-and-focus contract.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

If Task 6's sweep changed nothing in README beyond Task 5's section, the `git add` list is exactly as written; otherwise include what it changed.

- [ ] **Step 4: Report honestly, in Turkish**

Lead with what landed and what each verification actually showed; name anything skipped or deferred (the `context/contributions` stall and B0 remain open by design).
