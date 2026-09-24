# Lane-based supervised autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Albanoosh fleet role its own git worktree so the fleet runs backend, mobile
and review work in parallel without colliding, and fix the manager so it relaunches an
orchestrator that has no LUWI session.

**Architecture:** The repo-external manager scaffold (`~/.luwi/managed-agents/albanoosh/`) creates
three lane worktrees on `lane/<role>` branches from `main` and fast-forwards them after the owner
merges. It points each worker at its lane. The daemon changes only the review brief text.
Spec: `docs/superpowers/specs/2026-09-22-lane-based-supervised-autopilot-design.md`.

**Tech Stack:** Node ESM `.mjs` + `node:test` (manager scaffold); TypeScript + Vitest (daemon).

## Global Constraints

- The daemon gains no lane, worktree or flow concept (AGENTS.md §21).
- The manager never rebases, resets, force-moves, deletes a worktree, pushes or merges (§13).
- Base branch: `main`. Lane branches: `lane/backend`, `lane/mobile`, `lane/review`.
- Lane paths: `C:/xampp/htdocs/albanoosh/.worktrees/lane-{backend,mobile,review}`.
- Workers: `claude` → backend, `antigravity` → mobile, `codex` → review.
- No protocol, Redis, event or `luwi_v1` change.
- The manager scaffold is not a git repository. Before editing any of its files, copy it to
  `<file>.before-lanes-20260923` (the scaffold's backup convention).
- Scaffold tests run from the scaffold directory: `node --test` (runs every `*.test.mjs`).

---

### Task 1: Lane helpers

**Files:**

- Create: `~/.luwi/managed-agents/albanoosh/lanes.mjs`
- Test: `~/.luwi/managed-agents/albanoosh/lanes.test.mjs`

**Interfaces:**

- Produces:
  - `LANES: { role: 'backend'|'mobile'|'review', key: 'claude'|'antigravity'|'codex' }[]`
  - `lanePath(repositoryRoot: string, role: string): string`
  - `ensureLane({ git, exists, install, repositoryRoot, role, base }): Promise<'present'|'created'>`
  - `syncLane({ git, repositoryRoot, role, base }): Promise<'current'|'fast-forwarded'|'dirty'|'diverged'>`
  - `git(args: string[]) => Promise<string>` rejects on a non-zero exit (the scaffold's `run`
    already does this); `install(cwd: string) => Promise<void>`; `exists(path) => boolean`.

- [ ] **Step 1: Write the failing tests**

```js
// lanes.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { LANES, ensureLane, lanePath, syncLane } from './lanes.mjs';

const root = 'C:/xampp/htdocs/albanoosh';

// A fake git: answers by the joined argument string; an Error value rejects.
function fakeGit(answers) {
  const calls = [];
  const git = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return answer ?? '';
  };
  return { git, calls };
}

test('maps each worker to one lane', () => {
  assert.deepEqual(
    LANES.map((lane) => `${lane.key}:${lane.role}`),
    ['claude:backend', 'antigravity:mobile', 'codex:review'],
  );
  assert.equal(lanePath(root, 'backend'), path.join(root, '.worktrees', 'lane-backend'));
});

test('an existing lane is left alone', async () => {
  const { git, calls } = fakeGit({});
  const result = await ensureLane({
    git,
    exists: () => true,
    install: async () => {},
    repositoryRoot: root,
    role: 'backend',
    base: 'main',
  });
  assert.equal(result, 'present');
  assert.deepEqual(calls, []);
});

test('a missing lane is created on a new branch from the base, then installed', async () => {
  const lane = lanePath(root, 'mobile');
  const { git, calls } = fakeGit({
    [`-C ${root} rev-parse --verify --quiet refs/heads/lane/mobile`]: new Error('exit 1'),
  });
  const installed = [];
  const result = await ensureLane({
    git,
    exists: () => false,
    install: async (cwd) => {
      installed.push(cwd);
    },
    repositoryRoot: root,
    role: 'mobile',
    base: 'main',
  });
  assert.equal(result, 'created');
  assert.ok(calls.includes(`-C ${root} worktree add -b lane/mobile ${lane} main`));
  assert.deepEqual(installed, [lane]);
});

test('a missing lane whose branch already exists reuses the branch', async () => {
  const lane = lanePath(root, 'review');
  const { git, calls } = fakeGit({});
  await ensureLane({
    git,
    exists: () => false,
    install: async () => {},
    repositoryRoot: root,
    role: 'review',
    base: 'main',
  });
  assert.ok(calls.includes(`-C ${root} worktree add ${lane} lane/review`));
});

test('sync: a dirty lane is not touched', async () => {
  const lane = lanePath(root, 'backend');
  const { git, calls } = fakeGit({ [`-C ${lane} status --porcelain`]: ' M a.ts\n' });
  assert.equal(
    await syncLane({ git, repositoryRoot: root, role: 'backend', base: 'main' }),
    'dirty',
  );
  assert.equal(
    calls.some((call) => call.includes('merge')),
    false,
  );
});

test('sync: a lane with unmerged commits is not touched', async () => {
  const lane = lanePath(root, 'backend');
  const { git, calls } = fakeGit({
    [`-C ${lane} merge-base --is-ancestor lane/backend main`]: new Error('exit 1'),
  });
  assert.equal(
    await syncLane({ git, repositoryRoot: root, role: 'backend', base: 'main' }),
    'diverged',
  );
  assert.equal(
    calls.some((call) => call.includes('--ff-only')),
    false,
  );
});

test('sync: a merged lane behind the base is fast-forwarded', async () => {
  const lane = lanePath(root, 'backend');
  const { git, calls } = fakeGit({
    [`-C ${lane} rev-parse lane/backend`]: 'aaa\n',
    [`-C ${lane} rev-parse main`]: 'bbb\n',
  });
  assert.equal(
    await syncLane({ git, repositoryRoot: root, role: 'backend', base: 'main' }),
    'fast-forwarded',
  );
  assert.ok(calls.includes(`-C ${lane} merge --ff-only main`));
});

test('sync: a lane already at the base is current', async () => {
  const lane = lanePath(root, 'backend');
  const { git, calls } = fakeGit({
    [`-C ${lane} rev-parse lane/backend`]: 'aaa\n',
    [`-C ${lane} rev-parse main`]: 'aaa\n',
  });
  assert.equal(
    await syncLane({ git, repositoryRoot: root, role: 'backend', base: 'main' }),
    'current',
  );
  assert.equal(
    calls.some((call) => call.includes('--ff-only')),
    false,
  );
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd ~/.luwi/managed-agents/albanoosh && node --test lanes.test.mjs`
Expected: FAIL, `Cannot find module './lanes.mjs'`.

- [ ] **Step 3: Implement**

```js
// lanes.mjs — the fleet's per-role worktrees. The manager owns them; LUWI's
// daemon knows nothing of lanes (AGENTS.md §21). Never rebase, reset, delete,
// push or merge into main here: merging a lane is the owner's (§13).
import path from 'node:path';

export const LANES = [
  { role: 'backend', key: 'claude' },
  { role: 'mobile', key: 'antigravity' },
  { role: 'review', key: 'codex' },
];

export const lanePath = (repositoryRoot, role) =>
  path.join(repositoryRoot, '.worktrees', `lane-${role}`);

const succeeds = (promise) =>
  promise.then(
    () => true,
    () => false,
  );

export async function ensureLane({ git, exists, install, repositoryRoot, role, base }) {
  const lane = lanePath(repositoryRoot, role);
  if (exists(lane)) return 'present';
  const branch = `lane/${role}`;
  const hasBranch = await succeeds(
    git(['-C', repositoryRoot, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]),
  );
  await git(
    hasBranch
      ? ['-C', repositoryRoot, 'worktree', 'add', lane, branch]
      : ['-C', repositoryRoot, 'worktree', 'add', '-b', branch, lane, base],
  );
  await install(lane);
  return 'created';
}

export async function syncLane({ git, repositoryRoot, role, base }) {
  const lane = lanePath(repositoryRoot, role);
  const branch = `lane/${role}`;
  if ((await git(['-C', lane, 'status', '--porcelain'])).trim() !== '') return 'dirty';
  if (!(await succeeds(git(['-C', lane, 'merge-base', '--is-ancestor', branch, base]))))
    return 'diverged';
  const [head, target] = await Promise.all([
    git(['-C', lane, 'rev-parse', branch]),
    git(['-C', lane, 'rev-parse', base]),
  ]);
  if (head.trim() === target.trim()) return 'current';
  await git(['-C', lane, 'merge', '--ff-only', base]);
  return 'fast-forwarded';
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd ~/.luwi/managed-agents/albanoosh && node --test lanes.test.mjs`
Expected: 8 passing.

---

### Task 2: Config validation, lane pinning and the orchestrator's cwd

**Files:**

- Modify: `~/.luwi/managed-agents/albanoosh/native.mjs:8` (constant), `:70-74` (claude rule),
  `:78` (existence check), `:237` (orchestrator cwd)
- Modify: `~/.luwi/managed-agents/albanoosh/native.test.mjs` (fixtures + tests)
- Modify: `~/.luwi/managed-agents/albanoosh/config.json`

**Interfaces:**

- Consumes: `LANES`, `lanePath` from Task 1.
- Produces: `config.repositoryRoot: string`, which must resolve to `C:/xampp/htdocs/albanoosh`.
  Each worker's `workingDirectory` must equal `lanePath(repositoryRoot, <its role>)`.

- [ ] **Step 1: Write the failing tests** (append to `native.test.mjs`; also set
      `workingDirectory` in `claudeWorker` to `'C:/xampp/htdocs/albanoosh/.worktrees/lane-backend'`
      and in `codexWorker` to `'C:/xampp/htdocs/albanoosh/.worktrees/lane-review'`, and have
      `validConfig()` return `repositoryRoot: 'C:/xampp/htdocs/albanoosh'` and set the antigravity
      clone's `workingDirectory` to `'C:/xampp/htdocs/albanoosh/.worktrees/lane-mobile'`)

```js
test('rejects a missing repository root', () => {
  const input = validConfig();
  delete input.repositoryRoot;
  assert.throws(() => validateConfig(input), /Missing repositoryRoot/);
});

test('rejects a repository root other than the Albanoosh checkout', () => {
  const input = validConfig();
  input.repositoryRoot = 'C:/xampp/htdocs/elsewhere';
  assert.throws(() => validateConfig(input), /repositoryRoot must be the Albanoosh checkout/);
});

test('rejects a worker outside its own lane', () => {
  const input = validConfig();
  input.workers[2].workingDirectory = 'C:/xampp/htdocs/albanoosh';
  assert.throws(() => validateConfig(input), /Worker codex must work in its lane/);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd ~/.luwi/managed-agents/albanoosh && node --test native.test.mjs`
Expected: the three new tests FAIL. The existing tests also fail until Step 3, because the
fixtures now point at lanes.

- [ ] **Step 3: Implement**

In `native.mjs`:

```js
import { LANES, lanePath } from './lanes.mjs';

// replaces CLAUDE_WORKING_DIRECTORY
const REPOSITORY_ROOT = path.resolve('C:/xampp/htdocs/albanoosh');
```

In `validateConfig`, after the `node/cli/projectId` loop:

```js
if (typeof config.repositoryRoot !== 'string' || !config.repositoryRoot)
  throw new Error('Missing repositoryRoot.');
if (path.resolve(config.repositoryRoot) !== REPOSITORY_ROOT)
  throw new Error('repositoryRoot must be the Albanoosh checkout.');
```

Inside the per-worker loop, before the claude rule:

```js
const lane = LANES.find((candidate) => candidate.key === worker.key);
if (
  path.resolve(worker.workingDirectory) !== path.resolve(lanePath(config.repositoryRoot, lane.role))
)
  throw new Error(`Worker ${worker.key} must work in its lane.`);
```

In the claude rule, delete the line
`|| path.resolve(worker.workingDirectory) !== CLAUDE_WORKING_DIRECTORY` (the lane rule covers it).

In the existence check, stop checking worker working directories (the manager creates the lanes
at serve start, after config load):

```js
for (const name of [
  config.node,
  config.cli,
  config.repositoryRoot,
  ...config.workers.map((w) => w.executable),
])
  if (!path.isAbsolute(name) || !fs.existsSync(name))
    throw new Error(`Missing absolute path: ${name}`);
```

In `launchOrchestrator`, replace `const workingDirectory = config.workers[0].workingDirectory;`
with `const workingDirectory = config.repositoryRoot;`.

- [ ] **Step 4: Run and watch everything pass**

Run: `cd ~/.luwi/managed-agents/albanoosh && node --test`
Expected: every test in `native.test.mjs`, `lanes.test.mjs`, `roles.test.mjs` and
`redispatch.test.mjs` passes.

- [ ] **Step 5: Update `config.json`** (after backing it up): add
      `"repositoryRoot": "C:/xampp/htdocs/albanoosh"` and set each worker's `workingDirectory` to
      its lane path from the Global Constraints. Confirm it still validates:

Run: `cd ~/.luwi/managed-agents/albanoosh && node -e "import('./native.mjs').then(m => m.validateConfig(JSON.parse(require('fs').readFileSync('config.json','utf8')))).then(() => console.log('ok'))"`
Expected: `ok`.

---

### Task 3: Manager creates and syncs lanes, and finds its orchestrator's session

**Files:**

- Modify: `~/.luwi/managed-agents/albanoosh/manager.mjs` (serve start, `ensureOrchestrator`,
  the loop, `snapshot`)
- Modify: `~/.luwi/managed-agents/albanoosh/native.mjs` (new `findOrchestratorSession`)
- Test: `~/.luwi/managed-agents/albanoosh/native.test.mjs`

**Interfaces:**

- Consumes: `LANES`, `ensureLane`, `syncLane` (Task 1); `config.repositoryRoot` (Task 2).
- Produces: `findOrchestratorSession(sessions: SessionView[], since: string): string | null`, and
  a `lanes: Record<role, state>` field in the manager snapshot and `receipt.json`.

Why the orchestrator part: the orchestrator prints its start frame once. When its registration
fails at startup, the frame carries no `sessionId` (measured 2026-09-22, `orchestrator.stdout.log`).
`handle.sessionId` then stays `null`, and `ensureOrchestrator` never checks or relaunches it.

- [ ] **Step 1: Write the failing test** (append to `native.test.mjs`; add
      `findOrchestratorSession` to its import)

```js
test('finds the online orchestrator session registered since launch', () => {
  const since = '2026-09-23T10:00:00.000Z';
  const sessions = [
    {
      id: 'old',
      presence: 'online',
      status: 'idle',
      startedAt: '2026-09-23T09:00:00.000Z',
      metadata: { bridge: 'orchestrator' },
    },
    {
      id: 'gone',
      presence: 'offline',
      status: 'disconnected',
      startedAt: '2026-09-23T10:00:01.000Z',
      metadata: { bridge: 'orchestrator' },
    },
    {
      id: 'worker',
      presence: 'online',
      status: 'idle',
      startedAt: '2026-09-23T10:00:02.000Z',
      metadata: { bridge: 'native-headless' },
    },
    {
      id: 'mine',
      presence: 'online',
      status: 'idle',
      startedAt: '2026-09-23T10:00:03.000Z',
      metadata: { bridge: 'orchestrator' },
    },
  ];
  assert.equal(findOrchestratorSession(sessions, since), 'mine');
  assert.equal(findOrchestratorSession(sessions.slice(0, 3), since), null);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd ~/.luwi/managed-agents/albanoosh && node --test native.test.mjs`
Expected: FAIL, `findOrchestratorSession` is not exported.

- [ ] **Step 3: Implement the helper in `native.mjs`**

```js
// The orchestrator prints its session id once, at start. If registration failed
// then and succeeded on a later heartbeat, only the daemon knows the id: find the
// online orchestrator session registered since this launch.
export function findOrchestratorSession(sessions, since) {
  const match = sessions.find(
    (s) =>
      s.metadata?.bridge === 'orchestrator' &&
      s.presence === 'online' &&
      s.status !== 'completed' &&
      s.status !== 'disconnected' &&
      s.startedAt >= since,
  );
  return match?.id ?? null;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd ~/.luwi/managed-agents/albanoosh && node --test native.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire `ensureOrchestrator`** in `manager.mjs` (import `findOrchestratorSession`).
      Insert before the existing `if (orchestratorHandle?.alive && orchestratorHandle.sessionId)`
      block:

```js
// No id from the start frame: ask the daemon. Still none after the grace → the
// process runs without a session (it cannot coordinate), so relaunch it.
if (orchestratorHandle?.alive && !orchestratorHandle.sessionId) {
  const url = `${config.daemonUrl.replace(/\/$/, '')}/api/v1/projects/${encodeURIComponent(config.projectId)}/sessions`;
  const view = await fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (view) {
    orchestratorHandle.sessionId = findOrchestratorSession(
      view.sessions ?? [],
      orchestratorHandle.createdAt,
    );
    if (
      !orchestratorHandle.sessionId &&
      Date.now() - Date.parse(orchestratorHandle.createdAt) > ORCHESTRATOR_SESSION_GRACE_MS
    ) {
      await retire(orchestratorHandle);
      orchestratorHandle = null;
    }
  }
}
```

with `const ORCHESTRATOR_SESSION_GRACE_MS = 120_000;` beside the other `serve` locals.

- [ ] **Step 6: Create lanes at serve start.** Import `LANES, ensureLane, lanePath, syncLane`
      from `./lanes.mjs`. In `serve()`, right after the `atomic(ownerPath, …)` line and before
      `supervisor = createSupervisor(`:

```js
const git = (args) => run('git', args, { timeout: 60000 });
// Node refuses to spawn a .cmd without a shell, so go through cmd.exe; the arguments are constants.
const install = (cwd) =>
  run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'pnpm', 'install', '--frozen-lockfile'], {
    cwd,
    timeout: 600000,
  });
for (const { role } of LANES) {
  await ensureLane({
    git,
    exists: fs.existsSync,
    install,
    repositoryRoot: config.repositoryRoot,
    role,
    base: 'main',
  });
}
for (const worker of config.workers)
  if (!fs.existsSync(worker.workingDirectory))
    throw new Error(`Missing lane: ${worker.workingDirectory}`);
```

A failure here throws out of `serve`, so the manager refuses to start (spec: error handling).

- [ ] **Step 7: Sync lanes each tick.** Add `const laneStates = {};` beside `lastError`, add
      `lanes: laneStates` to the object `snapshot()` returns, and in the loop body after
      `ensureLuwibot` insert:

```js
for (const { role } of LANES) {
  try {
    laneStates[role] = await syncLane({
      git,
      repositoryRoot: config.repositoryRoot,
      role,
      base: 'main',
    });
  } catch (error) {
    laneStates[role] = 'error: ' + String(error.message).slice(0, 120);
  }
}
```

(`git` must be in scope for the loop: declare it in Step 6 at the top of the `try` block.)

- [ ] **Step 8: Run the whole scaffold suite**

Run: `cd ~/.luwi/managed-agents/albanoosh && node --test`
Expected: all pass. `manager.mjs` has no unit tests; Task 5 proves it live.

---

### Task 4: The review brief tells the reviewer where the work is

**Files:**

- Modify: `apps/daemon/src/autopilot-service.ts:1260`
- Test: `apps/daemon/src/autopilot-service.test.ts:455`

- [ ] **Step 1: Write the failing assertion** after the `expect(review).toMatchObject({…})` at
      `autopilot-service.test.ts:456`:

```ts
expect(review.brief).toContain(
  'The work is committed in another worktree of the same repository. Check out the commit the worker cited as a detached HEAD in your own working directory before running any check.',
);
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run apps/daemon/src/autopilot-service.test.ts`
Expected: FAIL on `toContain`.

- [ ] **Step 3: Implement.** In the `brief` array of `createReviewTask`, insert after the
      `Review the work another agent reported…` line:

```ts
          'The work is committed in another worktree of the same repository. Check out the commit the worker cited as a detached HEAD in your own working directory before running any check.',
```

- [ ] **Step 4: Run and watch it pass**, then the gate

Run: `pnpm vitest run apps/daemon/src/autopilot-service.test.ts` → PASS.
Run: `pnpm lint && pnpm typecheck && pnpm test` → all green.

- [ ] **Step 5: Commit** (the owner approved committing this phase on 2026-09-23)

```bash
git add apps/daemon/src/autopilot-service.ts apps/daemon/src/autopilot-service.test.ts
git commit -m "feat(autopilot): point the reviewer at the cited commit across worktrees"
```

---

### Task 5: Deploy and prove it live

- [ ] **Step 1: Build and restart the daemon** (it carries Task 4): `pnpm build`, then
      `luwi stop` and `luwi start`. Confirm it cycled: `GET /api/v1/runtime` shows a small
      `uptimeMs` and a new `runtimeInstanceId`. If `luwi stop` answers `DAEMON_PORT_CONFLICT`, run
      it again (CLAUDE.md: lifecycle-lock race).
- [ ] **Step 2: Restart the manager** with the new scaffold:
      `node manager.mjs stop` (with workers idle), then `cscript //nologo start.vbs`. Expected:
      `git -C C:/xampp/htdocs/albanoosh worktree list` shows the three lanes on `lane/*`, and
      `receipt.json` shows `"lanes"` with each role `current`.
- [ ] **Step 3: Check the sessions.** Each worker session's `workingDirectory` is its lane; one
      online `luwibot` session with `metadata.bridge = orchestrator` exists.
- [ ] **Step 4: Raise `maxInFlight` to 3.** Read the current policy
      (`GET /api/v1/projects/1f840b3c-23ba-4e74-a33d-462d05cab33c/autopilot`), re-issue it
      unchanged with `luwi autopilot policy … --max-in-flight 3`, and read it back. Only
      `maxInFlight` may differ.
- [ ] **Step 5: Acceptance run (owner in the loop).** The owner puts Albanoosh in `supervised`
      mode and creates one small backend goal and one small mobile (edit-only) goal. Check:
      both run at once in their own lanes with no rebase collision; codex reviews the backend
      commit from `lane-review` and cites it. After the owner merges `lane/backend` into `main`,
      the next tick shows `lanes.backend = fast-forwarded`, and a lane holding unmerged commits
      shows `diverged` and is untouched.
- [ ] **Step 6: Record** the outcome in memory
      (`fleet-operating-model-design-2026-09-22.md`) and in `README.md` of the scaffold.
