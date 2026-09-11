# Codex MCP Self-Resolving Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a local Codex conversation join LUWI through MCP even when Codex runs `SessionStart` after MCP initialization.

**Architecture:** Prefer an exact hook record when one exists, but otherwise resolve from the MCP child's validated Codex identity and inherited working directory. Use the existing CLI dry-run for canonical project lookup, validate with `codexAttachPlan`, then reuse the rotating session-file lifecycle.

**Tech Stack:** Node.js 22+, ESM, TypeScript, Vitest, pnpm workspaces.

## Global Constraints

- Redis remains the only runtime datastore; launcher traffic stays behind the loopback daemon/CLI boundary.
- Never guess a project or select an arbitrary online session.
- Identity continues through `codexNativeSessionId` and exact `CODEX_SESSION_ID` / `CODEX_THREAD_ID` agreement.
- Preserve inherited `LUWI_SESSION_ID` behavior for bridges and `agent run` children.
- Preserve unrelated dirty-worktree content, including `.claude/skills/graphify/`.
- Do not commit unless the user explicitly requests a commit.
- Every behavior change starts with a failing test.

---

### Task 1: Self-resolving attach plan

**Files:**

- Create: `scripts/codex-attach-resolution.mjs`
- Create: `apps/cli/src/codex-mcp-launcher.test.ts`
- Modify: `scripts/codex-mcp-launch.mjs`

**Interfaces:**

- Consumes: `codexAttachPlan(record, temporaryDirectory)` and CLI `session attach --agent-kind codex --dry-run`.
- Produces: `resolveCodexAttach(options): { record, plan }`.
- Preserves: static inherited binding plus existing attach/MCP ownership and cleanup.

- [ ] **Step 1: Write failing resolver tests**

Create `apps/cli/src/codex-mcp-launcher.test.ts`:

```ts
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AttachRecord = {
  request: {
    projectId: string;
    agentId: string;
    workingDirectory: string;
    native: { adapterId: string; nativeSessionId: string };
  };
  codexSid: string;
  cwd: string;
};

type ResolveOptions = {
  codexSid: string;
  cwd: string;
  temporaryDirectory: string;
  environment?: NodeJS.ProcessEnv;
  record?: AttachRecord;
  execute?: (...args: unknown[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
};

describe('Codex MCP attach resolution', () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'luwi-codex-mcp-resolution-'));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const request = {
    projectId: 'project-1',
    agentId: 'codex',
    workingDirectory: 'C:/work/app',
    native: { adapterId: 'codex', nativeSessionId: 'codex-sid' },
  };

  it('prefers an exact hook record without invoking dry-run', async () => {
    const { resolveCodexAttach } =
      (await import('../../../scripts/codex-attach-resolution.mjs')) as {
        resolveCodexAttach(options: ResolveOptions): { record: AttachRecord; plan: unknown };
      };
    const execute = vi.fn();
    const record = { request, codexSid: 'codex-sid', cwd: 'C:/work/app' };
    const result = resolveCodexAttach({
      codexSid: 'codex-sid',
      cwd: 'C:/work/app',
      temporaryDirectory: scratch,
      environment: {},
      record,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.record).toEqual(record);
    expect(result.plan).toEqual({
      cwd: 'C:/work/app',
      sessionFile: join(scratch, 'luwi-attach-codex-codex-sid.out'),
      attachArguments: expect.arrayContaining(['--native-session', 'codex-sid']),
    });
  });

  it('resolves from exact identity and inherited cwd when no hook record exists', async () => {
    const { resolveCodexAttach } =
      (await import('../../../scripts/codex-attach-resolution.mjs')) as {
        resolveCodexAttach(options: ResolveOptions): { record: AttachRecord; plan: unknown };
      };
    const execute = vi.fn(() => ({ status: 0, stdout: JSON.stringify(request), stderr: '' }));
    const result = resolveCodexAttach({
      codexSid: 'codex-sid',
      cwd: 'C:/work/app',
      temporaryDirectory: scratch,
      environment: { KEEP: 'yes', CLAUDE_PID: 'remove-me' },
      execute,
    });
    const call = execute.mock.calls[0];
    expect(call?.[1]).toEqual(
      expect.arrayContaining(['session', 'attach', '--agent-kind', 'codex', '--dry-run']),
    );
    expect(call?.[2]).toEqual(
      expect.objectContaining({
        cwd: 'C:/work/app',
        encoding: 'utf8',
        timeout: 8_000,
        env: expect.objectContaining({ CODEX_SESSION_ID: 'codex-sid', KEEP: 'yes' }),
      }),
    );
    expect((call?.[2] as { env: NodeJS.ProcessEnv }).env).not.toHaveProperty('CLAUDE_PID');
    expect(result.record).toEqual({ request, codexSid: 'codex-sid', cwd: 'C:/work/app' });
  });

  it.each([
    [{ status: 1, stdout: '', stderr: 'failed' }, 'dry-run failed'],
    [{ status: 0, stdout: 'not-json', stderr: '' }, 'invalid JSON'],
    [{ status: null, stdout: '', stderr: '', error: new Error('timed out') }, 'timed out'],
  ])('fails closed for an unusable dry-run result', async (execution, message) => {
    const { resolveCodexAttach } =
      (await import('../../../scripts/codex-attach-resolution.mjs')) as {
        resolveCodexAttach(options: ResolveOptions): { record: AttachRecord; plan: unknown };
      };
    expect(() =>
      resolveCodexAttach({
        codexSid: 'codex-sid',
        cwd: 'C:/work/app',
        temporaryDirectory: scratch,
        execute: () => execution,
      }),
    ).toThrow(message);
  });

  it('uses immediate self-resolution instead of waiting for SessionStart', async () => {
    const source = await readFile(
      join(import.meta.dirname, '..', '..', '..', 'scripts', 'codex-mcp-launch.mjs'),
      'utf8',
    );
    expect(source).toContain('resolveCodexAttach({');
    expect(source).toContain('cwd: process.cwd()');
    expect(source).not.toContain('claimRecord(Date.now() + WAIT_MS');
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @luwi/cli exec vitest run src/codex-mcp-launcher.test.ts
```

Expected: FAIL because `codex-attach-resolution.mjs` is absent and the launcher still waits for a hook record.

- [ ] **Step 3: Implement the resolver**

Create `scripts/codex-attach-resolution.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { codexAttachPlan } from './native-mcp-binding.mjs';

const LUWI_CLI = join(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'main.js');

export function resolveCodexAttach({
  codexSid,
  cwd,
  temporaryDirectory,
  environment = process.env,
  record,
  execute = spawnSync,
}) {
  if (record !== undefined) return { record, plan: codexAttachPlan(record, temporaryDirectory) };

  const childEnvironment = { ...environment, CODEX_SESSION_ID: codexSid };
  delete childEnvironment.CLAUDE_CODE_CHILD_SESSION;
  delete childEnvironment.CLAUDE_CODE_SESSION_ID;
  delete childEnvironment.CLAUDE_PID;
  const resolved = execute(
    process.execPath,
    [LUWI_CLI, 'session', 'attach', '--agent-kind', 'codex', '--dry-run'],
    { cwd, env: childEnvironment, encoding: 'utf8', windowsHide: true, timeout: 8_000 },
  );
  if (resolved.error) throw new Error(`Codex attach dry-run timed out: ${resolved.error.message}`);
  if (resolved.status !== 0) throw new Error('Codex attach dry-run failed');

  let request;
  try {
    request = JSON.parse(resolved.stdout);
  } catch {
    throw new Error('Codex attach dry-run returned invalid JSON');
  }
  const fallbackRecord = { request, codexSid, cwd };
  return {
    record: fallbackRecord,
    plan: codexAttachPlan(fallbackRecord, temporaryDirectory),
  };
}
```

- [ ] **Step 4: Integrate claim-or-self-resolve**

In `scripts/codex-mcp-launch.mjs`, import `resolveCodexAttach`. Replace the polling `claimRecord(deadline, codexSid)` with a single atomic `claimRecord(codexSid)` attempt returning `undefined` for absent, stale, malformed, mismatched, or already-claimed records.

Replace the owned attach setup with:

```js
const codexSid = codexNativeSessionId(process.env);
if (codexSid === undefined) throw new Error('Codex MCP launcher received no conversation id');
const claimed = claimRecord(codexSid);
const resolved =
  claimed ??
  resolveCodexAttach({
    codexSid,
    cwd: process.cwd(),
    temporaryDirectory: tmpdir(),
    environment: process.env,
  });
const { record, plan } = resolved;
const claimedPath =
  claimed?.claimedPath ?? join(tmpdir(), `${RECORD_PREFIX}${codexSid}.json.claimed`);
const { attachArguments, cwd, sessionFile } = plan;
attach = spawn(process.execPath, [LUWI_CLI, ...attachArguments], {
  cwd,
  env: process.env,
  stdio: 'ignore',
  windowsHide: true,
});
writePrivateJsonFile(claimedPath, { ...record, attachPid: attach.pid, sessionFile });
```

Keep the online-presence polling, MCP spawn, signals, inherited-binding branch, diagnostics, and safe error envelope unchanged.

- [ ] **Step 5: Verify GREEN**

Run the Step 2 command. Expected: all resolver and launcher source-contract cases PASS without warnings.

---

### Task 2: Documentation, full verification, and live join

**Files:**

- Modify: `docs/LUWI-MCP-SETUP.md:51`
- Modify: `docs/architecture/overview.md:468`
- Verify: all Task 1 files

**Interfaces:**

- Consumes: Task 1 self-resolving launcher.
- Produces: truthful setup guidance and a live `luwi_join` result from a fresh Codex process.

- [ ] **Step 1: Update operator and architecture text**

Document that the launcher prefers a validated hook record, otherwise uses its exact native identity and inherited cwd through bounded CLI dry-run resolution. State that arbitrary online-session lookup remains forbidden and the canonical project lookup must succeed before session creation.

- [ ] **Step 2: Run focused neighboring tests**

```powershell
pnpm --filter @luwi/cli exec vitest run src/codex-mcp-launcher.test.ts src/attach-hook-guard.test.ts
```

Expected: both files PASS.

- [ ] **Step 3: Run repository gates**

```powershell
pnpm format --check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: every command exits 0. Report any command that cannot run with its exact error instead of calling it successful.

- [ ] **Step 4: Inspect the final diff**

```powershell
git diff --check
git status --short
git diff -- scripts/codex-attach-resolution.mjs scripts/codex-mcp-launch.mjs apps/cli/src/codex-mcp-launcher.test.ts docs/LUWI-MCP-SETUP.md docs/architecture/overview.md
```

Expected: no whitespace errors, secrets, generated artifacts, or unrelated changes.

- [ ] **Step 5: Perform a fresh Codex MCP join**

Start local Codex in `C:\xampp\htdocs\luwiruntime` without inherited `LUWI_SESSION_ID`. Submit the user's inbox-worker instruction. From that point, use only `luwi_*` MCP tools for coordination: first call `luwi_join`, report project `LUWI Runtime` and the returned Codex LUWI session ID, then immediately continue the `luwi_join` loop. Answer every claim with its correlation ID through `luwi_respond_to_message` or `luwi_fail_message`.

- [ ] **Step 6: Report verified connection**

Claim success only after `luwi_join` returns the project name and session ID. Include exact verification results and state that no commit was created unless explicitly requested.
