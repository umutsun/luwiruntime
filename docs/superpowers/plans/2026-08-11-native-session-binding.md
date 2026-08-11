# Native Session Binding Implementation Plan (A1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client declare its vendor-native session identity when it registers a LUWI session, so that a durable, exact, time-bounded mapping exists between a native transcript session and the LUWI sessions it produced.

**Architecture:** A stable `NativeSessionBinding` holds the adapter-scoped native identity; immutable `NativeSessionLink` records hold each exact association with a LUWI session over `[linkedAt, unlinkedAt)`. Product policy lives in a pure function in `@luwi/runtime`; Redis Functions validate the state that decision was based on (compare-and-set on a monotonic `version`), then apply the decided mutation atomically together with its events.

**Tech Stack:** TypeScript ESM, Zod, Fastify, Redis Functions (Lua) on Memurai 4.1.2 / `redis_version:7.2.5`, Vitest.

## Global Constraints

- Source of truth: `docs/superpowers/specs/2026-08-11-native-session-binding-design.md`. Where this plan and the spec disagree, the spec wins and the plan is wrong.
- **Scope:** this plan is **A1**. Link retention (spec §11) is **A2** and is not implemented here. Per spec §0, A1 accumulates closed links without bound, leaves `trimmedLinkCount` at `0` and `oldestRetainedLinkedAt` absent, and **is not by itself acceptance of A**.
- Run every command from the repository root. Node >= 22 (this machine runs v26.3.0), pnpm 11.9.0.
- `pnpm test` includes dashboard tests. `tsc -b` does **not** cover `apps/dashboard`; `pnpm typecheck` and `pnpm build` each have a separate dashboard leg.
- `exactOptionalPropertyTypes` is on. Optional properties are added with a conditional spread — `...(x === undefined ? {} : { key: x })` — never as `key: undefined`.
- `@luwi/protocol` and `@luwi/runtime` must never import `redis`. `@luwi/mcp-server` must never import `@luwi/redis`.
- **Nothing added in this plan may be exported from `packages/protocol/src/browser.ts`.** There is no dashboard consumer, and `apps/dashboard/vite.config.test.ts` runs a real Rollup build that fails on a Node builtin in the browser entry.
- **Redis Functions must never derive a key name.** Every key a Function touches is declared by the caller.
- **Every timestamp in this domain comes from the transition's Redis clock** (`redis_now()`), never from the daemon: `linkedAt`, `unlinkedAt`, `firstLinkedAt`, `lastLinkedAt`, and both new events' `occurredAt`.
- **Test database selection is a verification, not an assumption.** `/15` on this machine currently holds seeded fixture data. Before running integration tests, prove the target database is empty (Task 0). Never target `db0`, which holds live development state.
- PowerShell 5.1 has no `&&`. Write verification commands as separate commands, or as `A; if ($?) { B }`.
- Per `AGENTS.md` section 13 and `CLAUDE.md`, **do not run `git commit` unless the user explicitly asks.** Commit steps are written out so they can be approved in one act; without that approval, finish each task's other steps and stop.
- Never claim a command passed unless it actually ran and succeeded.

## File structure

| File                                                          | Responsibility                                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/native-session.ts` (new)               | Ref, kind, binding and link schemas. No `browser.ts` export.                                                                       |
| `packages/protocol/src/runtime-event.ts` (modify)             | Two new event types in the closed enum.                                                                                            |
| `packages/runtime/src/native-session-identity.ts` (new)       | `deriveNativeBindingId`, `deriveNativeLinkId`, `deriveNativeKind`, `deriveParentRef`.                                              |
| `packages/runtime/src/native-session-policy.ts` (new)         | The six-outcome pure policy and the CAS decision it produces.                                                                      |
| `packages/redis/src/redis-keys.ts` (modify)                   | Four new key builders.                                                                                                             |
| `packages/redis/src/function-library.ts` (modify)             | `stream_has_capacity`, `native_validate`, `native_apply`, `native_unlink`; `session_register` 9→14 keys; three terminal paths 5→7. |
| `packages/redis/src/function-registry.ts` (modify)            | Library version 10 → 11.                                                                                                           |
| `packages/redis/src/runtime-repository.ts` (modify)           | Call sites, native result parsing, binding and link reads, unlink call.                                                            |
| `packages/redis/src/native-session.integration.test.ts` (new) | The Redis behaviour matrix.                                                                                                        |
| `apps/daemon/src/session-service.ts` (modify)                 | Registration CAS loop, terminal CAS loops, 409 mapping.                                                                            |
| `apps/daemon/src/runtime.ts` (modify)                         | The presence sweeper's disconnect path resolves and closes the link.                                                               |
| `apps/daemon/src/app.ts` (modify)                             | Optional `native` block reaches the service.                                                                                       |

---

### Task 0: Prove the integration test database is safe

This task exists because `/15` is not a clean dedicated database on this machine. Running the suite against seeded fixture data would mix runtime state with test state and could make a later `FLUSHDB` destructive.

**Files:** none. This is a verification gate.

- [ ] **Step 1: List every database that holds data**

Run:

```bash
"/c/Program Files/Memurai/memurai-cli.exe" INFO keyspace
```

Expected: a list such as `db0:keys=3441,...` and `db15:keys=459,...`. `db0` is live development state and is never a candidate.

- [ ] **Step 2: Pick an empty database and prove it is empty**

Choose a database index that did **not** appear in Step 1 — `14` unless Step 1 shows otherwise. Prove it read-only:

```bash
"/c/Program Files/Memurai/memurai-cli.exe" -n 14 DBSIZE
```

Expected: `(integer) 0`. If it is not `0`, choose another index and repeat. **Do not delete anything to make room.**

- [ ] **Step 3: Record the choice**

Every later integration step in this plan uses:

```bash
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/14 LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true pnpm test:integration
```

Substitute the verified index for `14`. In PowerShell set the variables as separate commands rather than chaining with `&&`:

```powershell
$env:LUWI_TEST_REDIS_URL = 'redis://127.0.0.1:6379/14'
$env:LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS = 'true'
pnpm test:integration
```

- [ ] **Step 4: Confirm the Function libraries present**

Run:

```bash
"/c/Program Files/Memurai/memurai-cli.exe" FUNCTION LIST LIBRARYNAME luwi_v1
```

Expected: `luwi_v1` exists. Function libraries are server-scoped, not per-database, which is why `LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true` is required. **Never run `FUNCTION FLUSH`** — it would unload `luwi_v1` and break the running daemon.

---

### Task 1: Protocol types and event types

**Files:**

- Create: `packages/protocol/src/native-session.ts`
- Create: `packages/protocol/src/native-session.test.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/runtime-event.ts`
- Modify: `packages/protocol/src/runtime-event.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `nativeSessionRefSchema`, `nativeSessionKindSchema`, `nativeSessionBindingSchema`, `nativeSessionLinkSchema`; types `NativeSessionRef`, `NativeSessionKind`, `NativeSessionBinding`, `NativeSessionLink`; and the event types `session.native.linked` and `session.native.unlinked` accepted by `runtimeEventTypeSchema`.

- [ ] **Step 1: Write the failing schema test**

Create `packages/protocol/src/native-session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  nativeSessionBindingSchema,
  nativeSessionLinkSchema,
  nativeSessionRefSchema,
} from './native-session.js';

const timestamp = '2026-08-11T00:00:00.000Z';

describe('native session ref', () => {
  it('accepts a main session reference and a subagent reference', () => {
    expect(
      nativeSessionRefSchema.parse({
        adapterId: 'claude-code-native-v1',
        nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
      }).nativeSubagentId,
    ).toBeUndefined();
    expect(
      nativeSessionRefSchema.parse({
        adapterId: 'claude-code-native-v1',
        nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
        nativeSubagentId: 'agent-a06de43343c462b9b',
      }).nativeSubagentId,
    ).toBe('agent-a06de43343c462b9b');
  });

  it('rejects identifiers that could not be carried safely', () => {
    for (const nativeSessionId of [
      '',
      ' ',
      '-leading',
      'has space',
      'has/slash',
      'a'.repeat(201),
    ]) {
      expect(
        nativeSessionRefSchema.safeParse({ adapterId: 'claude-code-native-v1', nativeSessionId })
          .success,
        nativeSessionId,
      ).toBe(false);
    }
  });
});

describe('native session binding', () => {
  const binding = {
    id: 'b'.repeat(64),
    adapterId: 'claude-code-native-v1',
    nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
    kind: 'main' as const,
    version: 1,
    linkCount: 1,
    trimmedLinkCount: 0,
    firstLinkedAt: timestamp,
    lastLinkedAt: timestamp,
  };

  it('accepts a binding with no open link', () => {
    expect(nativeSessionBindingSchema.parse(binding).openLinkId).toBeUndefined();
  });

  /**
   * The binding is identity, not liveness and not scope. A presence, project,
   * agent or confidence field here would be a claim the record cannot support.
   */
  it('rejects presence, project, agent and confidence fields', () => {
    for (const extra of [
      { presence: 'online' },
      { projectId: 'project-1' },
      { agentId: 'codex-main' },
      { agentDefinitionId: 'codex-main' },
      { confidence: 'exact' },
      { latestSessionId: 'session-1' },
    ]) {
      expect(nativeSessionBindingSchema.safeParse({ ...binding, ...extra }).success).toBe(false);
    }
  });

  it('rejects a negative version or a fractional link count', () => {
    expect(nativeSessionBindingSchema.safeParse({ ...binding, version: -1 }).success).toBe(false);
    expect(nativeSessionBindingSchema.safeParse({ ...binding, linkCount: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('native session link', () => {
  const link = {
    id: 'l'.repeat(64),
    bindingId: 'b'.repeat(64),
    sessionId: 'session-1',
    linkedAt: timestamp,
  };

  it('accepts an open link and a closed link', () => {
    expect(nativeSessionLinkSchema.parse(link).unlinkedAt).toBeUndefined();
    expect(
      nativeSessionLinkSchema.parse({ ...link, unlinkedAt: '2026-08-11T00:05:00.000Z' }).unlinkedAt,
    ).toBe('2026-08-11T00:05:00.000Z');
  });

  it('rejects an unknown field, so a link cannot smuggle evidence', () => {
    expect(nativeSessionLinkSchema.safeParse({ ...link, transcriptPath: 'C:/x' }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Write the failing event-type test**

Append to `packages/protocol/src/runtime-event.test.ts`:

```ts
describe('native session event types', () => {
  /**
   * `runtimeEventTypeSchema` is a closed enum. An event type missing from it is
   * written to the Stream and then rejected by the repository parser and the
   * realtime relay, so the write succeeds and the notification never arrives.
   */
  it('accepts the two native binding event types', () => {
    for (const type of ['session.native.linked', 'session.native.unlinked']) {
      expect(runtimeEventTypeSchema.safeParse(type).success, type).toBe(true);
    }
  });
});
```

Ensure `runtimeEventTypeSchema` is in that file's import list.

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm vitest run packages/protocol/src/native-session.test.ts packages/protocol/src/runtime-event.test.ts`

Expected: FAIL — `./native-session.js` cannot be resolved, and the two event types are rejected.

- [ ] **Step 4: Create the schemas**

Create `packages/protocol/src/native-session.ts`:

```ts
import { z } from 'zod';

/**
 * Vendor-native session identity, namespaced by adapter.
 *
 * The charset is deliberately narrow: both Claude Code forms — a UUID stem and
 * an `agent-<hex>` stem — fit it. A vendor that needs more is a reason to widen
 * this with that vendor's layout in hand, rather than to speculate now.
 *
 * Deliberately absent from the binding: presence, project, agent,
 * AgentDefinition and confidence. The binding is identity. Liveness comes from
 * the session's own heartbeat and TTL; scope comes from the linked session.
 */

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

const nativeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

export const nativeSessionRefSchema = z.strictObject({
  adapterId: identifierSchema,
  nativeSessionId: nativeIdSchema,
  nativeSubagentId: nativeIdSchema.optional(),
});

export const nativeSessionKindSchema = z.enum(['main', 'subagent']);

export const nativeSessionBindingSchema = z.strictObject({
  id: identifierSchema,
  adapterId: identifierSchema,
  nativeSessionId: nativeIdSchema,
  nativeSubagentId: nativeIdSchema.optional(),
  kind: nativeSessionKindSchema,
  parentRef: nativeSessionRefSchema.optional(),
  openLinkId: identifierSchema.optional(),
  version: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  /** Always 0 in A1; retention is A2. The field exists so A2 needs no migration. */
  trimmedLinkCount: z.number().int().nonnegative(),
  oldestRetainedLinkedAt: timestampSchema.optional(),
  /** Link creations, not declaration attempts: an `unchanged` outcome writes nothing. */
  firstLinkedAt: timestampSchema,
  lastLinkedAt: timestampSchema,
});

export const nativeSessionLinkSchema = z.strictObject({
  id: identifierSchema,
  bindingId: identifierSchema,
  sessionId: identifierSchema,
  linkedAt: timestampSchema,
  unlinkedAt: timestampSchema.optional(),
});

export type NativeSessionRef = z.infer<typeof nativeSessionRefSchema>;
export type NativeSessionKind = z.infer<typeof nativeSessionKindSchema>;
export type NativeSessionBinding = z.infer<typeof nativeSessionBindingSchema>;
export type NativeSessionLink = z.infer<typeof nativeSessionLinkSchema>;
```

- [ ] **Step 5: Add the event types**

In `packages/protocol/src/runtime-event.ts`, add to `runtimeEventTypeSchema`, immediately after `'session.disconnected'`:

```ts
  /**
   * A native session reference was bound to, or released from, a LUWI session.
   * Identifiers only: no transcript content, no path, no native payload.
   */
  'session.native.linked',
  'session.native.unlinked',
```

- [ ] **Step 6: Export from the package index**

In `packages/protocol/src/index.ts`, add:

```ts
export {
  nativeSessionBindingSchema,
  nativeSessionKindSchema,
  nativeSessionLinkSchema,
  nativeSessionRefSchema,
} from './native-session.js';
export type {
  NativeSessionBinding,
  NativeSessionKind,
  NativeSessionLink,
  NativeSessionRef,
} from './native-session.js';
```

Do **not** add anything to `browser.ts`.

- [ ] **Step 7: Prove the realtime relay accepts the new events**

Append to `apps/daemon/src/realtime-relay.test.ts`, using that file's existing event factory and relay harness:

```ts
it('relays a native link event rather than dropping it as invalid', async () => {
  // Build a session.native.linked event with the file's existing factory,
  // append it through the same path the other relay cases use, and assert it
  // reaches the hub and does not increment the invalid-event counter.
});
```

Fill the body using the neighbouring cases in that file as the model before running it.

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run packages/protocol/src apps/daemon/src/realtime-relay.test.ts apps/dashboard/vite.config.test.ts`

Expected: PASS. The bundle guard is included because it is the test that fails if a Node builtin reaches the browser entry.

- [ ] **Step 9: Commit**

```bash
git add packages/protocol/src/native-session.ts packages/protocol/src/native-session.test.ts packages/protocol/src/index.ts packages/protocol/src/runtime-event.ts packages/protocol/src/runtime-event.test.ts apps/daemon/src/realtime-relay.test.ts
git commit -m "feat: add native session binding protocol and event types"
```

---

### Task 2: Identifier derivation

**Files:**

- Create: `packages/runtime/src/native-session-identity.ts`
- Create: `packages/runtime/src/native-session-identity.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**

- Consumes: `NativeSessionRef`, `NativeSessionKind` from Task 1.
- Produces: `deriveNativeBindingId(ref): string`, `deriveNativeLinkId(bindingId, sessionId): string`, `deriveNativeKind(ref): NativeSessionKind`, `deriveParentRef(ref): NativeSessionRef | undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/src/native-session-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  deriveNativeBindingId,
  deriveNativeKind,
  deriveNativeLinkId,
  deriveParentRef,
} from './native-session-identity.js';

const main = {
  adapterId: 'claude-code-native-v1',
  nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
};
const subagent = { ...main, nativeSubagentId: 'agent-a06de43343c462b9b' };

describe('native binding identity', () => {
  it('is deterministic, which is what makes a declaration idempotent', () => {
    expect(deriveNativeBindingId(main)).toBe(deriveNativeBindingId({ ...main }));
    expect(deriveNativeBindingId(main)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('namespaces by adapter, so two vendors cannot collide on one native id', () => {
    expect(deriveNativeBindingId(main)).not.toBe(
      deriveNativeBindingId({ ...main, adapterId: 'codex-native-v1' }),
    );
  });

  it('separates a subagent from its parent', () => {
    expect(deriveNativeBindingId(subagent)).not.toBe(deriveNativeBindingId(main));
  });

  /**
   * Without a separator, ('ab', 'c') and ('a', 'bc') hash identically. The NUL
   * byte cannot occur inside a validated native id, so it is unambiguous.
   */
  it('cannot be confused by concatenation across adjacent fields', () => {
    expect(
      deriveNativeBindingId({ adapterId: 'ab', nativeSessionId: 'cd', nativeSubagentId: 'ef' }),
    ).not.toBe(
      deriveNativeBindingId({ adapterId: 'a', nativeSessionId: 'bcd', nativeSubagentId: 'ef' }),
    );
    expect(deriveNativeBindingId({ adapterId: 'ab', nativeSessionId: 'cd' })).not.toBe(
      deriveNativeBindingId({ adapterId: 'abcd', nativeSessionId: 'x' }),
    );
  });
});

describe('native link identity', () => {
  it('is deterministic per binding and session', () => {
    const bindingId = deriveNativeBindingId(main);
    expect(deriveNativeLinkId(bindingId, 'session-1')).toBe(
      deriveNativeLinkId(bindingId, 'session-1'),
    );
    expect(deriveNativeLinkId(bindingId, 'session-1')).not.toBe(
      deriveNativeLinkId(bindingId, 'session-2'),
    );
  });
});

describe('derived reference fields', () => {
  it('derives kind rather than accepting it', () => {
    expect(deriveNativeKind(main)).toBe('main');
    expect(deriveNativeKind(subagent)).toBe('subagent');
  });

  it('derives a parent reference only for a subagent', () => {
    expect(deriveParentRef(main)).toBeUndefined();
    expect(deriveParentRef(subagent)).toEqual(main);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/runtime/src/native-session-identity.test.ts`

Expected: FAIL, module cannot be resolved.

- [ ] **Step 3: Implement the derivation**

Create `packages/runtime/src/native-session-identity.ts`:

```ts
import { createHash } from 'node:crypto';

import type { NativeSessionKind, NativeSessionRef } from '@luwi/protocol';

/**
 * Identifiers derived from a native reference.
 *
 * They are deterministic so that a repeated declaration is idempotent rather
 * than duplicating state, and `adapterId` leads the binding preimage so two
 * vendors cannot collide on an identical native identifier.
 *
 * The NUL separator is not decoration. Without it `('ab', 'cd')` and
 * `('a', 'bcd')` would hash identically; NUL cannot appear inside a value that
 * passed `nativeSessionRefSchema`, so it is an unambiguous boundary.
 *
 * A raw native value never reaches a Redis key: `keyPart` would reject many of
 * them, and hashing is the precedent `projectPathIndex` already set.
 */

const SEPARATOR = '\u0000';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function deriveNativeBindingId(ref: NativeSessionRef): string {
  return sha256([ref.adapterId, ref.nativeSessionId, ref.nativeSubagentId ?? ''].join(SEPARATOR));
}

export function deriveNativeLinkId(bindingId: string, sessionId: string): string {
  return sha256([bindingId, sessionId].join(SEPARATOR));
}

export function deriveNativeKind(ref: NativeSessionRef): NativeSessionKind {
  return ref.nativeSubagentId === undefined ? 'main' : 'subagent';
}

/** A subagent's parent is its reference minus the subagent identifier. */
export function deriveParentRef(ref: NativeSessionRef): NativeSessionRef | undefined {
  return ref.nativeSubagentId === undefined
    ? undefined
    : { adapterId: ref.adapterId, nativeSessionId: ref.nativeSessionId };
}
```

- [ ] **Step 4: Export from the package index**

In `packages/runtime/src/index.ts`, add:

```ts
export {
  deriveNativeBindingId,
  deriveNativeKind,
  deriveNativeLinkId,
  deriveParentRef,
} from './native-session-identity.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/runtime/src/native-session-identity.test.ts`

Expected: PASS, all seven cases.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/native-session-identity.ts packages/runtime/src/native-session-identity.test.ts packages/runtime/src/index.ts
git commit -m "feat: derive native binding and link identifiers"
```

---

### Task 3: The pure declaration policy

**Files:**

- Create: `packages/runtime/src/native-session-policy.ts`
- Create: `packages/runtime/src/native-session-policy.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**

- Consumes: `NativeSessionBinding` from Task 1.
- Produces: `NativeOpenLinkObservation`, `NativeDeclarationObservation`, `NativeDeclarationDecision`, `evaluateNativeDeclaration`, `NATIVE_DECLARATION_MAX_ATTEMPTS = 3`.

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/src/native-session-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  evaluateNativeDeclaration,
  NATIVE_DECLARATION_MAX_ATTEMPTS,
} from './native-session-policy.js';

const timestamp = '2026-08-11T00:00:00.000Z';

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b'.repeat(64),
    adapterId: 'claude-code-native-v1',
    nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
    kind: 'main' as const,
    version: 4,
    linkCount: 2,
    trimmedLinkCount: 0,
    firstLinkedAt: timestamp,
    lastLinkedAt: timestamp,
    ...overrides,
  };
}

describe('native declaration policy', () => {
  it('creates a binding when none exists, expecting an absent key', () => {
    expect(
      evaluateNativeDeclaration({ binding: undefined, openLink: undefined, sessionId: 's1' }),
    ).toEqual({ outcome: 'created', expectedVersion: 0 });
  });

  it('links when the binding exists with no open link', () => {
    expect(
      evaluateNativeDeclaration({ binding: binding(), openLink: undefined, sessionId: 's2' }),
    ).toEqual({ outcome: 'linked', expectedVersion: 4 });
  });

  it('is idempotent when the open link already points at this session', () => {
    expect(
      evaluateNativeDeclaration({
        binding: binding({ openLinkId: 'l1' }),
        openLink: { id: 'l1', sessionId: 's3', sessionStatus: 'thinking' },
        sessionId: 's3',
      }),
    ).toEqual({ outcome: 'unchanged' });
  });

  /** A live holder is reported, never evicted. */
  it('conflicts when another non-terminal session holds the reference', () => {
    for (const sessionStatus of ['starting', 'idle', 'thinking', 'tool_running', 'blocked']) {
      expect(
        evaluateNativeDeclaration({
          binding: binding({ openLinkId: 'l1' }),
          openLink: { id: 'l1', sessionId: 'held', sessionStatus },
          sessionId: 'new',
        }),
        sessionStatus,
      ).toEqual({ outcome: 'conflict', heldBySessionId: 'held' });
    }
  });

  it('links over a stale open link without mutating the old session', () => {
    for (const sessionStatus of ['completed', 'disconnected']) {
      expect(
        evaluateNativeDeclaration({
          binding: binding({ openLinkId: 'l1' }),
          openLink: { id: 'l1', sessionId: 'old', sessionStatus },
          sessionId: 'new',
        }),
        sessionStatus,
      ).toEqual({
        outcome: 'linked',
        expectedVersion: 4,
        expectedOpenLinkId: 'l1',
        staleLinkId: 'l1',
      });
    }
  });

  /**
   * The binding says someone holds the reference and the record that says who
   * is gone. Writing a fresh link here would destroy the discrepancy instead of
   * reporting it, so the declaration fails and the state stays inspectable.
   */
  it('reports an unreadable open link as inconsistent rather than as free', () => {
    expect(
      evaluateNativeDeclaration({
        binding: binding({ openLinkId: 'l1' }),
        openLink: undefined,
        sessionId: 'new',
      }),
    ).toEqual({ outcome: 'inconsistent', openLinkId: 'l1' });
  });

  it('bounds contention retries', () => {
    expect(NATIVE_DECLARATION_MAX_ATTEMPTS).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/runtime/src/native-session-policy.test.ts`

Expected: FAIL, module cannot be resolved.

- [ ] **Step 3: Implement the policy**

Create `packages/runtime/src/native-session-policy.ts`:

```ts
import type { NativeSessionBinding, SessionStatus } from '@luwi/protocol';

/**
 * The product decision for a native declaration, made here and nowhere else.
 *
 * Lua never owns this. The daemon reads the binding and the linked session's
 * state, this function turns that observation into one outcome, and the Redis
 * Function only validates that the observation still holds before applying the
 * decision. That split is what keeps a Function from having to derive another
 * session's key name, which AGENTS.md section 7 forbids.
 */

export type NativeOpenLinkObservation = {
  id: string;
  sessionId: string;
  sessionStatus: SessionStatus;
};

export type NativeDeclarationObservation = {
  binding: NativeSessionBinding | undefined;
  /**
   * The link named by `binding.openLinkId`, together with its session's status.
   * `undefined` means the binding named an open link whose record could not be
   * read — which is a fault, not a free reference.
   */
  openLink: NativeOpenLinkObservation | undefined;
  /** The LUWI session being registered. */
  sessionId: string;
};

export type NativeDeclarationDecision =
  | {
      outcome: 'created' | 'linked';
      /** `0` means "the binding key must not exist". */
      expectedVersion: number;
      expectedOpenLinkId?: string;
      /** An open link over a terminal session, closed by the same transition. */
      staleLinkId?: string;
    }
  | { outcome: 'unchanged' }
  | { outcome: 'conflict'; heldBySessionId: string }
  | { outcome: 'inconsistent'; openLinkId: string };

/** One initial attempt plus two retries. */
export const NATIVE_DECLARATION_MAX_ATTEMPTS = 3;

function isTerminal(status: SessionStatus): boolean {
  return status === 'completed' || status === 'disconnected';
}

export function evaluateNativeDeclaration(
  observation: NativeDeclarationObservation,
): NativeDeclarationDecision {
  const { binding, openLink, sessionId } = observation;

  if (binding === undefined) {
    return { outcome: 'created', expectedVersion: 0 };
  }

  if (binding.openLinkId === undefined) {
    return { outcome: 'linked', expectedVersion: binding.version };
  }

  if (openLink === undefined) {
    return { outcome: 'inconsistent', openLinkId: binding.openLinkId };
  }

  if (openLink.sessionId === sessionId) {
    return { outcome: 'unchanged' };
  }

  if (!isTerminal(openLink.sessionStatus)) {
    return { outcome: 'conflict', heldBySessionId: openLink.sessionId };
  }

  return {
    outcome: 'linked',
    expectedVersion: binding.version,
    expectedOpenLinkId: openLink.id,
    staleLinkId: openLink.id,
  };
}
```

- [ ] **Step 4: Export from the package index**

In `packages/runtime/src/index.ts`, add:

```ts
export {
  evaluateNativeDeclaration,
  NATIVE_DECLARATION_MAX_ATTEMPTS,
} from './native-session-policy.js';
export type {
  NativeDeclarationDecision,
  NativeDeclarationObservation,
  NativeOpenLinkObservation,
} from './native-session-policy.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run packages/runtime/src/native-session-policy.test.ts`

Expected: PASS, all seven cases.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/native-session-policy.ts packages/runtime/src/native-session-policy.test.ts packages/runtime/src/index.ts
git commit -m "feat: decide native declarations in a pure runtime policy"
```

---

### Task 4: Redis keys

**Files:**

- Modify: `packages/redis/src/redis-keys.ts`
- Modify: `packages/redis/src/redis-keys.test.ts`

**Interfaces:**

- Produces on `RedisKeys`: `nativeSessionBinding(bindingId)`, `nativeSessionLink(linkId)`, `nativeSessionLinks(bindingId)`, `sessionNativeBinding(sessionId)`.

- [ ] **Step 1: Write the failing test**

Append to `packages/redis/src/redis-keys.test.ts`:

```ts
describe('native session keys', () => {
  const keys = createRedisKeys();

  it('namespaces every native key under the library prefix', () => {
    expect(keys.nativeSessionBinding('b1')).toBe('luwi:v1:native-session:b1');
    expect(keys.nativeSessionLink('l1')).toBe('luwi:v1:native-session-link:l1');
    expect(keys.nativeSessionLinks('b1')).toBe('luwi:v1:index:native-session:b1:links');
    expect(keys.sessionNativeBinding('s1')).toBe('luwi:v1:index:session:s1:native');
  });

  it('rejects an unsafe identifier rather than building a key from it', () => {
    for (const unsafe of ['', 'has space', 'a/b', '-leading']) {
      expect(() => keys.nativeSessionBinding(unsafe)).toThrow('Unsafe Redis key identifier');
      expect(() => keys.nativeSessionLink(unsafe)).toThrow('Unsafe Redis key identifier');
      expect(() => keys.nativeSessionLinks(unsafe)).toThrow('Unsafe Redis key identifier');
      expect(() => keys.sessionNativeBinding(unsafe)).toThrow('Unsafe Redis key identifier');
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/redis/src/redis-keys.test.ts`

Expected: FAIL, `nativeSessionBinding` is not a function.

- [ ] **Step 3: Add the key builders**

In `packages/redis/src/redis-keys.ts`, add to the `RedisKeys` interface:

```ts
  nativeSessionBinding(bindingId: string): string;
  nativeSessionLink(linkId: string): string;
  nativeSessionLinks(bindingId: string): string;
  sessionNativeBinding(sessionId: string): string;
```

and to the object returned by `createRedisKeys`:

```ts
    nativeSessionBinding: (bindingId) => `${prefix}:native-session:${keyPart(bindingId)}`,
    nativeSessionLink: (linkId) => `${prefix}:native-session-link:${keyPart(linkId)}`,
    nativeSessionLinks: (bindingId) => `${prefix}:index:native-session:${keyPart(bindingId)}:links`,
    sessionNativeBinding: (sessionId) => `${prefix}:index:session:${keyPart(sessionId)}:native`,
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/redis/src/redis-keys.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/redis/src/redis-keys.ts packages/redis/src/redis-keys.test.ts
git commit -m "feat: add native session binding Redis keys"
```

---

### Task 5: Lua helpers — capacity, validate, apply, unlink

**Files:**

- Modify: `packages/redis/src/function-library.ts`

**Interfaces:**

- Produces four local Lua functions used by Tasks 6 and 7: `stream_has_capacity`, `native_validate`, `native_apply`, `native_unlink`.

- [ ] **Step 1: Add the multi-append capacity check**

The existing `stream_appendable` answers "can this stream ever be appended to again", which is not the question a two- or three-event transition asks. A stream whose last id is within `n-1` of the maximum passes that check, accepts the first append and rejects the next — leaving a projection written without one of its events.

In `packages/redis/src/function-library.ts`, add beside `stream_appendable`:

```ts
    "local MAX_STREAM_PART = '18446744073709551615'",
    'local STREAM_SEQ_HEADROOM = {',
    "  ['1'] = '18446744073709551614',",
    "  ['2'] = '18446744073709551613',",
    "  ['3'] = '18446744073709551612'",
    '}',
    '-- Capacity for `needed` further appends, not merely for one.',
    'local function stream_has_capacity(key, needed)',
    "  if key_type(key) == 'none' then return true end",
    "  local info = redis.call('XINFO', 'STREAM', key)",
    '  local last = nil',
    '  for index = 1, #info, 2 do',
    "    if info[index] == 'last-generated-id' then last = info[index + 1] end",
    '  end',
    '  if last == nil then return false end',
    "  local ms, seq = string.match(last, '^(%d+)%-(%d+)$')",
    '  if ms == nil then return false end',
    '  -- Below the final millisecond Redis rolls over to ms+1, so room remains.',
    '  if #ms < #MAX_STREAM_PART or ms ~= MAX_STREAM_PART then return true end',
    '  local threshold = STREAM_SEQ_HEADROOM[tostring(needed)]',
    '  if threshold == nil then return false end',
    '  if #seq < #threshold then return true end',
    '  if #seq > #threshold then return false end',
    '  return seq <= threshold',
    'end',
```

Equal-length decimal strings compare correctly with `<=`, which is why the length is checked first.

- [ ] **Step 2: Add `native_validate`**

This performs **no mutation**. It is called before `XGROUP CREATE`, which creates a stream and is therefore itself a durable write.

```ts
    '-- Validates only. Any mutation here would break the "conflict writes nothing" rule.',
    '-- `session_id` and `link_id` are supplied by the caller; no key name is derived here.',
    'local function native_validate(binding_key, link_key, stale_key, native, session_id, link_id)',
    "  local function is_id(value) return type(value) == 'string' and value ~= '' end",
    "  if type(native) ~= 'table' then return 'REDIS_ARGUMENT_INVALID' end",
    "  if not is_id(native.bindingId) then return 'REDIS_ARGUMENT_INVALID' end",
    "  if type(native.link) ~= 'table' then return 'REDIS_ARGUMENT_INVALID' end",
    "  if not is_id(native.link.id) or not is_id(native.link.sessionId) then return 'REDIS_ARGUMENT_INVALID' end",
    '  local expected_version = tonumber(native.expectedVersion)',
    '  if not expected_version or expected_version < 0 or expected_version ~= math.floor(expected_version) then',
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    '  -- The declared link key must be the link the payload names, and the link must',
    '  -- belong to the session this transition is registering or closing.',
    "  if native.link.id ~= link_id then return 'REDIS_ARGUMENT_INVALID' end",
    "  if native.link.sessionId ~= session_id then return 'REDIS_ARGUMENT_INVALID' end",
    "  if native.expectedOpenLinkId ~= nil and not is_id(native.expectedOpenLinkId) then",
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    "  if native.staleLinkId ~= nil and not is_id(native.staleLinkId) then",
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    "  local exists = key_type(binding_key) ~= 'none'",
    '  if expected_version == 0 then',
    "    if exists then return 'VERSION_CONFLICT' end",
    "    if type(native.binding) ~= 'table' then return 'REDIS_ARGUMENT_INVALID' end",
    "    if native.binding.id ~= native.bindingId then return 'REDIS_ARGUMENT_INVALID' end",
    "    if native.staleLinkId ~= nil then return 'REDIS_ARGUMENT_INVALID' end",
    '  else',
    "    if not exists then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', binding_key, 'id') ~= native.bindingId then return 'VERSION_CONFLICT' end",
    "    local stored_version = tonumber(redis.call('HGET', binding_key, 'version'))",
    "    local stored_open = redis.call('HGET', binding_key, 'openLinkId')",
    "    if stored_version ~= expected_version then return 'VERSION_CONFLICT' end",
    '    if (stored_open or false) ~= (native.expectedOpenLinkId or false) then',
    "      return 'VERSION_CONFLICT'",
    '    end',
    '  end',
    '  if native.staleLinkId then',
    "    if key_type(stale_key) ~= 'hash' then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', stale_key, 'id') ~= native.staleLinkId then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', stale_key, 'bindingId') ~= native.bindingId then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', stale_key, 'unlinkedAt') then return 'VERSION_CONFLICT' end",
    '  end',
    "  if key_type(link_key) ~= 'none' then return 'VERSION_CONFLICT' end",
    '  return nil',
    'end',
```

The final check matters: a link key that already exists means this exact `(binding, session)` pair was linked before, and overwriting it would silently discard an earlier interval. The caller therefore passes `session_id` and `link_id` alongside the payload, so the Function compares the declared key entry against the payload rather than trusting either alone.

- [ ] **Step 3: Add `native_apply`**

Every timestamp comes from `clock`, the transition's own Redis clock.

```ts
    'local function native_apply(binding_key, link_key, links_key, reverse_key, stale_key, native, clock, unlinked_event_id, workspace_id)',
    '  local unlinked_event = nil',
    '  if native.staleLinkId then',
    "    redis.call('HSET', stale_key, 'unlinkedAt', clock.timestamp)",
    '    unlinked_event = {',
    "      id=unlinked_event_id, version=1, type='session.native.unlinked',",
    '      occurredAt=clock.timestamp, workspaceId=workspace_id,',
    '      payload={bindingId=native.bindingId, linkId=native.staleLinkId}',
    '    }',
    '  end',
    "  redis.call('HSET', link_key, 'id', native.link.id, 'bindingId', native.bindingId, 'sessionId', native.link.sessionId, 'linkedAt', clock.timestamp)",
    "  redis.call('ZADD', links_key, clock.milliseconds, native.link.id)",
    "  redis.call('SET', reverse_key, native.bindingId)",
    '  if tonumber(native.expectedVersion) == 0 then',
    "    redis.call('HSET', binding_key, 'id', native.binding.id, 'adapterId', native.binding.adapterId, 'nativeSessionId', native.binding.nativeSessionId, 'kind', native.binding.kind, 'version', 1, 'linkCount', 1, 'trimmedLinkCount', 0, 'firstLinkedAt', clock.timestamp, 'lastLinkedAt', clock.timestamp, 'openLinkId', native.link.id)",
    "    if native.binding.nativeSubagentId then redis.call('HSET', binding_key, 'nativeSubagentId', native.binding.nativeSubagentId) end",
    "    if native.binding.parentRefJson then redis.call('HSET', binding_key, 'parentRef', native.binding.parentRefJson) end",
    '  else',
    "    redis.call('HSET', binding_key, 'openLinkId', native.link.id, 'lastLinkedAt', clock.timestamp)",
    "    redis.call('HINCRBY', binding_key, 'linkCount', 1)",
    "    redis.call('HINCRBY', binding_key, 'version', 1)",
    '  end',
    '  return unlinked_event',
    'end',
```

- [ ] **Step 4: Add `native_unlink`**

`HSET` creates a hash that does not exist, so an unlink must prove the link is the one it means before writing. It also refuses a second close, which is what keeps `unlinkedAt` written exactly once.

```ts
    'local function native_unlink(binding_key, link_key, native, clock, event_id, workspace_id)',
    "  if type(native) ~= 'table' then return nil, 'REDIS_ARGUMENT_INVALID' end",
    '  local expected_version = tonumber(native.expectedVersion)',
    "  if not expected_version then return nil, 'REDIS_ARGUMENT_INVALID' end",
    "  if key_type(binding_key) == 'none' then return nil, 'VERSION_CONFLICT' end",
    "  local stored_version = tonumber(redis.call('HGET', binding_key, 'version'))",
    "  local stored_open = redis.call('HGET', binding_key, 'openLinkId')",
    "  if stored_version ~= expected_version then return nil, 'VERSION_CONFLICT' end",
    '  if (stored_open or false) ~= (native.expectedOpenLinkId or false) then',
    "    return nil, 'VERSION_CONFLICT'",
    '  end',
    "  if key_type(link_key) ~= 'hash' then return nil, 'VERSION_CONFLICT' end",
    "  if redis.call('HGET', link_key, 'id') ~= native.linkId then return nil, 'VERSION_CONFLICT' end",
    "  if redis.call('HGET', link_key, 'bindingId') ~= native.bindingId then return nil, 'VERSION_CONFLICT' end",
    "  if redis.call('HGET', link_key, 'unlinkedAt') then return nil, 'VERSION_CONFLICT' end",
    "  redis.call('HSET', link_key, 'unlinkedAt', clock.timestamp)",
    "  redis.call('HDEL', binding_key, 'openLinkId')",
    "  redis.call('HINCRBY', binding_key, 'version', 1)",
    '  return {',
    "    id=event_id, version=1, type='session.native.unlinked', occurredAt=clock.timestamp,",
    '    workspaceId=workspace_id,',
    '    payload={bindingId=native.bindingId, linkId=native.linkId}',
    '  }, nil',
    'end',
```

- [ ] **Step 5: Run the unit tests**

Run: `pnpm vitest run packages/redis/src`

Expected: PASS. The helpers are not yet called; behaviour is exercised in Task 7.

- [ ] **Step 6: Commit**

```bash
git add packages/redis/src/function-library.ts
git commit -m "feat: add native binding Lua helpers with multi-append capacity"
```

---

### Task 6: Extend `session_register` and the three terminal paths

**Files:**

- Modify: `packages/redis/src/function-library.ts`
- Modify: `packages/redis/src/function-registry.ts`

**Interfaces:**

- Consumes: the helpers from Task 5.
- Produces: `session_register` accepting `#keys == 9` or `#keys == 14`; `session_close`, `session_status`, `session_disconnect` accepting `#keys == 5` or `#keys == 7`; library version `11`.

- [ ] **Step 1: Change the `session_register` arity guard**

```ts
    '  if (#keys ~= 9 and #keys ~= 14) or #args < 5 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
```

- [ ] **Step 2: Decode, type-check and validate before any write**

Replace the existing `stream_appendable(keys[7], keys[8])` guard with a capacity check sized to the real number of events, and validate the native declaration in the same pre-mutation phase:

```ts
    '  local native = nil',
    '  local event_count = 1',
    '  if #keys == 14 then',
    "    if type(args[6]) ~= 'string' or type(args[7]) ~= 'string' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    local native_ok, decoded = pcall(cjson.decode, args[6])',
    "    if not native_ok or type(decoded) ~= 'table' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    native = decoded',
    '    event_count = 2',
    '    if native.staleLinkId then',
    "      if type(args[8]) ~= 'string' then",
    "        return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '      end',
    '      event_count = 3',
    '    end',
    "    if not type_is(keys[10], 'hash') or not type_is(keys[11], 'hash') or not type_is(keys[12], 'zset') or not type_is(keys[13], 'string') or not type_is(keys[14], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '  end',
    '  if not stream_has_capacity(keys[7], event_count) or not stream_has_capacity(keys[8], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  if native then',
    '    local native_error = native_validate(keys[10], keys[11], keys[14], native, session.id, native.link.id)',
    '    if native_error then',
    "      return cjson.encode({status='error', code=native_error})",
    '    end',
    '  end',
```

This block sits **before** the `XGROUP CREATE` call. That ordering is the point: `XGROUP CREATE … MKSTREAM` creates a stream, so a `VERSION_CONFLICT` discovered after it would leave an inbox stream and consumer group behind for a session that was never registered.

- [ ] **Step 3: Apply the native mutation after the clock exists**

After the existing `local clock = redis_now()` and before the session `HSET`, insert:

```ts
    '  local unlinked_event = nil',
    '  if native then',
    '    unlinked_event = native_apply(keys[10], keys[11], keys[12], keys[13], keys[14], native, clock, args[8], args[2])',
    '  end',
```

- [ ] **Step 4: Append the events and return the native shape**

Replace the return of `session_register` with:

```ts
    '  local streams = append_event(keys[7], keys[8], event_json)',
    '  if not native then',
    "    return cjson.encode({status='created', session=stored, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    '  end',
    '  local events = {{event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId}}',
    '  if unlinked_event then',
    '    local unlinked_streams = append_event(keys[7], keys[8], cjson.encode(unlinked_event))',
    '    events[#events + 1] = {event=unlinked_event, globalStreamId=unlinked_streams.globalStreamId, projectStreamId=unlinked_streams.projectStreamId}',
    '  end',
    '  local linked_event = {',
    "    id=args[7], version=1, type='session.native.linked', occurredAt=clock.timestamp,",
    '    workspaceId=args[2], projectId=session.projectId, agentId=session.agentId,',
    '    sessionId=session.id,',
    '    payload={bindingId=native.bindingId, linkId=native.link.id}',
    '  }',
    '  local linked_streams = append_event(keys[7], keys[8], cjson.encode(linked_event))',
    '  events[#events + 1] = {event=linked_event, globalStreamId=linked_streams.globalStreamId, projectStreamId=linked_streams.projectStreamId}',
    "  local transition = 'linked'",
    "  if tonumber(native.expectedVersion) == 0 then transition = 'created' end",
    "  local native_result = {transition=transition, binding=redis.call('HGETALL', keys[10]), link=redis.call('HGETALL', keys[11])}",
    "  if native.staleLinkId then native_result.staleLink = redis.call('HGETALL', keys[14]) end",
    "  return cjson.encode({status='created', session=stored, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId, native=native_result, events=events})",
```

The 9-key branch returns **exactly today's shape** — no `native` key and no `events` key — so every existing caller and its parser are untouched.

- [ ] **Step 5: Extend `session_close`**

Change its arity guard to `'  if (#keys ~= 5 and #keys ~= 7) or #args < 3 then'`. Replace its `stream_appendable` guard with a sized capacity check and a decode that mutates nothing:

```ts
    '  local native = nil',
    '  local event_count = 1',
    '  if #keys == 7 then',
    '    local native_ok, decoded = pcall(cjson.decode, args[4])',
    "    if not native_ok or type(decoded) ~= 'table' or type(args[5]) ~= 'string' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if not type_is(keys[6], 'hash') or not type_is(keys[7], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '    native = decoded',
    '    event_count = 2',
    '  end',
    '  if not stream_has_capacity(keys[4], event_count) or not stream_has_capacity(keys[5], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
```

Then, **after** the existing `local clock = redis_now()` and before the first mutation, apply the unlink:

```ts
    '  local native_event = nil',
    '  if native then',
    '    local produced, native_error = native_unlink(keys[6], keys[7], native, clock, args[5], args[2])',
    "    if native_error then return cjson.encode({status='error', code=native_error}) end",
    '    native_event = produced',
    '  end',
```

and replace its return with:

```ts
    '  local streams = append_event(keys[4], keys[5], event_json)',
    '  if not native_event then',
    "    return cjson.encode({status='completed', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    '  end',
    '  local native_streams = append_event(keys[4], keys[5], cjson.encode(native_event))',
    '  local events = {',
    '    {event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId},',
    '    {event=native_event, globalStreamId=native_streams.globalStreamId, projectStreamId=native_streams.projectStreamId}',
    '  }',
    "  return cjson.encode({status='completed', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId, events=events})",
```

- [ ] **Step 6: Extend `session_disconnect`**

Change its arity guard to `'  if (#keys ~= 5 and #keys ~= 7) or #args < 4 then'`. Insert the same pre-mutation block as Step 5, reading `args[5]` as the native payload and `args[6]` as the event id:

```ts
    '  local native = nil',
    '  local event_count = 1',
    '  if #keys == 7 then',
    '    local native_ok, decoded = pcall(cjson.decode, args[5])',
    "    if not native_ok or type(decoded) ~= 'table' or type(args[6]) ~= 'string' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if not type_is(keys[6], 'hash') or not type_is(keys[7], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '    native = decoded',
    '    event_count = 2',
    '  end',
    '  if not stream_has_capacity(keys[4], event_count) or not stream_has_capacity(keys[5], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
```

After its `local clock = redis_now()` and before its first mutation:

```ts
    '  local native_event = nil',
    '  if native then',
    '    local produced, native_error = native_unlink(keys[6], keys[7], native, clock, args[6], args[2])',
    "    if native_error then return cjson.encode({status='error', code=native_error}) end",
    '    native_event = produced',
    '  end',
```

and replace its return with the same two-event shape, keeping its own status string:

```ts
    '  local streams = append_event(keys[4], keys[5], event_json)',
    '  if not native_event then',
    "    return cjson.encode({status='disconnected', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    '  end',
    '  local native_streams = append_event(keys[4], keys[5], cjson.encode(native_event))',
    '  local events = {',
    '    {event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId},',
    '    {event=native_event, globalStreamId=native_streams.globalStreamId, projectStreamId=native_streams.projectStreamId}',
    '  }',
    "  return cjson.encode({status='disconnected', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId, events=events})",
```

- [ ] **Step 7: Extend `session_status`, terminal target only**

`session_status` may set any target. Only `completed` is terminal, and a session completed through the status endpoint must not leave `openLinkId` behind. Change its arity guard to `'  if (#keys ~= 5 and #keys ~= 7) or #args < 4 then'`, then insert before its first mutation:

```ts
    '  local native = nil',
    '  local event_count = 1',
    "  if #keys == 7 and target == 'completed' then",
    '    local native_ok, decoded = pcall(cjson.decode, args[5])',
    "    if not native_ok or type(decoded) ~= 'table' or type(args[6]) ~= 'string' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if not type_is(keys[6], 'hash') or not type_is(keys[7], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '    native = decoded',
    '    event_count = 2',
    '  end',
    '  if not stream_has_capacity(keys[4], event_count) or not stream_has_capacity(keys[5], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
```

After its `local clock = redis_now()` and before its first mutation, apply the same unlink block as Step 6, and replace its return with the same two-event shape keeping its own status string (`updated`). When `#keys == 7` and the target is not `completed`, the native keys are declared but never touched.

- [ ] **Step 8: Raise the library version**

In `packages/redis/src/function-registry.ts`, change `version: 10` to `version: 11` in the type and in **both** returned objects.

- [ ] **Step 9: Run the unit tests**

Run: `pnpm vitest run packages/redis/src`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/redis/src/function-library.ts packages/redis/src/function-registry.ts
git commit -m "feat: carry native bindings through registration and every terminal path"
```

---

### Task 7: Repository layer

**Files:**

- Modify: `packages/redis/src/runtime-repository.ts`
- Create: `packages/redis/src/native-session.integration.test.ts`

**Interfaces:**

- Consumes: Tasks 1–6.
- Produces:

```ts
export type NativeRegistrationInput = {
  bindingId: string;
  linkId: string;
  staleLinkId?: string;
  linkedEventId: string;
  unlinkedEventId?: string;
  /** Serialised verbatim into the Function's native argument. */
  payload: {
    bindingId: string;
    expectedVersion: number;
    expectedOpenLinkId?: string;
    staleLinkId?: string;
    link: { id: string; sessionId: string };
    binding?: {
      id: string;
      adapterId: string;
      nativeSessionId: string;
      nativeSubagentId?: string;
      kind: 'main' | 'subagent';
      parentRefJson?: string;
    };
  };
};

export type NativeUnlinkInput = {
  bindingId: string;
  linkId: string;
  expectedVersion: number;
  expectedOpenLinkId: string;
  unlinkedEventId: string;
};

export type NativeTransitionResult = {
  transition: 'created' | 'linked';
  binding: NativeSessionBinding;
  link: NativeSessionLink;
  staleLink?: NativeSessionLink;
};
```

`RegisterSessionResult`'s `created` branch gains optional `native: NativeTransitionResult` and `events: Array<{ event: RuntimeEvent; globalStreamId: string; projectStreamId: string }>`. Repository additions: `getNativeBinding(bindingId): Promise<NativeSessionBinding | null>`, `getNativeLink(linkId): Promise<NativeSessionLink | null>`, `getSessionNativeBindingId(sessionId): Promise<string | null>`.

- [ ] **Step 1: Add the hash parsers**

In `packages/redis/src/runtime-repository.ts`, beside `parseSessionHash`:

```ts
function parseNativeBindingHash(reply: unknown): NativeSessionBinding | null {
  const record = hashToRecord(reply);
  if (record === null || record.id === undefined) return null;
  const parsed = nativeSessionBindingSchema.safeParse({
    id: record.id,
    adapterId: record.adapterId,
    nativeSessionId: record.nativeSessionId,
    ...(record.nativeSubagentId === undefined ? {} : { nativeSubagentId: record.nativeSubagentId }),
    kind: record.kind,
    ...(record.parentRef === undefined
      ? {}
      : { parentRef: JSON.parse(record.parentRef) as unknown }),
    ...(record.openLinkId === undefined ? {} : { openLinkId: record.openLinkId }),
    version: Number(record.version),
    linkCount: Number(record.linkCount),
    trimmedLinkCount: Number(record.trimmedLinkCount),
    ...(record.oldestRetainedLinkedAt === undefined
      ? {}
      : { oldestRetainedLinkedAt: record.oldestRetainedLinkedAt }),
    firstLinkedAt: record.firstLinkedAt,
    lastLinkedAt: record.lastLinkedAt,
  });
  if (!parsed.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains an invalid native session binding projection.',
    );
  }
  return parsed.data;
}

function parseNativeLinkHash(reply: unknown): NativeSessionLink | null {
  const record = hashToRecord(reply);
  if (record === null || record.id === undefined) return null;
  const parsed = nativeSessionLinkSchema.safeParse({
    id: record.id,
    bindingId: record.bindingId,
    sessionId: record.sessionId,
    linkedAt: record.linkedAt,
    ...(record.unlinkedAt === undefined ? {} : { unlinkedAt: record.unlinkedAt }),
  });
  if (!parsed.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis contains an invalid native session link projection.',
    );
  }
  return parsed.data;
}
```

`hashToRecord` is the existing helper this file already uses to turn a flat `HGETALL` reply into a record; reuse it rather than adding a second one.

- [ ] **Step 2: Add the read methods**

```ts
    async getNativeBinding(bindingId) {
      return parseNativeBindingHash(
        await client.sendCommand(['HGETALL', keys.nativeSessionBinding(bindingId)]),
      );
    },

    async getNativeLink(linkId) {
      return parseNativeLinkHash(
        await client.sendCommand(['HGETALL', keys.nativeSessionLink(linkId)]),
      );
    },

    async getSessionNativeBindingId(sessionId) {
      const reply = await client.sendCommand(['GET', keys.sessionNativeBinding(sessionId)]);
      return typeof reply === 'string' && reply !== '' ? reply : null;
    },
```

- [ ] **Step 3: Extend the register call site**

```ts
    async registerSession(input) {
      const commandKeys = [
        keys.session(input.session.id),
        keys.project(input.session.projectId),
        keys.projectSessions(input.session.projectId),
        keys.agentSessions(input.session.agentId),
        keys.sessionPresence(input.session.id),
        keys.heartbeatDeadlines,
        keys.globalEvents,
        keys.projectEvents(input.session.projectId),
        keys.sessionInbox(input.session.id),
      ];
      const commandArgs = [
        JSON.stringify(input.session),
        input.workspaceId,
        input.eventId,
        String(input.presenceTtlMs),
        SESSION_INBOX_CONSUMER_GROUP,
      ];
      if (input.native !== undefined) {
        const native = input.native;
        commandKeys.push(
          keys.nativeSessionBinding(native.bindingId),
          keys.nativeSessionLink(native.linkId),
          keys.nativeSessionLinks(native.bindingId),
          keys.sessionNativeBinding(input.session.id),
          // Declared but never written when there is no stale link.
          native.staleLinkId === undefined
            ? keys.nativeSessionBinding(native.bindingId)
            : keys.nativeSessionLink(native.staleLinkId),
        );
        commandArgs.push(JSON.stringify(native.payload), native.linkedEventId);
        if (native.unlinkedEventId !== undefined) commandArgs.push(native.unlinkedEventId);
      }
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions.sessionRegister,
        String(commandKeys.length),
        ...commandKeys,
        ...commandArgs,
      ]);
      return parseRegisterSessionResult(decodeJsonReply(reply));
    },
```

- [ ] **Step 4: Extend the result parser**

In `parseRegisterSessionResult`, keep every existing branch as it is and add, inside the `created` branch after the current fields validate:

```ts
const native = value.native === undefined ? undefined : parseNativeTransition(value.native);
const events = value.events === undefined ? undefined : parseEventList(value.events);
return {
  status: 'created',
  session: session.data,
  event: event.data,
  globalStreamId: globalStreamId.data,
  projectStreamId: projectStreamId.data,
  ...(native === undefined ? {} : { native }),
  ...(events === undefined ? {} : { events }),
};
```

with `parseNativeTransition` validating `transition`, running the two hash parsers over the `HGETALL` arrays, and `parseEventList` validating each entry with `runtimeEventSchema` and `redisStreamIdSchema`. Both raise `REDIS_DATA_INVALID` on failure. Add `VERSION_CONFLICT` to the error branch so the daemon can retry on it.

- [ ] **Step 5: Add the unlink call**

```ts
    async unlinkNativeSession(input) {
      const reply = await client.sendCommand([
        'FCALL',
        functions.functions[input.via],
        '7',
        ...input.baseKeys,
        keys.nativeSessionBinding(input.native.bindingId),
        keys.nativeSessionLink(input.native.linkId),
        ...input.baseArgs,
        JSON.stringify({
          bindingId: input.native.bindingId,
          linkId: input.native.linkId,
          expectedVersion: input.native.expectedVersion,
          expectedOpenLinkId: input.native.expectedOpenLinkId,
        }),
        input.native.unlinkedEventId,
      ]);
      return decodeJsonReply(reply);
    },
```

`via` is `'sessionClose' | 'sessionStatus' | 'sessionDisconnect'`, and `baseKeys`/`baseArgs` are the five keys and existing arguments each of those calls already builds today, so the existing call sites simply pass their own values through.

- [ ] **Step 6: Write the integration test**

Create `packages/redis/src/native-session.integration.test.ts`. Set up the harness **explicitly in this file** rather than importing a file-local one from another suite:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveNativeBindingId, deriveNativeLinkId } from '@luwi/runtime';

import { createFunctionRegistry } from './function-registry.js';
import { createRedisKeys } from './redis-keys.js';
// Use the same connection and loader helpers session-transitions.integration.test.ts
// uses; this file constructs its own instances rather than sharing hidden state.

const ref = {
  adapterId: 'claude-code-native-v1',
  nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
};
const bindingId = deriveNativeBindingId(ref);

describe('native session binding', () => {
  let harness: Harness;

  beforeEach(async () => {
    // Unique per-run key prefix and a suffixed Function library, per AGENTS.md
    // section 15. Register one project for the sessions to attach to.
    harness = await createHarness();
  });

  afterEach(async () => {
    // Delete only the keys this run created, by its own prefix.
    await harness.cleanup();
  });

  it('creates a binding and an open link with the registration', async () => {});
  // No "same reference + same session" case: registration always mints a new
  // session id, so `unchanged` is unreachable through the only entry point A
  // exposes. The rule is proved by the pure policy unit test instead.
  it('refuses a second live declaration, writes nothing, and creates no session', async () => {});
  it('links after the previous session was closed, leaving the old link closed', async () => {});
  it('links over a stale open link, emits three events, and does not mutate the old session', async () => {});
  it('reports an unreadable open link as inconsistent and writes nothing', async () => {});
  it('resolves exactly one winner for two concurrent first declarations', async () => {});
  it('closes the link through session_close and clears openLinkId', async () => {});
  it('closes the link through status → completed and clears openLinkId', async () => {});
  it('closes the link through the sweeper disconnect and clears openLinkId', async () => {});
  it('refuses a second close, so unlinkedAt is written exactly once', async () => {});
  it('refuses an unlink whose link hash is missing, and creates no hash', async () => {});
  it('refuses an unlink whose link belongs to another binding', async () => {});
  it('returns version_conflict and writes nothing when the expected version is stale', async () => {});
  it('leaves no inbox stream or consumer group behind on a version conflict', async () => {});
  it('aborts before any write when a stream cannot accept every event', async () => {});
});
```

Fill each body before running. The last two carry specific setups:

**Version conflict leaves no inbox stream.** Register once, then attempt a second registration for a _new_ session id whose native payload carries a stale `expectedVersion`. Assert the Function returned `VERSION_CONFLICT`, then assert `EXISTS` on `keys.sessionInbox(newSessionId)` is `0` and `EXISTS` on `keys.session(newSessionId)` is `0`.

**Multi-event preflight.** Craft the boundary directly: `XADD <globalEvents> 18446744073709551615-18446744073709551613 f v`. That leaves room for exactly two further appends, so a two-event registration succeeds and a three-event one must fail. Assert the three-event case returns `REDIS_STATE_INVALID`, that no binding, link or session key was created, and that the stream's last id is unchanged. Then repeat with `…-18446744073709551614`, which leaves room for one, and assert even the two-event case is refused. This is the case a single `stream_appendable` check passes and a real second append fails.

- [ ] **Step 7: Run the integration tests**

Use the database verified in Task 0:

```bash
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/14 LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true pnpm test:integration
```

Expected: PASS, all sixteen cases.

- [ ] **Step 8: Commit**

```bash
git add packages/redis/src/runtime-repository.ts packages/redis/src/native-session.integration.test.ts
git commit -m "feat: carry native bindings through the Redis repository"
```

---

### Task 8: Daemon wiring

**Files:**

- Modify: `packages/protocol/src/session.ts`
- Modify: `apps/daemon/src/session-service.ts`
- Modify: `apps/daemon/src/session-service.test.ts`
- Modify: `apps/daemon/src/runtime.ts`
- Modify: `apps/daemon/src/app-phase1.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3 and 7.
- Produces: `sessionRegistrationRequestSchema` gains `native: nativeSessionRefSchema.optional()`; registration returns `409 NATIVE_SESSION_CONFLICT`, `409 NATIVE_BINDING_INCONSISTENT` or `409 NATIVE_BINDING_CONTENDED`.

- [ ] **Step 1: Add the request field**

In `packages/protocol/src/session.ts`, import `nativeSessionRefSchema` from `./native-session.js` and add to `sessionRegistrationRequestSchema`:

```ts
  native: nativeSessionRefSchema.optional(),
```

`apps/daemon/src/app.ts` needs no change: the route already parses the whole request with this schema and passes it to the service.

- [ ] **Step 2: Write the failing service tests**

Append to `apps/daemon/src/session-service.test.ts`, using the stub-repository style already in that file:

```ts
describe('native session declaration', () => {
  it('declares a binding when the reference is free', async () => {
    // Repository stub: getNativeBinding → null. Assert registerSession received
    // native.payload.expectedVersion === 0 and a binding block.
  });

  it('refuses with NATIVE_SESSION_CONFLICT and never calls registerSession', async () => {
    // Stub a binding with an open link over an online session.
  });

  it('refuses with NATIVE_BINDING_INCONSISTENT when the open link cannot be read', async () => {
    // Stub a binding with openLinkId set and getNativeLink → null.
  });

  it('retries a version conflict and gives up as NATIVE_BINDING_CONTENDED', async () => {
    // registerSession rejects with VERSION_CONFLICT every time; assert exactly
    // NATIVE_DECLARATION_MAX_ATTEMPTS calls.
  });

  it('keeps the session id and the event ids stable across retries', async () => {
    // Assert every attempt carried the same session id, the same registration
    // event id and the same linked event id.
  });

  it('registers with no native payload when no reference is supplied', async () => {
    // Assert registerSession received `native: undefined` and one event.
  });
});
```

Fill each body before running.

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run apps/daemon/src/session-service.test.ts`

Expected: FAIL — the service does not accept a native reference.

- [ ] **Step 4: Implement the registration CAS loop**

In `apps/daemon/src/session-service.ts`, add the helpers and replace the registration body:

```ts
/**
 * The open link and its session are read here rather than inside Lua, because a
 * Redis Function may not derive another session's key name.
 */
async function readOpenLink(
  repository: SessionRepository,
  openLinkId: string,
): Promise<NativeOpenLinkObservation | undefined> {
  const link = await repository.getNativeLink(openLinkId);
  if (link === null || link.unlinkedAt !== undefined) return undefined;
  const session = await repository.getSession(link.sessionId);
  if (session === null) return undefined;
  return { id: link.id, sessionId: link.sessionId, sessionStatus: session.status };
}

function buildNativeRegistrationInput(
  ref: NativeSessionRef,
  bindingId: string,
  sessionId: string,
  decision: Extract<NativeDeclarationDecision, { outcome: 'created' | 'linked' }>,
  eventIds: { linked: string; unlinked: string },
): NativeRegistrationInput {
  const linkId = deriveNativeLinkId(bindingId, sessionId);
  const parentRef = deriveParentRef(ref);
  return {
    bindingId,
    linkId,
    ...(decision.staleLinkId === undefined ? {} : { staleLinkId: decision.staleLinkId }),
    linkedEventId: eventIds.linked,
    ...(decision.staleLinkId === undefined ? {} : { unlinkedEventId: eventIds.unlinked }),
    payload: {
      bindingId,
      expectedVersion: decision.expectedVersion,
      ...(decision.expectedOpenLinkId === undefined
        ? {}
        : { expectedOpenLinkId: decision.expectedOpenLinkId }),
      ...(decision.staleLinkId === undefined ? {} : { staleLinkId: decision.staleLinkId }),
      link: { id: linkId, sessionId },
      ...(decision.outcome === 'created'
        ? {
            binding: {
              id: bindingId,
              adapterId: ref.adapterId,
              nativeSessionId: ref.nativeSessionId,
              ...(ref.nativeSubagentId === undefined
                ? {}
                : { nativeSubagentId: ref.nativeSubagentId }),
              kind: deriveNativeKind(ref),
              ...(parentRef === undefined ? {} : { parentRefJson: JSON.stringify(parentRef) }),
            },
          }
        : {}),
    },
  };
}
```

and in `register`:

```ts
/**
 * The session id and both event ids are minted once, before the loop, and
 * reused on every attempt. A retry that minted new ids would append a
 * second registration event for the same registration if an earlier
 * attempt had in fact succeeded unobserved.
 */
const sessionId = createId();
const registrationEventId = createId();
const linkedEventId = createId();
const unlinkedEventId = createId();
const bindingId = request.native === undefined ? undefined : deriveNativeBindingId(request.native);

for (let attempt = 1; attempt <= NATIVE_DECLARATION_MAX_ATTEMPTS; attempt += 1) {
  let native: NativeRegistrationInput | undefined;

  if (request.native !== undefined && bindingId !== undefined) {
    const binding = await options.repository.getNativeBinding(bindingId);
    const openLink =
      binding?.openLinkId === undefined
        ? undefined
        : await readOpenLink(options.repository, binding.openLinkId);
    const decision = evaluateNativeDeclaration({ binding, openLink, sessionId });

    if (decision.outcome === 'conflict') {
      throw new ApplicationError(
        'NATIVE_SESSION_CONFLICT',
        'Another live session already holds this native session reference.',
        409,
      );
    }
    if (decision.outcome === 'inconsistent') {
      throw new ApplicationError(
        'NATIVE_BINDING_INCONSISTENT',
        'The native session binding names an open link that cannot be read.',
        409,
      );
    }
    /**
     * `unchanged` cannot arise during registration, because the session id
     * is new and no open link can already name it. It is handled rather
     * than ignored so that a future declaration surface cannot silently
     * fall through to an unbound registration.
     */
    if (decision.outcome === 'unchanged') {
      throw new ApplicationError(
        'NATIVE_BINDING_INCONSISTENT',
        'The native session binding already names this session.',
        409,
      );
    }
    native = buildNativeRegistrationInput(request.native, bindingId, sessionId, decision, {
      linked: linkedEventId,
      unlinked: unlinkedEventId,
    });
  }

  try {
    const result = await options.repository.registerSession({
      session: { id: sessionId /* … unchanged fields … */ },
      workspaceId: options.workspaceId,
      eventId: registrationEventId,
      presenceTtlMs: options.presenceTtlMs,
      ...(native === undefined ? {} : { native }),
    });
    if (result.status === 'not_found') {
      throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
    }
    const session = await requireSession(options.repository, sessionId);
    options.onRegistered?.(session);
    return session;
  } catch (error) {
    const contended = error instanceof RedisRepositoryError && error.code === 'VERSION_CONFLICT';
    // A third VERSION_CONFLICT must not escape as a raw repository error, which
    // a caller would see as a 500 for what is a refusal. Fall through to the
    // mapped 409 NATIVE_BINDING_CONTENDED below.
    if (!contended) throw error;
  }
}

throw new ApplicationError(
  'NATIVE_BINDING_CONTENDED',
  'The native session binding changed while it was being declared.',
  409,
);
```

A `VERSION_CONFLICT` writes nothing, so re-entering the loop re-reads and re-decides against the state that actually won.

- [ ] **Step 5: Add the terminal CAS loops**

Add one helper and use it from all three paths:

```ts
/**
 * Resolve the binding for a session, then apply a terminal transition with the
 * CAS guard, re-reading on contention. Bounded at the same three attempts as a
 * declaration, because the same binding can be moved by a concurrent close.
 */
async function withNativeUnlink<T>(
  repository: SessionRepository,
  sessionId: string,
  unlinkedEventId: string,
  apply: (native: NativeUnlinkInput | undefined) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= NATIVE_DECLARATION_MAX_ATTEMPTS; attempt += 1) {
    const bindingId = await repository.getSessionNativeBindingId(sessionId);
    let native: NativeUnlinkInput | undefined;

    /**
     * Fail-closed. No reverse index means no binding, and the unchanged 5-key
     * path is correct. But once the reverse index exists the evidence must be
     * complete: falling back to the 5-key path on partial evidence would
     * complete the session while abandoning an open link, which is the loss the
     * `inconsistent` outcome exists to prevent.
     */
    if (bindingId !== null) {
      const binding = await repository.getNativeBinding(bindingId);
      const link =
        binding?.openLinkId === undefined
          ? null
          : await repository.getNativeLink(binding.openLinkId);
      const matches =
        binding !== null &&
        binding.openLinkId !== undefined &&
        link !== null &&
        link.id === binding.openLinkId &&
        link.bindingId === bindingId &&
        link.sessionId === sessionId &&
        link.unlinkedAt === undefined;

      if (!matches) {
        throw new ApplicationError(
          'NATIVE_BINDING_INCONSISTENT',
          'The native session binding for this session cannot be resolved.',
          409,
        );
      }

      native = {
        bindingId,
        linkId: link.id,
        expectedVersion: binding.version,
        expectedOpenLinkId: binding.openLinkId,
        unlinkedEventId,
      };
    }

    try {
      return await apply(native);
    } catch (error) {
      const contended = error instanceof RedisRepositoryError && error.code === 'VERSION_CONFLICT';
      // A third VERSION_CONFLICT must not escape as a raw repository error, which
      // a caller would see as a 500 for what is a refusal. Fall through to the
      // mapped 409 NATIVE_BINDING_CONTENDED below.
      if (!contended) throw error;
    }
  }
  throw new ApplicationError(
    'NATIVE_BINDING_CONTENDED',
    'The native session binding changed while the session was closing.',
    409,
  );
}
```

Wrap `close`, and `updateStatus` when the target is `completed`, in `withNativeUnlink`. When `native` is `undefined` the call uses today's 5-key form unchanged.

- [ ] **Step 6: Wire the presence sweeper**

The sweeper lives in `apps/daemon/src/runtime.ts`, where `createPresenceSweeper` is constructed with a repository adapter. Its `disconnectExpiredSession` must resolve and close the link the same way. Extend that adapter to call `withNativeUnlink` before delegating to the repository's disconnect, so a session that lapses leaves no `openLinkId` behind.

Add to `apps/daemon/src/runtime.test.ts` a case asserting that a swept session with a binding has its link closed and its `openLinkId` cleared, and that a swept session without a binding takes the unchanged path.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run apps/daemon/src`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/session.ts apps/daemon/src/session-service.ts apps/daemon/src/session-service.test.ts apps/daemon/src/runtime.ts apps/daemon/src/runtime.test.ts apps/daemon/src/app-phase1.test.ts
git commit -m "feat: declare and release a native session reference from the daemon"
```

---

### Task 9: Verification and documentation

**Files:**

- Create: `docs/decisions/0022-native-session-binding.md`
- Modify: `AGENTS.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Run the definition-of-done sequence**

In Bash:

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

In PowerShell, as separate commands rather than a chain:

```powershell
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: every leg passes. Report the actual output; fix any failure before continuing.

- [ ] **Step 2: Run the Redis integration tests**

Use the database verified in Task 0. Afterwards confirm the run left nothing behind:

```bash
"/c/Program Files/Memurai/memurai-cli.exe" -n 14 DBSIZE
"/c/Program Files/Memurai/memurai-cli.exe" FUNCTION LIST LIBRARYNAME luwi_v1
```

Expected: `(integer) 0`, and `luwi_v1` still present with no `luwi_test_*` library left over.

- [ ] **Step 3: Write ADR 0022**

Use the `/adr` skill. It must record: identity separated from liveness; the binding/link split and why a link is immutable; that a live session is never evicted and a conflict writes nothing; the `inconsistent` outcome and why missing evidence is not a free reference; CAS with a monotonic `version` and why Lua does not own policy; validate-before-`XGROUP` so a conflict leaves no inbox stream; per-append capacity preflight; that all timestamps come from the Redis transition clock; that A cannot detect one subagent id under two transcript paths; that `usage.sessionId` is not solved; and that **A1 is not acceptance of A** because retention (A2) is outstanding.

- [ ] **Step 4: Update the binding documents**

Record in `AGENTS.md` section 21 what was built and that retention remains open as A2. Update `CLAUDE.md`'s repository-state table and status, and `README.md`'s current status. `AGENTS.md` is in `.prettierignore`, so edit it with the editing tools rather than a script, which would leave CRLF on this machine.

- [ ] **Step 5: Verify the documentation against the code**

Run: `pnpm format`

Then re-read what was written and confirm every claim is true of the code as committed. Do not describe planned behaviour as implemented, and do not describe A as complete.

- [ ] **Step 6: Commit**

```bash
git add docs/decisions/0022-native-session-binding.md AGENTS.md CLAUDE.md README.md
git commit -m "docs: record ADR 0022 and the native session binding status"
```

---

## Test matrix

| Case                                                                                                     | Where               |
| -------------------------------------------------------------------------------------------------------- | ------------------- |
| Five policy outcomes plus `inconsistent`                                                                 | Task 3, unit        |
| `bindingId`/`linkId` determinism, NUL separation, cross-vendor non-collision                             | Task 2, unit        |
| Charset rejection, binding carries no presence/project/agent/confidence                                  | Tasks 1–2, unit     |
| Event types accepted by the closed enum                                                                  | Task 1, unit        |
| Realtime relay accepts both new events                                                                   | Task 1, daemon unit |
| Key namespacing and unsafe-identifier rejection                                                          | Task 4, unit        |
| `created`, idempotent `unchanged`, `linked` after close, `linked` over stale, `conflict`, `inconsistent` | Task 7, integration |
| Two concurrent first declarations → one winner                                                           | Task 7, integration |
| Three terminal paths each close the link and clear `openLinkId`                                          | Task 7, integration |
| Second close refused, `unlinkedAt` written exactly once                                                  | Task 7, integration |
| Unlink with missing link hash creates no hash                                                            | Task 7, integration |
| Unlink with a link belonging to another binding refused                                                  | Task 7, integration |
| CAS exhaustion → `NATIVE_BINDING_CONTENDED`                                                              | Task 8, unit        |
| Conflict writes nothing, creates no session                                                              | Task 7, integration |
| `VERSION_CONFLICT` leaves no inbox stream or consumer group                                              | Task 7, integration |
| Multi-event stream capacity failure aborts before any write                                              | Task 7, integration |
| Session id and event ids stable across retries                                                           | Task 8, unit        |
| Swept session with and without a binding                                                                 | Task 8, daemon unit |

## Self-review

**Correction coverage**

| #   | Correction                                                                              | Where in this plan                                                       |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | A1/A2 scope consistency, unbounded history, not full A acceptance, §6/§12 contradiction | Spec §0 and §12 (revised); plan Global Constraints line 2; Task 9 Step 3 |
| 2   | Event types plus protocol, parser and relay tests                                       | Task 1 Steps 2, 5, 7                                                     |
| 3   | Two-phase `native_validate` → `XGROUP` → `native_apply`, no durable trace on conflict   | Task 5 Step 2; Task 6 Step 2; Task 7 Step 6 (inbox-stream case)          |
| 4   | Real per-append capacity preflight and its integration proof                            | Task 5 Step 1; Task 6 Steps 2, 5–7; Task 7 Step 6 (last case)            |
| 5   | `native`/`events` present only for the 14-key form                                      | Task 6 Step 4; spec §7 (revised)                                         |
| 6   | Clock before unlink; unlink validates and never creates                                 | Task 5 Step 4; Task 6 Steps 5–7                                          |
| 7   | Unreadable open link is `inconsistent`, not free                                        | Task 3 Steps 1, 3; Task 8 Step 4                                         |
| 8   | One Redis transition clock for every timestamp                                          | Global Constraints; Task 5 Steps 3–4; spec §10 (revised)                 |
| 9   | Full registration CAS loop, stable ids, `unchanged` never falls through                 | Task 8 Step 4                                                            |
| 10  | Three-attempt CAS on all three terminal paths; `runtime.ts` listed and tested           | Task 8 Steps 5–6; file structure table                                   |
| 11  | Full types, parsers and helpers; harness set up in the new test file                    | Task 7 Steps 1–5; Task 8 Step 4                                          |
| 12  | Full test matrix                                                                        | Test matrix section                                                      |
| 13  | Verified test database, PowerShell without `&&`                                         | Task 0; Task 9 Steps 1–2                                                 |

**Remaining judgement left to the implementer, named rather than hidden**

- Task 1 Step 7, Task 7 Step 6 and Task 8 Step 2 give each test's name, setup and assertions but not its harness plumbing, because the surrounding suites build those file-locally and copying them here would create a second copy that drifts. Every production code change in this plan is given in full.
- `hashToRecord` in Task 7 Step 1 is named as an existing helper in `runtime-repository.ts`; if that file spells it differently, use the existing one rather than adding a second.

**Type consistency:** `NativeSessionRef`, `NativeSessionBinding`, `NativeSessionLink`, `NativeDeclarationDecision`, `NativeOpenLinkObservation`, `NativeRegistrationInput`, `NativeUnlinkInput`, `NativeTransitionResult`, `deriveNativeBindingId`, `deriveNativeLinkId`, `deriveNativeKind`, `deriveParentRef` and `NATIVE_DECLARATION_MAX_ATTEMPTS` are used in Tasks 4–8 under the names Tasks 1–3 define.
