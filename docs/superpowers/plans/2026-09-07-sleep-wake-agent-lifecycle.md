# Sleep/Wake-Safe Agent Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (- [ ]) syntax for tracking.

**Goal:** Let a live native agent recover LUWI observation after machine sleep while ensuring that
an ended agent cannot leave an indefinitely waiting attach, heartbeat, lease-renewal, or cleanup
helper.

**Architecture:** Teach the existing Redis daemon-ownership lease to atomically reacquire only a
vacant owner key and route runtime recovery through that decision. Give session attach the same
AbortController-backed request deadline already used by agent run, then install attach shutdown
signals before initial registration so remote cleanup is always bounded. Preserve the existing
session-bootstrap rotation and work-lease semantics.

**Tech Stack:** Node.js 22+, strict TypeScript ESM, pnpm 11.9.0 workspaces, Vitest, Fastify, official
redis client, existing ApplicationError and AbortController support; no new dependency.

## Global Constraints

- Preserve all pre-existing dirty-worktree edits. In particular, apps/cli/src/cli.ts,
  apps/cli/src/cli.test.ts, apps/daemon/src/runtime.ts, and neighboring dashboard work already
  contain user changes; edit only the named lifecycle regions.
- Do not stage or commit unless the user explicitly asks. Each task ends with a review checkpoint
  and a suggested commit message, not an authorized commit.
- The daemon remains the only Redis client process. Browser, CLI, MCP, hooks, and native agents
  receive no Redis credentials.
- Reacquisition uses exactly atomic SET key token NX PX ttl behavior. Never overwrite, delete, or
  adopt a competing owner token.
- Keep the current 15,000-ms owner and presence TTL defaults. Do not mask sleep with larger TTLs.
- session attach uses a 2,000-ms request timeout by default and accepts only integer values from 100
  through 30,000 ms.
- A replacement LUWI session reuses the original registration input but never revives a terminal
  session or transfers its work leases.
- Do not add an OS sleep detector, Windows wake task, service, watchdog, datastore, Redis Function,
  API route, protocol version, package boundary, or production dependency.
- Never stop, restart, signal, or inject input into the native coding agent as part of LUWI
  recovery.
- Follow strict RED-GREEN-REFACTOR: add one failing behavioral test, run it and confirm the expected
  failure, then make the smallest production change.

---

## File map

| File                                                                   | Responsibility in this change                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| packages/redis/src/daemon-ownership.ts                                 | Atomic owner-key reacquisition inside the existing lease object          |
| packages/redis/src/daemon-ownership.test.ts                            | Reacquisition, contention, timer, and notification unit behavior         |
| packages/redis/src/daemon-ownership.integration.test.ts                | Real Redis expiry and SET-NX contention evidence                         |
| apps/daemon/src/daemon-ownership-recovery.ts                           | Small runtime decision seam: still owned, reacquired, or contended       |
| apps/daemon/src/daemon-ownership-recovery.test.ts                      | Runtime recovery decision and callback behavior                          |
| apps/daemon/src/runtime.ts                                             | Use the decision seam before Function and Stream recovery                |
| apps/cli/src/cli.ts                                                    | Bounded session-attach HTTP client and early shutdown wiring             |
| apps/cli/src/cli.test.ts                                               | Attach timeout, AbortSignal, recovery-loop, and bounded cleanup behavior |
| packages/runtime/src/session-bootstrap.test.ts                         | Existing terminal-session rotation regression evidence                   |
| docs/decisions/0030-sleep-wake-agent-lifecycle.md                      | Accepted architecture record                                             |
| docs/architecture/overview.md                                          | Daemon recovery and attached-session lifecycle                           |
| README.md                                                              | User-facing sleep/wake and connect-timeout behavior                      |
| AGENTS.md                                                              | Binding ownership-recovery invariant and required test coverage          |
| docs/superpowers/specs/2026-09-07-sleep-wake-agent-lifecycle-design.md | Approved design status                                                   |

---

### Task 1: Reacquire only a vacant daemon owner key

**Files:**

- Modify: packages/redis/src/daemon-ownership.test.ts
- Modify: packages/redis/src/daemon-ownership.integration.test.ts
- Modify: packages/redis/src/daemon-ownership.ts
- Verify export: packages/redis/src/index.ts

**Interfaces:**

- Consumes: RedisCommandClient.sendCommand(arguments_: readonly string[]): Promise<unknown>
- Produces: DaemonOwnershipLease.reacquire(): Promise<boolean>
- Contract: true means this previously active lease atomically restored its own token into a vacant
  key; false means another value exists; Redis failures reject.

- [ ] **Step 1: Add failing unit tests for vacant reacquisition and contention**

Add these cases inside the existing daemon ownership describe block. Use the existing FakeClient and
the same injected timer seam:

    it('reacquires an expired owner key with the same token and no second timer', async () => {
      const client = new FakeClient();
      client.replies = ['OK', 0, 'OK'];
      const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
      const setInterval = vi.fn(() => timer);
      const onLost = vi.fn();
      const lease = createDaemonOwnershipLease({
        client,
        key: 'owner',
        runtimeInstanceId: 'runtime-sleep',
        ttlMs: 15_000,
        renewIntervalMs: 5_000,
        createNonce: () => 'nonce-sleep',
        setInterval,
        clearInterval: vi.fn(),
        onLost,
      });

      await lease.acquire();
      await expect(lease.renewOnce()).resolves.toBe(false);
      await expect(lease.reacquire()).resolves.toBe(true);

      expect(lease.isOwned).toBe(true);
      expect(setInterval).toHaveBeenCalledTimes(1);
      expect(client.commands[2]).toEqual([
        'SET',
        'owner',
        lease.ownerToken,
        'NX',
        'PX',
        '15000',
      ]);
    });

    it('does not overwrite a competing owner while trying to reacquire', async () => {
      const client = new FakeClient();
      client.replies = ['OK', 0, null];
      const lease = createDaemonOwnershipLease({
        client,
        key: 'owner',
        runtimeInstanceId: 'runtime-old',
        ttlMs: 15_000,
        renewIntervalMs: 5_000,
        setInterval: () => ({}) as NodeJS.Timeout,
        clearInterval: () => undefined,
        onLost: vi.fn(),
      });

      await lease.acquire();
      await lease.renewOnce();

      await expect(lease.reacquire()).resolves.toBe(false);
      expect(lease.isOwned).toBe(false);
      expect(client.commands[2]?.slice(0, 2)).toEqual(['SET', 'owner']);
      expect(client.commands[2]?.slice(-3)).toEqual(['NX', 'PX', '15000']);
    });

    it('refuses reacquisition outside an acquired lifecycle', async () => {
      const client = new FakeClient();
      const lease = createDaemonOwnershipLease({
        client,
        key: 'owner',
        runtimeInstanceId: 'runtime-never-started',
        ttlMs: 15_000,
        renewIntervalMs: 5_000,
        setInterval: () => ({}) as NodeJS.Timeout,
        clearInterval: () => undefined,
        onLost: vi.fn(),
      });

      await expect(lease.reacquire()).rejects.toThrow(/active ownership lifecycle/i);
      expect(client.commands).toEqual([]);
    });

- [ ] **Step 2: Add failing unit tests for Redis errors and renewed loss notification**

Add:

    it('stays unowned when reacquisition cannot reach Redis', async () => {
      const sendCommand = vi
        .fn<RedisCommandClient['sendCommand']>()
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('Redis unavailable'));
      const lease = createDaemonOwnershipLease({
        client: { sendCommand },
        key: 'owner',
        runtimeInstanceId: 'runtime-error',
        ttlMs: 15_000,
        renewIntervalMs: 5_000,
        setInterval: () => ({}) as NodeJS.Timeout,
        clearInterval: () => undefined,
        onLost: vi.fn(),
      });

      await lease.acquire();
      await lease.renewOnce();
      await expect(lease.reacquire()).rejects.toThrow('Redis unavailable');
      expect(lease.isOwned).toBe(false);
    });

    it('can notify once again after ownership was reacquired', async () => {
      const client = new FakeClient();
      client.replies = ['OK', 0, 'OK', 0];
      const onLost = vi.fn();
      const lease = createDaemonOwnershipLease({
        client,
        key: 'owner',
        runtimeInstanceId: 'runtime-repeat-loss',
        ttlMs: 15_000,
        renewIntervalMs: 5_000,
        setInterval: () => ({}) as NodeJS.Timeout,
        clearInterval: () => undefined,
        onLost,
      });

      await lease.acquire();
      await lease.renewOnce();
      expect(onLost).toHaveBeenCalledTimes(1);

      await lease.reacquire();
      await lease.renewOnce();
      expect(onLost).toHaveBeenCalledTimes(2);
    });

- [ ] **Step 3: Run the unit test and confirm RED**

Run:

    .\node_modules\.bin\vitest.cmd run packages/redis/src/daemon-ownership.test.ts

Expected: FAIL because DaemonOwnershipLease has no reacquire method. The existing acquire,
renewOnce, ownsLease, and release cases must still execute without fixture errors.

- [ ] **Step 4: Implement the minimal lease lifecycle**

In packages/redis/src/daemon-ownership.ts, add the method to the public interface:

    export interface DaemonOwnershipLease {
      readonly ownerToken: string;
      readonly isOwned: boolean;
      acquire(): Promise<void>;
      renewOnce(): Promise<boolean>;
      ownsLease(): Promise<boolean>;
      reacquire(): Promise<boolean>;
      release(): Promise<boolean>;
    }

Inside RedisDaemonOwnershipLease, add one lifecycle flag and one private SET-NX helper:

    #lifecycleActive = false;

    async #claimVacant(): Promise<boolean> {
      const reply = await this.#options.client.sendCommand([
        'SET',
        this.#options.key,
        this.ownerToken,
        'NX',
        'PX',
        String(this.#options.ttlMs),
      ]);
      return reply === 'OK';
    }

Refactor acquire to call #claimVacant, throw the existing DaemonOwnershipError on false, and set
#lifecycleActive = true only after success. Keep the existing timer creation exactly once:

    async acquire(): Promise<void> {
      if (!(await this.#claimVacant())) {
        throw new DaemonOwnershipError();
      }
      this.#lifecycleActive = true;
      this.#isOwned = true;
      this.#lostNotified = false;
      this.#timer = this.#options.setInterval(() => {
        void this.renewOnce().catch(() => this.#markLost());
      }, this.#options.renewIntervalMs);
      this.#timer.unref?.();
    }

Add reacquire without arming a timer:

    async reacquire(): Promise<boolean> {
      if (!this.#lifecycleActive) {
        throw new Error('Daemon ownership cannot be reacquired outside an active ownership lifecycle.');
      }
      if (this.#isOwned) {
        return true;
      }
      const reacquired = await this.#claimVacant();
      if (reacquired) {
        this.#isOwned = true;
        this.#lostNotified = false;
      }
      return reacquired;
    }

In release, retain compare-and-delete and timer clearing, then set both flags in the finally block:

    } finally {
      this.#isOwned = false;
      this.#lifecycleActive = false;
    }

Do not change renewScript, releaseScript, ownerToken construction, or DaemonOwnershipError.
packages/redis/src/index.ts already exports DaemonOwnershipLease by type, so no new export statement
should be needed.

- [ ] **Step 5: Run the unit test and confirm GREEN**

Run:

    .\node_modules\.bin\vitest.cmd run packages/redis/src/daemon-ownership.test.ts

Expected: PASS, including all pre-existing single-owner and compare-token tests.

- [ ] **Step 6: Add real-Redis expiry coverage**

In packages/redis/src/daemon-ownership.integration.test.ts:

1. Add beforeEach to the Vitest import.
2. Delete only this test's unique key before each case.
3. Add this case:

   beforeEach(async () => {
   await client.del(key);
   });

   it('reacquires only after expiry and still loses to a replacement owner', async () => {
   const options = {
   client: commandClient,
   key,
   ttlMs: 50,
   renewIntervalMs: 5_000,
   setInterval: () => ({}) as NodeJS.Timeout,
   clearInterval: () => undefined,
   onLost: vi.fn(),
   };
   const first = createDaemonOwnershipLease({
   ...options,
   runtimeInstanceId: 'runtime-sleeping',
   });
   const second = createDaemonOwnershipLease({
   ...options,
   runtimeInstanceId: 'runtime-replacement',
   });

   await first.acquire();
   await vi.waitFor(
   async () => {
   await expect(client.exists(key)).resolves.toBe(0);
   },
   { timeout: 1_000, interval: 10 },
   );

   await second.acquire();
   await expect(first.ownsLease()).resolves.toBe(false);
   await expect(first.reacquire()).resolves.toBe(false);
   await expect(client.get(key)).resolves.toBe(second.ownerToken);

   await second.release();
   await expect(first.reacquire()).resolves.toBe(true);
   await expect(client.get(key)).resolves.toBe(first.ownerToken);
   await first.release();
   });

This test uses the existing unique luwi:test key and deletes no unrelated Redis data.

- [ ] **Step 7: Run the integration test when explicitly configured**

Run only when LUWI_TEST_REDIS_URL is present:

    .\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts packages/redis/src/daemon-ownership.integration.test.ts

Expected with configured Redis: PASS. Expected without the variable: SKIP, never a silent connection
to the developer's default database.

- [ ] **Step 8: Review checkpoint**

Inspect only the three Task 1 files and confirm there is one new Redis command shape, no timer
duplication, and no competing-token mutation.

Suggested commit message if the user later authorizes commits:

    fix(redis): reacquire expired daemon ownership safely

---

### Task 2: Route daemon recovery through the ownership decision

**Files:**

- Create: apps/daemon/src/daemon-ownership-recovery.ts
- Create: apps/daemon/src/daemon-ownership-recovery.test.ts
- Modify: apps/daemon/src/runtime.ts, specifically runRecovery near the current ownsLease check

**Interfaces:**

- Consumes: Pick<DaemonOwnershipLease, 'ownsLease' | 'reacquire'>
- Produces: recoverDaemonOwnership(options): Promise<boolean>
- Callback behavior: onReacquired runs only after atomic reacquisition; onContended runs only when
  another owner prevents reacquisition; thrown Redis errors escape to runtime backoff.

- [ ] **Step 1: Write the failing daemon recovery decision tests**

Create apps/daemon/src/daemon-ownership-recovery.test.ts:

    import { describe, expect, it, vi } from 'vitest';

    import { recoverDaemonOwnership } from './daemon-ownership-recovery.js';

    function harness(owns: boolean, reacquires: boolean) {
      const ownership = {
        ownsLease: vi.fn(async () => owns),
        reacquire: vi.fn(async () => reacquires),
      };
      const onReacquired = vi.fn();
      const onContended = vi.fn();
      return { ownership, onReacquired, onContended };
    }

    describe('daemon ownership recovery', () => {
      it('continues without reacquiring when the token is still owned', async () => {
        const h = harness(true, false);

        await expect(recoverDaemonOwnership(h)).resolves.toBe(true);

        expect(h.ownership.reacquire).not.toHaveBeenCalled();
        expect(h.onReacquired).not.toHaveBeenCalled();
        expect(h.onContended).not.toHaveBeenCalled();
      });

      it('continues and reports when a vacant owner key is reacquired', async () => {
        const h = harness(false, true);

        await expect(recoverDaemonOwnership(h)).resolves.toBe(true);

        expect(h.ownership.reacquire).toHaveBeenCalledTimes(1);
        expect(h.onReacquired).toHaveBeenCalledTimes(1);
        expect(h.onContended).not.toHaveBeenCalled();
      });

      it('stops recovery when another owner wins the key', async () => {
        const h = harness(false, false);

        await expect(recoverDaemonOwnership(h)).resolves.toBe(false);

        expect(h.onReacquired).not.toHaveBeenCalled();
        expect(h.onContended).toHaveBeenCalledTimes(1);
      });

      it('lets Redis failures reach the runtime reconnect loop', async () => {
        const h = harness(false, false);
        h.ownership.reacquire.mockRejectedValueOnce(new Error('Redis unavailable'));

        await expect(recoverDaemonOwnership(h)).rejects.toThrow('Redis unavailable');

        expect(h.onReacquired).not.toHaveBeenCalled();
        expect(h.onContended).not.toHaveBeenCalled();
      });
    });

- [ ] **Step 2: Run the decision test and confirm RED**

Run:

    .\node_modules\.bin\vitest.cmd run apps/daemon/src/daemon-ownership-recovery.test.ts

Expected: FAIL because daemon-ownership-recovery.ts and recoverDaemonOwnership do not yet exist.

- [ ] **Step 3: Implement the focused decision seam**

Create apps/daemon/src/daemon-ownership-recovery.ts:

    import type { DaemonOwnershipLease } from '@luwi/redis';

    export type DaemonOwnershipRecoveryOptions = {
      ownership: Pick<DaemonOwnershipLease, 'ownsLease' | 'reacquire'>;
      onReacquired: () => void;
      onContended: () => void;
    };

    export async function recoverDaemonOwnership(
      options: DaemonOwnershipRecoveryOptions,
    ): Promise<boolean> {
      if (await options.ownership.ownsLease()) {
        return true;
      }
      if (await options.ownership.reacquire()) {
        options.onReacquired();
        return true;
      }
      options.onContended();
      return false;
    }

This unit owns only the decision. It does not connect Redis, change readiness, emit runtime events,
or know how shutdown works.

- [ ] **Step 4: Run the decision test and confirm GREEN**

Run:

    .\node_modules\.bin\vitest.cmd run apps/daemon/src/daemon-ownership-recovery.test.ts

Expected: PASS.

- [ ] **Step 5: Integrate the decision into runRecovery**

Import recoverDaemonOwnership in apps/daemon/src/runtime.ts:

    import { recoverDaemonOwnership } from './daemon-ownership-recovery.js';

Replace only:

    if (!(await ownership.ownsLease())) {
      void shutdownRuntime();
      return;
    }

with:

    const ownershipRecovered = await recoverDaemonOwnership({
      ownership,
      onReacquired: () => {
        app?.log.info(
          { runtimeInstanceId },
          'Daemon ownership reacquired after an expired owner key',
        );
      },
      onContended: () => {
        void shutdownRuntime();
      },
    });
    if (!ownershipRecovered) {
      return;
    }

Keep this block after all three Redis connections reconnect and before Function verification,
Stream-group recovery, projection reconciliation, relay start, and the transition to ready. Do not
call createRuntimeStartedEvent or alter runtimeInstanceId.

- [ ] **Step 6: Add a wiring assertion to the existing runtime test**

In the daemon runtime describe block of apps/daemon/src/runtime.test.ts, add:

    it('checks sleep-safe ownership recovery before rebuilding runtime state', () => {
      const source = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
      const ownershipRecovery = source.indexOf('await recoverDaemonOwnership({');
      const functionRecovery = source.indexOf('await verifyOrLoadFunctionLibrary', ownershipRecovery);
      const streamRecovery = source.indexOf('await ensureRealtimeStreamGroup', ownershipRecovery);
      const ready = source.indexOf("readiness.transitionTo('ready')", ownershipRecovery);

      expect(ownershipRecovery).toBeGreaterThan(-1);
      expect(functionRecovery).toBeGreaterThan(ownershipRecovery);
      expect(streamRecovery).toBeGreaterThan(functionRecovery);
      expect(ready).toBeGreaterThan(streamRecovery);
    });

The behavioral branches stay in daemon-ownership-recovery.test.ts; this assertion protects the
critical orchestration order in the large composition root.

- [ ] **Step 7: Run daemon-focused tests**

Run:

    .\node_modules\.bin\vitest.cmd run apps/daemon/src/daemon-ownership-recovery.test.ts apps/daemon/src/runtime.test.ts

Expected: PASS. Also rerun the Redis ownership unit test because the daemon consumes its new method:

    .\node_modules\.bin\vitest.cmd run packages/redis/src/daemon-ownership.test.ts

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Confirm that a vacant key continues recovery, contention invokes shutdown once, Redis errors retain
the existing retry loop, and no second runtime.started event path exists.

Suggested commit message if the user later authorizes commits:

    fix(daemon): recover ownership after machine sleep

---

### Task 3: Bound every session-attach daemon request and cleanup

**Files:**

- Modify: apps/cli/src/cli.test.ts, inside describe('session attach')
- Modify: apps/cli/src/cli.ts, inside the session attach command only
- Regression test: packages/runtime/src/session-bootstrap.test.ts

**Interfaces:**

- Consumes: boundedRequest(dependencies, base, path, parser, timeoutMs, init?)
- Produces: session attach option --connect-timeout-ms <milliseconds>, default 2000
- Validation: integer 100 through 30000 inclusive through positiveIntegerOption
- Lifecycle: SIGINT/SIGTERM listeners exist before bootstrap.start; bootstrap.stop always runs in
  finally; all daemon requests carry an AbortSignal.

- [ ] **Step 1: Add reusable controlled deadline and signal fixtures**

Immediately before describe('session attach') in apps/cli/src/cli.test.ts, add:

    function controlledDeadlineTimers() {
      let nextId = 0;
      const callbacks = new Map<NodeJS.Timeout, () => void>();
      return {
        callbacks,
        setTimeout: ((callback: () => void) => {
          const timer = (++nextId) as unknown as NodeJS.Timeout;
          callbacks.set(timer, callback);
          return timer;
        }) as CliDependencies['setTimeout'],
        clearTimeout: ((timer: NodeJS.Timeout) => {
          callbacks.delete(timer);
        }) as CliDependencies['clearTimeout'],
        fireNext() {
          const next = callbacks.entries().next().value as
            | [NodeJS.Timeout, () => void]
            | undefined;
          if (next === undefined) throw new Error('No request deadline is armed.');
          callbacks.delete(next[0]);
          next[1]();
        },
      };
    }

    function controlledCliSignals() {
      const listeners = new Map<'SIGINT' | 'SIGTERM', () => void>();
      return {
        listeners,
        signals: {
          once(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
            listeners.set(signal, listener);
          },
          off(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
            if (listeners.get(signal) === listener) listeners.delete(signal);
          },
        } satisfies CliDependencies['signals'],
      };
    }

- [ ] **Step 2: Write the failing timeout-validation and early-stop tests**

Inside describe('session attach'), add:

    it.each(['99', '30001', 'not-an-integer'])(
      'rejects an unsafe attach request timeout of %s',
      async (value) => {
        await expect(
          runCli(
            [
              'session',
              'attach',
              '--project',
              'project-1',
              '--connect-timeout-ms',
              value,
              '--dry-run',
            ],
            {
              fetch: async () => {
                throw new Error('must not fetch');
              },
              stdout: { write: () => undefined },
              stderr: { write: () => undefined },
            },
          ),
        ).rejects.toMatchObject({
          code: 'CLI_OPTION_INVALID',
          message: expect.stringContaining('--connect-timeout-ms'),
        });
      },
    );

    it('installs stop handling before a bounded initial registration', async () => {
      const deadlines = controlledDeadlineTimers();
      const controlled = controlledCliSignals();
      const intervals: NodeJS.Timeout[] = [];
      const seenSignals: AbortSignal[] = [];
      let stderr = '';
      const run = runCli(
        [
          'session',
          'attach',
          '--project',
          'project-1',
          '--agent',
          'claude-code',
          '--connect-timeout-ms',
          '100',
        ],
        {
          environment: {},
          canonicalizePath: async (path) => path,
          fetch: (_url, init) => {
            if (init?.signal !== undefined) seenSignals.push(init.signal);
            return new Promise<HttpResponseLike>(() => undefined);
          },
          setInterval: ((callback: () => void) => {
            const timer = { callback } as unknown as NodeJS.Timeout;
            intervals.push(timer);
            return timer;
          }) as never,
          clearInterval: vi.fn(),
          setTimeout: deadlines.setTimeout,
          clearTimeout: deadlines.clearTimeout,
          signals: controlled.signals,
          stdout: { write: () => undefined },
          stderr: { write: (text) => void (stderr += text) },
        },
      );

      await vi.waitFor(() => expect(seenSignals).toHaveLength(1));
      expect(controlled.listeners.size).toBe(2);
      expect(seenSignals[0]).toBeInstanceOf(AbortSignal);

      deadlines.fireNext();
      await vi.waitFor(() => expect(stderr).toContain('exceeded its bounded timeout'));
      controlled.listeners.get('SIGTERM')?.();

      await expect(run).resolves.toBeUndefined();
      expect(intervals).toHaveLength(2);
    });

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

    .\node_modules\.bin\vitest.cmd run apps/cli/src/cli.test.ts -t "session attach"

Expected: FAIL because --connect-timeout-ms is not registered and attach has not installed signal
listeners before initial registration.

- [ ] **Step 4: Write the failing all-request-path and bounded-close tests**

Add one valid held lease fixture inside the session attach describe block:

    const heldAttachLease = {
      id: 'lease-attach',
      projectId: 'project-1',
      sessionId: registered.id,
      agentId: registered.agentId,
      path: 'src',
      matchPath: 'src/',
      reason: 'active edit',
      state: 'held' as const,
      acquiredAt: '2026-08-17T12:00:00.000Z',
      expiresAt: '2026-08-17T12:05:00.000Z',
    };

Add a happy-path test that reaches discovery, registration, heartbeat, lease listing, lease renewal,
and close:

    it('puts an AbortSignal on every attach-side daemon request', async () => {
      const project = {
        id: 'project-1',
        name: 'Work',
        localPath: 'C:/work',
        canonicalPath: 'C:/work',
        createdAt: '2026-08-17T12:00:00.000Z',
        updatedAt: '2026-08-17T12:00:00.000Z',
      };
      const requests: Array<{ url: string; signal?: AbortSignal }> = [];
      const intervals: Array<{ callback: () => void; intervalMs: number }> = [];
      const controlled = controlledCliSignals();
      const run = runCli(['session', 'attach', '--working-directory', 'C:/work/app'], {
        environment: {},
        platform: 'win32',
        canonicalizePath: async (path) => path,
        fetch: async (url, init) => {
          requests.push({ url, signal: init?.signal });
          if (url.endsWith('/api/v1/projects')) {
            return response({ projects: [project] });
          }
          if (url.endsWith('/api/v1/sessions')) {
            return response(registered, { status: 201 });
          }
          if (url.endsWith('/heartbeat')) {
            return response({ status: 'renewed', eventEmitted: false });
          }
          if (url.includes('/api/v1/leases?sessionId=')) {
            return response({ leases: [heldAttachLease], truncated: false });
          }
          if (url.endsWith('/api/v1/leases/lease-attach/renew')) {
            return response(heldAttachLease);
          }
          if (url.endsWith('/close')) {
            return response(registered);
          }
          throw new Error('Unexpected request: ' + url);
        },
        setInterval: ((callback: () => void, intervalMs: number) => {
          intervals.push({ callback, intervalMs });
          return intervals.length as unknown as NodeJS.Timeout;
        }) as never,
        clearInterval: vi.fn(),
        signals: controlled.signals,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      });

      await vi.waitFor(() =>
        expect(requests.some(({ url }) => url.endsWith('/api/v1/sessions'))).toBe(true),
      );

      intervals.find(({ intervalMs }) => intervalMs === 5_000)?.callback();
      await vi.waitFor(() =>
        expect(requests.some(({ url }) => url.endsWith('/heartbeat'))).toBe(true),
      );

      intervals.find(({ intervalMs }) => intervalMs === 150_000)?.callback();
      await vi.waitFor(() =>
        expect(
          requests.some(({ url }) => url.endsWith('/api/v1/leases/lease-attach/renew')),
        ).toBe(true),
      );

      controlled.listeners.get('SIGTERM')?.();
      await run;

      expect(requests.some(({ url }) => url.endsWith('/close'))).toBe(true);
      expect(requests).toHaveLength(6);
      for (const request of requests) {
        expect(request.signal, request.url).toBeInstanceOf(AbortSignal);
      }
    });

Add a cleanup test in which only close never answers:

    it('clears local timers and exits when remote close times out', async () => {
      const deadlines = controlledDeadlineTimers();
      const controlled = controlledCliSignals();
      const order: string[] = [];
      let closeSignal: AbortSignal | undefined;
      let stderr = '';
      const run = runCli(
        [
          'session',
          'attach',
          '--project',
          'project-1',
          '--agent',
          'claude-code',
          '--connect-timeout-ms',
          '100',
        ],
        {
          environment: {},
          canonicalizePath: async (path) => path,
          fetch: (url, init) => {
            if (url.endsWith('/close')) {
              order.push('close');
              closeSignal = init?.signal;
              return new Promise<HttpResponseLike>(() => undefined);
            }
            return Promise.resolve(response(registered, { status: 201 }));
          },
          setInterval: vi.fn(
            () => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout,
          ),
          clearInterval: vi.fn(() => void order.push('clear')),
          setTimeout: deadlines.setTimeout,
          clearTimeout: deadlines.clearTimeout,
          signals: controlled.signals,
          stdout: { write: () => undefined },
          stderr: { write: (text) => void (stderr += text) },
        },
      );

      await vi.waitFor(() => expect(controlled.listeners.size).toBe(2));
      controlled.listeners.get('SIGTERM')?.();
      await vi.waitFor(() => expect(closeSignal).toBeInstanceOf(AbortSignal));

      expect(order.slice(0, 3)).toEqual(['clear', 'clear', 'close']);
      deadlines.fireNext();

      await expect(run).resolves.toBeUndefined();
      expect(closeSignal?.aborted).toBe(true);
      expect(stderr).toContain('exceeded its bounded timeout');
    });

- [ ] **Step 5: Run the focused tests and confirm RED for request signals**

Run:

    .\node_modules\.bin\vitest.cmd run apps/cli/src/cli.test.ts -t "session attach"

Expected before implementation: the request-path test reports missing AbortSignal values and the
bounded-close test does not complete through the controlled deadline.

- [ ] **Step 6: Add the attach timeout option and one bounded request closure**

In the session attach command chain in apps/cli/src/cli.ts, add:

    .option('--connect-timeout-ms <milliseconds>', 'Per-request LUWI connection timeout', '2000')

Add connectTimeoutMs to the action option type:

    connectTimeoutMs: string;

At the beginning of the action, before filesystem identity work, validate the daemon URL and timeout:

    const daemonUrl = loopbackDaemonUrl(options.url);
    const connectTimeoutMs = positiveIntegerOption(
      options.connectTimeoutMs,
      '--connect-timeout-ms',
      100,
      30_000,
    );
    const callDaemon = <Output>(
      path: string,
      parser: Parser<Output>,
      init?: FetchInitLike,
    ): Promise<Output> =>
      boundedRequest(dependencies, daemonUrl, path, parser, connectTimeoutMs, init);

Change the URL option description to LUWI daemon loopback URL. Replace each attach-local direct
request call with callDaemon:

    callDaemon('/api/v1/projects', projectCollectionResponseSchema)

    callDaemon('/api/v1/sessions', sessionResponseSchema, jsonBody(input))

    callDaemon(
      '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/heartbeat',
      heartbeatResponseSchema,
      jsonBody({}),
    )

    callDaemon(
      '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/close',
      sessionResponseSchema,
      jsonBody({}),
    )

    callDaemon(
      '/api/v1/leases?sessionId=' + encodeURIComponent(sessionId) + '&limit=1000',
      leaseCollectionSchema,
    )

    callDaemon(
      '/api/v1/leases/' + encodeURIComponent(leaseId) + '/renew',
      workLeaseSchema,
      jsonBody({ sessionId, durationMs }),
    )

Do not change the agent run client; it already uses boundedRequest.

- [ ] **Step 7: Install stop signals before initial registration**

Replace the current post-start Promise block with one idempotent stop promise created before
bootstrap.start:

    let stopRequested = false;
    let resolveStop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const stop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      dependencies.signals.off('SIGINT', stop);
      dependencies.signals.off('SIGTERM', stop);
      resolveStop?.();
    };
    dependencies.signals.once('SIGINT', stop);
    dependencies.signals.once('SIGTERM', stop);

    try {
      await bootstrap.start();
      if (bootstrap.sessionId !== undefined) {
        printJson(dependencies, { attached: bootstrap.sessionId, ...request_ });
      }
      await stopped;
    } finally {
      dependencies.signals.off('SIGINT', stop);
      dependencies.signals.off('SIGTERM', stop);
      await bootstrap.stop();
    }

Delete the previous listener Promise and trailing standalone bootstrap.stop call. Do not await any
in-flight heartbeat from stop; createSessionBootstrap already invalidates the lifecycle generation,
clears both intervals first, and performs only client.close afterward.

- [ ] **Step 8: Run attach and bootstrap tests and confirm GREEN**

Run:

    .\node_modules\.bin\vitest.cmd run apps/cli/src/cli.test.ts -t "session attach"

Expected: PASS.

Run the shared state-machine regression:

    .\node_modules\.bin\vitest.cmd run packages/runtime/src/session-bootstrap.test.ts

Expected: PASS, especially the parameterized SESSION_NOT_FOUND / SESSION_TERMINAL replacement test,
the late-registration-after-stop test, timer serialization, and automatic lease-renewal tests.

- [ ] **Step 9: Review checkpoint**

Confirm that all six attach-side daemon paths use callDaemon, timeout errors remain observational,
listeners are removed on every exit path, and no native agent process is signaled.

Suggested commit message if the user later authorizes commits:

    fix(cli): bound session attach across sleep and shutdown

---

### Task 4: Record the binding lifecycle decision

**Files:**

- Create: docs/decisions/0030-sleep-wake-agent-lifecycle.md
- Modify: docs/architecture/overview.md
- Modify: README.md
- Modify: AGENTS.md
- Verify: docs/superpowers/specs/2026-09-07-sleep-wake-agent-lifecycle-design.md

**Interfaces:**

- Consumes: the implemented DaemonOwnershipLease.reacquire and session attach
  --connect-timeout-ms behavior
- Produces: one accepted ADR plus synchronized architecture, operator, and repository constraints

- [ ] **Step 1: Write ADR 0030 with the implemented facts**

Create docs/decisions/0030-sleep-wake-agent-lifecycle.md with Status: Accepted and Date: 2026-09-07.
The ADR must state all of these exact decisions:

1. Sleep can outlast both 15-second TTLs while pausing Node timers.
2. A previously owning daemon may restore only a vacant owner key through SET NX PX with its existing
   token; it drains when another token exists.
3. Reacquisition is recovery, not startup: runtimeInstanceId remains stable and no second
   runtime.started event is appended.
4. session attach uses AbortController deadlines on discovery, register, heartbeat, close, lease
   list, and lease renew, defaulting to 2,000 ms.
5. SESSION_NOT_FOUND and SESSION_TERMINAL continue to rotate to a new LUWI session; leases do not
   transfer.
6. Managed cleanup is exact for agent run and Claude, bounded by 30-minute inactivity for
   Antigravity, and explicit for manual session attach.
7. Larger TTLs, elapsed-time sleep detection, wake tasks, services, and watchdogs remain rejected.

Consequences must explicitly say that the native agent is neither stopped nor restarted, a competing
daemon is never overwritten, remote cleanup failure cannot keep a helper forever, and a replacement
session may temporarily appear beside the terminal historical session.

- [ ] **Step 2: Synchronize architecture and user documentation**

In docs/architecture/overview.md, extend the ownership-recovery paragraph to say:

- recovery first verifies the current token;
- an absent key can be atomically reclaimed by the same active lease;
- a competing token still forces drain;
- Function, Stream/group, pending-work, and canonical-state checks still precede ready.

In README.md, immediately after the launcher-side session attach paragraph, add a short
Sleep/wake-safe lifecycle paragraph covering:

- automatic vacant-key owner reacquisition;
- new-session rotation after presence expiry;
- the 2-second default --connect-timeout-ms;
- bounded helper cleanup;
- the Antigravity 30-minute limitation.

Also update the security/architecture owner-lease bullet so it says acquisition and vacant-key
reacquisition are both atomic and never replace another token.

- [ ] **Step 3: Synchronize repository instructions**

In AGENTS.md:

- add ADR 0030 to the decision list;
- amend the single-daemon ownership rule so only a process that previously acquired ownership may
  reclaim an absent key, always through SET NX PX, and any competing token forces drain;
- add test coverage for sleep-expired owner reacquisition, contention, bounded attach requests, and
  bounded cleanup;
- update the immediate-objective implementation record without describing unrun tests as passing.

Do not alter unrelated phase prohibitions.

- [ ] **Step 4: Check documentation against code**

Search for stale claims:

    rg -n "ownership loss|owner lease|session attach|connect-timeout|sleep|wake" AGENTS.md README.md docs/architecture docs/decisions

Expected: no passage says every ownership loss unconditionally stops the daemon, no passage claims
Antigravity has an exact end event, and no passage describes a service or wake task as implemented.

- [ ] **Step 5: Review checkpoint**

Confirm ADR context, decision, consequences, and Accepted status are present and every public claim
matches behavior actually implemented and tested.

Suggested commit message if the user later authorizes commits:

    docs: record sleep-safe agent lifecycle

---

### Task 5: Full verification and clean handoff

**Files:**

- Verify every file listed in the file map
- Modify only to correct a verified formatting, type, lint, test, or documentation failure within
  this feature's scope

**Interfaces:**

- Consumes: all Task 1 through Task 4 outputs
- Produces: test evidence, clean diff evidence, and an honest completion report

- [ ] **Step 1: Run the focused behavioral suite**

Run:

    .\node_modules\.bin\vitest.cmd run packages/redis/src/daemon-ownership.test.ts apps/daemon/src/daemon-ownership-recovery.test.ts apps/daemon/src/runtime.test.ts packages/runtime/src/session-bootstrap.test.ts apps/cli/src/cli.test.ts

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run Redis integration evidence when configured**

If LUWI_TEST_REDIS_URL is present, run:

    .\node_modules\.bin\vitest.cmd run --config vitest.integration.config.ts packages/redis/src/daemon-ownership.integration.test.ts

Expected: PASS. If the variable is absent, report this exact test as SKIPPED and do not point it at
redis://127.0.0.1:6379 implicitly.

- [ ] **Step 3: Format-check the touched files**

Use the local Windows executable directly:

    .\node_modules\.bin\prettier.cmd --check packages/redis/src/daemon-ownership.ts packages/redis/src/daemon-ownership.test.ts packages/redis/src/daemon-ownership.integration.test.ts apps/daemon/src/daemon-ownership-recovery.ts apps/daemon/src/daemon-ownership-recovery.test.ts apps/daemon/src/runtime.ts apps/daemon/src/runtime.test.ts apps/cli/src/cli.ts apps/cli/src/cli.test.ts docs/decisions/0030-sleep-wake-agent-lifecycle.md docs/architecture/overview.md README.md AGENTS.md docs/superpowers/specs/2026-09-07-sleep-wake-agent-lifecycle-design.md docs/superpowers/plans/2026-09-07-sleep-wake-agent-lifecycle.md

Expected: all listed files use Prettier formatting. If not, use the same executable with --write only
on the listed files, then rerun --check.

- [ ] **Step 4: Run repository gates**

Run each command separately:

    pnpm.cmd typecheck

    pnpm.cmd lint

    pnpm.cmd test

    pnpm.cmd build

Expected: every command exits 0. Do not claim pnpm.cmd test covers Redis integration; it explicitly
excludes integration tests.

- [ ] **Step 5: Inspect the final diff without touching unrelated work**

Run:

    git diff --check

    git status --short

    git diff -- packages/redis/src/daemon-ownership.ts packages/redis/src/daemon-ownership.test.ts packages/redis/src/daemon-ownership.integration.test.ts apps/daemon/src/daemon-ownership-recovery.ts apps/daemon/src/daemon-ownership-recovery.test.ts apps/daemon/src/runtime.ts apps/daemon/src/runtime.test.ts apps/cli/src/cli.ts apps/cli/src/cli.test.ts docs/decisions/0030-sleep-wake-agent-lifecycle.md docs/architecture/overview.md README.md AGENTS.md docs/superpowers/specs/2026-09-07-sleep-wake-agent-lifecycle-design.md

Expected: git diff --check is silent; status contains no generated build output, Redis data, secrets,
or accidental files. Remember that unstaged new files are not printed by git diff, so read each new
file directly before handoff.

- [ ] **Step 6: Report completion evidence**

Report:

- files created and modified;
- each command actually run and its pass/fail/skip count;
- whether LUWI_TEST_REDIS_URL allowed the real-Redis test;
- the preserved dirty-worktree files that predated this feature;
- that no commit was created unless the user separately authorized it;
- any unresolved limitation, especially Antigravity's lack of an exact end event.

Suggested final combined commit message if the user later authorizes one commit instead of the three
review checkpoints:

    fix: recover agent observation safely after sleep
