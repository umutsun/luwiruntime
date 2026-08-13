# Native session link retention (A2) — implementation plan

> **For agentic workers:** this plan is executed inline in the session that wrote it. Steps use
> checkbox (`- [ ]`) syntax for tracking. **There are no commit steps.** The owner has withheld
> commit, stage, push, rebase, merge and amend for this work; A1's uncommitted changes share the
> working tree and must survive untouched.

**Goal:** Bound the closed `NativeSessionLink` records a `NativeSessionBinding` retains, so that A1's
unbounded link growth stops and §11 of the design holds, completing Native Session Binding A.

**Architecture:** A new non-transition Redis Function `native_link_trim` removes an explicitly
declared batch of closed links — zset member, link hash and session reverse index together — under
the same compare-and-set contract A1 uses. A pure selection function in `@luwi/runtime` decides
which links go; a sweeper service drives it from the daemon's existing periodic retention pass. No
transition Function ever trims.

**Tech Stack:** TypeScript strict ESM, Zod, Redis Functions (Lua 5.1 under Redis 7), Vitest.

## Global constraints

Copied from the design spec (`docs/superpowers/specs/2026-08-11-native-session-binding-design.md`
§11, §12, §14) and `AGENTS.md`. Every task inherits these.

- Transition Functions **never trim**. `session_register`, `session_close`, `session_status` and
  `session_disconnect` are not touched by this work.
- Retention is a **separate periodic service**.
- Bound: **at most 1000 closed links retained per binding**, configurable through
  `LUWI_NATIVE_LINK_RETENTION_MAX`.
- An **open link is never trimmed**, at any count.
- At most **32 links per Function call**.
- `native_link_trim` takes exactly **`2 + 2N` keys**: binding hash, links zset, then the link hash
  and reverse-index key of each of the N links.
- The caller reads which links to remove and declares every key **and** the identity of what each
  key must hold. The Function treats that declaration as the trust boundary.
- CAS on `expectedVersion` guards the binding.
- A trim racing a link or unlink returns `version_conflict` and is **left to the next sweep** — no
  tight retry inside one sweep.
- A successful trim atomically: removes the links from the zset, deletes the link hashes, deletes
  the session reverse indexes, increases `trimmedLinkCount` by the real removed count, updates
  `oldestRetainedLinkedAt` from the oldest remaining link, and increments `version` exactly once.
- No open link, no dangling `openLinkId`, no dangling reverse index may survive.
- A link that is unclosed, belongs to another binding, names another session, is declared twice, or
  disagrees with the caller's declaration is **not trimmed**, and the whole call mutates nothing.
- No new datastore, package boundary, production dependency, MCP tool or control-plane write.
- A1 must not regress: `native_validate`, `native_unlink`, the 9-key registration branch, the
  caller-facing `409 NATIVE_BINDING_CONTENDED` mapping, and the sweeper's `unchanged` behaviour.
- Redis data is untrusted input and is validated on read (`AGENTS.md` §7, §14).
- Every state transition requires tests (`AGENTS.md` §15). Redis atomicity and zero-mutation claims
  are proven by integration tests, not unit stubs.

---

## Determinations the spec leaves open

These three are recorded here because implementing A2 requires them and none is a contradiction
with the spec. Each is testable and tested.

### D1 — How the sweep enumerates bindings

**The spec never says how the retention caller finds bindings.** §4 defines four keys and no binding
index, and §11 says only that the caller "has read which links to remove". Verified facts:

- `packages/redis/src/redis-keys.ts:172-175` defines exactly four native keys. There is **no**
  `index:native-sessions` set.
- There is **no production `SCAN`** anywhere in `packages/redis/src` (searched; only test cleanup
  uses it).
- Session hashes and `index:project:{projectId}:sessions` membership are **never deleted**. The
  three `DEL keys[2]` calls in the session Functions delete the _presence_ key; the `DEL`/`SREM`
  pair at `function-library.ts:1108-1110` belongs to `control_delete`.
- `index:session:{sessionId}:native` has the same lifetime as its link (§4) and is deleted only by a
  trim.

**Decision:** enumerate through sessions. The distinct set of binding ids named by
`index:session:{sessionId}:native` over all sessions is exactly the set of bindings that still hold
at least one link, because every link's session is permanently enumerable and the reverse index
survives the link's closure. A binding with no retained link has nothing to trim, so completeness is
preserved.

**Why not the alternative:** a dedicated binding index would have to be written inside
`native_apply` to stay atomic, which makes `session_register` a 15-key Function and breaks the
9-key/14-key contract stated in the ADR, in spec §7, and in A1's tests. Enumeration through sessions
touches no A1 surface and adds no key.

**Cost, stated honestly:** the sweep is O(sessions) in reverse-index reads per pass. The daemon's
retention pass already lists every session for `runMessageRetention`
(`apps/daemon/src/runtime.ts:914`), so that list is reused rather than re-read, and the reverse
indexes are fetched with one `MGET` over caller-declared keys.

### D2 — Empty and oversized trims

**Decision:** `#keys < 4` (N = 0), `#keys` odd, and `#keys > 66` (N > 32) are all
`REDIS_ARGUMENT_INVALID` with **zero mutation and no version change**. The sweeper never issues an
N = 0 call: the selection function returns an empty list and the sweeper skips the Function.

**Why this and not a no-op success:** §5 defines `version` as "incremented by every binding mutation
— link, unlink and retention trim alike". A call that removes nothing is not a mutation, and letting
it increment `version` would invalidate every concurrent CAS observation while changing no state.
§11 describes the keys as those "of each of the `N ≤ 32` links being trimmed", which presumes
N ≥ 1. Both halves — the Function's refusal and the sweeper's non-call — are tested.

### D3 — Function library version stays at 11

**Decision:** `RedisFunctionRegistry.version` stays `11`. Verified reasoning:

- `isCompatible` (`packages/redis/src/function-loader.ts:107-115`) compares a SHA-256 of the
  installed source **and** the sorted function-name list. Adding `native_link_trim` changes both, so
  `verifyOrLoadFunctionLibrary` issues `FUNCTION LOAD REPLACE` on its own. Reload does not depend on
  the version number.
- `verifyVersionFunction` (`:117-148`) compares the number the loaded library reports against
  `registry.version`. Both come from the same registry object, so it only ever fails against a
  library that failed to replace — which `isCompatible` has already forced.
- v11 is ADR 0022's number, ADR 0022 covers A as a whole, and v11 is not yet committed. A2 completes
  the same unreleased library.

Bumping to 12 would therefore buy no compatibility behaviour and would require editing the ADR, the
spec and `CLAUDE.md` to match — changes outside this scope.

---

## File structure

| File                                                                    | Responsibility                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/protocol/src/native-session.ts` (modify)                      | `NATIVE_LINK_TRIM_MAX_PER_CALL`, the shared 32    |
| `packages/runtime/src/native-link-retention.ts` (create)                | Pure selection + the sweeper service              |
| `packages/runtime/src/native-link-retention.test.ts`                    | Unit tests for both                               |
| `packages/redis/src/function-registry.ts` (modify)                      | `nativeLinkTrim` function name                    |
| `packages/redis/src/function-library.ts` (modify)                       | `native_link_trim` Lua                            |
| `packages/redis/src/runtime-repository.ts` (modify)                     | Four retention reads/writes                       |
| `packages/redis/src/native-link-retention.integration.test.ts` (create) | Redis atomicity and zero-mutation proofs          |
| `apps/daemon/src/config.ts` (modify)                                    | `LUWI_NATIVE_LINK_RETENTION_MAX`                  |
| `apps/daemon/src/config.test.ts` (modify)                               | Default, override, invalid                        |
| `apps/daemon/src/runtime.ts` (modify)                                   | Adapter + wiring into the existing retention pass |
| `apps/daemon/src/runtime.test.ts` (modify)                              | Adapter and lifecycle tests                       |
| `docs/superpowers/specs/...-design.md` (modify)                         | Mark A2 implemented                               |
| `docs/decisions/0022-native-session-binding.md` (modify)                | Replace the "A2 unbuilt" consequence              |

---

## Task 1: The shared bound and the daemon configuration

**Files:**

- Modify: `packages/protocol/src/native-session.ts`
- Modify: `apps/daemon/src/config.ts`
- Test: `apps/daemon/src/config.test.ts`

**Interfaces:**

- Produces: `NATIVE_LINK_TRIM_MAX_PER_CALL: 32` from `@luwi/protocol`;
  `DaemonConfig.nativeLinkRetentionMax: number` on the daemon config.

- [ ] **Step 1: Write the failing config tests**

In `apps/daemon/src/config.test.ts`, following the existing bound tests in that file:

```ts
it('defaults the native link retention bound to 1000', () => {
  expect(loadConfig({}).nativeLinkRetentionMax).toBe(1000);
});

it('accepts a native link retention override', () => {
  expect(loadConfig({ LUWI_NATIVE_LINK_RETENTION_MAX: '32' }).nativeLinkRetentionMax).toBe(32);
});

it('rejects a native link retention bound below one', () => {
  expect(() => loadConfig({ LUWI_NATIVE_LINK_RETENTION_MAX: '0' })).toThrow();
});

it('rejects a non-integer native link retention bound', () => {
  expect(() => loadConfig({ LUWI_NATIVE_LINK_RETENTION_MAX: 'many' })).toThrow();
});
```

Match the file's existing `loadConfig` call convention exactly — read a neighbouring bound test
first and copy its shape.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run apps/daemon/src/config.test.ts -t 'native link retention'`
Expected: FAIL — `nativeLinkRetentionMax` is `undefined`.

- [ ] **Step 3: Implement**

`packages/protocol/src/native-session.ts`, beside the other exported bounds:

```ts
/** Links removed by one `native_link_trim` call. Design §11 fixes this at 32. */
export const NATIVE_LINK_TRIM_MAX_PER_CALL = 32;
```

Export it from `packages/protocol/src/index.ts` if that file re-exports names explicitly.

`apps/daemon/src/config.ts`, in `environmentSchema` beside the other retention bounds:

```ts
LUWI_NATIVE_LINK_RETENTION_MAX: z.coerce.number().int().min(1).max(1_000_000).default(1_000),
```

and in the returned config object:

```ts
nativeLinkRetentionMax: parsed.LUWI_NATIVE_LINK_RETENTION_MAX,
```

Add `nativeLinkRetentionMax?: number` to the `DaemonConfig` type beside `retentionIntervalMs`, and
`nativeLinkRetentionMax: 1_000` to the `defaults` object in `apps/daemon/src/runtime.ts`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run apps/daemon/src/config.test.ts`
Expected: PASS, whole file.

---

## Task 2: The pure selection policy

**Files:**

- Create: `packages/runtime/src/native-link-retention.ts`
- Test: `packages/runtime/src/native-link-retention.test.ts`

**Interfaces:**

- Consumes: `NATIVE_LINK_TRIM_MAX_PER_CALL` from Task 1.
- Produces:

```ts
export type RetainedNativeLink = {
  id: string;
  sessionId: string;
  unlinkedAt?: string;
};

export type NativeLinkTrimTarget = { id: string; sessionId: string };

export function selectTrimmableNativeLinks(input: {
  openLinkId?: string;
  closedLinkCount: number;
  oldest: readonly RetainedNativeLink[];
  retentionMax: number;
  maxPerCall?: number;
}): NativeLinkTrimTarget[];
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

import { selectTrimmableNativeLinks } from './native-link-retention.js';

const closed = (id: string): RetainedNativeLink => ({
  id,
  sessionId: `session-${id}`,
  unlinkedAt: '2026-08-12T00:00:00.000Z',
});

describe('selectTrimmableNativeLinks', () => {
  it('selects nothing when the binding is at the bound', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1000,
        oldest: [closed('a')],
        retentionMax: 1000,
      }),
    ).toEqual([]);
  });

  it('selects exactly the overshoot', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1001,
        oldest: [closed('a'), closed('b')],
        retentionMax: 1000,
      }),
    ).toEqual([{ id: 'a', sessionId: 'session-a' }]);
  });

  it('skips the open link even when it is the oldest', () => {
    expect(
      selectTrimmableNativeLinks({
        openLinkId: 'open',
        closedLinkCount: 1001,
        oldest: [{ id: 'open', sessionId: 'session-open' }, closed('a')],
        retentionMax: 1000,
      }),
    ).toEqual([{ id: 'a', sessionId: 'session-a' }]);
  });

  it('skips any link that carries no unlinkedAt', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1001,
        oldest: [{ id: 'unclosed', sessionId: 'session-unclosed' }, closed('a')],
        retentionMax: 1000,
      }),
    ).toEqual([{ id: 'a', sessionId: 'session-a' }]);
  });

  it('never selects more than the per-call cap', () => {
    const oldest = Array.from({ length: 40 }, (_, index) => closed(`link-${String(index)}`));
    expect(
      selectTrimmableNativeLinks({ closedLinkCount: 1040, oldest, retentionMax: 1000 }),
    ).toHaveLength(32);
  });

  it('never selects a duplicate id', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1002,
        oldest: [closed('a'), closed('a'), closed('b')],
        retentionMax: 1000,
      }),
    ).toEqual([
      { id: 'a', sessionId: 'session-a' },
      { id: 'b', sessionId: 'session-b' },
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/runtime/src/native-link-retention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the minimum**

```ts
import { NATIVE_LINK_TRIM_MAX_PER_CALL } from '@luwi/protocol';

export type RetainedNativeLink = { id: string; sessionId: string; unlinkedAt?: string };
export type NativeLinkTrimTarget = { id: string; sessionId: string };

/**
 * Which closed links a binding has to give up, oldest first.
 *
 * The open link is skipped by identity and again by the absence of
 * `unlinkedAt`, because `openLinkId` is a pointer that can be stale while the
 * link record itself cannot lie about being closed.
 */
export function selectTrimmableNativeLinks(input: {
  openLinkId?: string;
  closedLinkCount: number;
  oldest: readonly RetainedNativeLink[];
  retentionMax: number;
  maxPerCall?: number;
}): NativeLinkTrimTarget[] {
  const excess = input.closedLinkCount - input.retentionMax;
  if (excess <= 0) return [];
  const limit = Math.min(excess, input.maxPerCall ?? NATIVE_LINK_TRIM_MAX_PER_CALL);
  const selected: NativeLinkTrimTarget[] = [];
  const seen = new Set<string>();
  for (const link of input.oldest) {
    if (selected.length >= limit) break;
    if (link.id === input.openLinkId) continue;
    if (link.unlinkedAt === undefined) continue;
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    selected.push({ id: link.id, sessionId: link.sessionId });
  }
  return selected;
}
```

Export both the function and the types from `packages/runtime/src/index.ts`.

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run packages/runtime/src/native-link-retention.test.ts`
Expected: PASS, 6 tests.

---

## Task 3: The `native_link_trim` Redis Function

**Files:**

- Modify: `packages/redis/src/function-registry.ts`
- Modify: `packages/redis/src/function-library.ts`
- Test: `packages/redis/src/native-link-retention.integration.test.ts` (create)

**Interfaces:**

- Produces: Function `luwi_native_link_trim_v1`, registered as `nativeLinkTrim`.
- Contract:
  - keys: `[1]` binding hash, `[2]` links zset, then for i in 1..N the pair
    `[2 + 2i - 1]` link hash, `[2 + 2i]` session reverse index.
  - args: `[1]` `expectedVersion` as a decimal string; `[2]` JSON
    `{ bindingId, links: [{ id, sessionId }, …] }` with exactly N entries in key order.
  - replies: `{status='trimmed', trimmed, version, trimmedLinkCount, oldestRetainedLinkedAt?}`,
    `{status='error', code='REDIS_ARGUMENT_INVALID'}`, or
    `{status='error', code='VERSION_CONFLICT'}`.

- [ ] **Step 1: Write the failing integration tests**

Create `packages/redis/src/native-link-retention.integration.test.ts`. Copy the harness header of
`packages/redis/src/native-session.integration.test.ts` verbatim (run id, namespace, registry,
`beforeAll` load, `afterAll` SCAN-and-DEL of `${namespace}:*` plus `FUNCTION DELETE`), then add a
seeding helper and the cases below.

```ts
type SeededBinding = { bindingId: string; linkIds: string[]; openLinkId?: string };

/**
 * Writes exactly what `native_apply` writes, without paying for a full
 * registration per link. The shape-fidelity test below proves the two agree.
 */
async function seedBinding(config: {
  closed: number;
  withOpenLink?: boolean;
  version?: number;
}): Promise<SeededBinding> {
  /* HSET binding, HSET each link, ZADD links */
}

async function trim(input: {
  bindingId: string;
  expectedVersion: number;
  links: { id: string; sessionId: string }[];
  keyOverrides?: { linkKey?: (index: number) => string; reverseKey?: (index: number) => string };
}): Promise<unknown> {
  /* raw FCALL so key/arg disagreement can be injected */
}
```

Cases, each asserting zero mutation on refusal by comparing `HGETALL` of the binding, `ZCARD` of
the zset, and the presence of every link hash and reverse key before and after:

1. `trims the oldest closed link when the binding is one over the bound`
2. `never trims the open link, even when it is the oldest`
3. `trims at most 32 links in one call`
4. `removes the link hash, the zset member and the reverse index together`
5. `increments trimmedLinkCount by the removed count and version exactly once`
6. `sets oldestRetainedLinkedAt from the oldest remaining link`
7. `refuses a stale expectedVersion and writes nothing`
8. `refuses a link hash that is not closed and writes nothing`
9. `refuses a link belonging to another binding and writes nothing`
10. `refuses a link whose stored sessionId differs from the declaration`
11. `refuses when the declared link id does not match the key it was given`
12. `refuses a reverse index that names another binding`
13. `refuses a duplicate link in one declaration`
14. `refuses an empty trim and leaves version untouched`
15. `refuses more than 32 links`
16. `matches the record shape a real registration writes` (register + close through the repository,
    then trim that link and assert it disappears)

- [ ] **Step 2: Run and watch them fail**

Run:

```bash
LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/14 LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true \
  npx vitest run --config vitest.integration.config.ts \
  packages/redis/src/native-link-retention.integration.test.ts
```

Expected: FAIL — `Function not found` for every case.

- [ ] **Step 3: Register the function name**

`packages/redis/src/function-registry.ts`: add `nativeLinkTrim: string` to the `functions` type and
`nativeLinkTrim: 'luwi_native_link_trim_v1'` to `productionFunctions`. Leave `version: 11` (D3).

- [ ] **Step 4: Implement the Lua**

Insert after `native_unlink` in `packages/redis/src/function-library.ts`, and register it beside the
other `register(...)` lines.

```lua
-- Retention, not a transition: no event, no stream key, no product policy.
-- Every key is declared by the caller together with the identity it must hold,
-- because a Function may not derive a key name and a key alone proves nothing.
local function native_link_trim(keys, args)
  local count = #keys - 2
  if count < 2 or count > 64 or count % 2 ~= 0 or #args ~= 2 then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  local n = count / 2
  local expected_version = tonumber(args[1])
  if not expected_version or expected_version < 1 or expected_version ~= math.floor(expected_version) then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  local decoded_ok, declared = pcall(cjson.decode, args[2])
  if not decoded_ok or type(declared) ~= 'table' then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  if type(declared.bindingId) ~= 'string' or declared.bindingId == '' then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  if type(declared.links) ~= 'table' or #declared.links ~= n then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  local seen = {}
  for index = 1, n do
    local entry = declared.links[index]
    if type(entry) ~= 'table' or type(entry.id) ~= 'string' or entry.id == ''
      or type(entry.sessionId) ~= 'string' or entry.sessionId == '' then
      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
    end
    if seen[entry.id] then
      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
    end
    seen[entry.id] = true
  end
  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'zset') then
    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})
  end
  if key_type(keys[1]) == 'none' then
    return cjson.encode({status='error', code='VERSION_CONFLICT'})
  end
  if redis.call('HGET', keys[1], 'id') ~= declared.bindingId then
    return cjson.encode({status='error', code='VERSION_CONFLICT'})
  end
  local stored_version = tonumber(redis.call('HGET', keys[1], 'version'))
  if stored_version ~= expected_version then
    return cjson.encode({status='error', code='VERSION_CONFLICT'})
  end
  local open_link_id = redis.call('HGET', keys[1], 'openLinkId')
  for index = 1, n do
    local entry = declared.links[index]
    local link_key = keys[1 + (index * 2)]
    local reverse_key = keys[2 + (index * 2)]
    if open_link_id and entry.id == open_link_id then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if key_type(link_key) ~= 'hash' then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if redis.call('HGET', link_key, 'id') ~= entry.id then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if redis.call('HGET', link_key, 'bindingId') ~= declared.bindingId then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if redis.call('HGET', link_key, 'sessionId') ~= entry.sessionId then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if not redis.call('HGET', link_key, 'unlinkedAt') then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if not redis.call('ZSCORE', keys[2], entry.id) then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if key_type(reverse_key) ~= 'string' then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
    if redis.call('GET', reverse_key) ~= declared.bindingId then
      return cjson.encode({status='error', code='VERSION_CONFLICT'})
    end
  end
  for index = 1, n do
    local entry = declared.links[index]
    redis.call('ZREM', keys[2], entry.id)
    redis.call('DEL', keys[1 + (index * 2)])
    redis.call('DEL', keys[2 + (index * 2)])
  end
  local trimmed_total = redis.call('HINCRBY', keys[1], 'trimmedLinkCount', n)
  local version = redis.call('HINCRBY', keys[1], 'version', 1)
  local oldest = redis.call('ZRANGE', keys[2], 0, 0, 'WITHSCORES')
  local oldest_retained = nil
  if oldest and oldest[2] then
    oldest_retained = iso_from_milliseconds(tonumber(oldest[2]))
    redis.call('HSET', keys[1], 'oldestRetainedLinkedAt', oldest_retained)
  else
    redis.call('HDEL', keys[1], 'oldestRetainedLinkedAt')
  end
  local result = {status='trimmed', trimmed=n, version=version, trimmedLinkCount=trimmed_total}
  if oldest_retained then result.oldestRetainedLinkedAt = oldest_retained end
  return cjson.encode(result)
end
```

Note the validation loop runs to completion before the mutation loop starts, which is what makes
every refusal zero-mutation.

- [ ] **Step 5: Run and watch them pass**

Same command as Step 2. Expected: PASS, 16 tests.

- [ ] **Step 6: Mutation-check the zero-mutation claim**

Temporarily move the `ZREM`/`DEL` loop above the validation loop, re-run, confirm the refusal cases
fail, then restore. Record the observed failure in the final report.

---

## Task 4: Repository reads and the trim call

**Files:**

- Modify: `packages/redis/src/runtime-repository.ts`
- Test: `packages/redis/src/native-link-retention.integration.test.ts`

**Interfaces:**

- Produces, on `RuntimeRepository`:

```ts
listSessionNativeBindingIds(sessionIds: readonly string[]): Promise<string[]>;
getNativeRetentionState(bindingId: string): Promise<NativeRetentionState | null>;
listOldestNativeLinks(bindingId: string, limit: number): Promise<NativeSessionLink[]>;
trimNativeLinks(input: NativeLinkTrimInput): Promise<NativeLinkTrimResult>;

export type NativeRetentionState = { binding: NativeSessionBinding; linkCount: number };
export type NativeLinkTrimInput = {
  bindingId: string;
  expectedVersion: number;
  links: readonly { id: string; sessionId: string }[];
};
export type NativeLinkTrimResult = {
  trimmedCount: number;
  version: number;
  trimmedLinkCount: number;
  oldestRetainedLinkedAt?: string;
};
```

`trimNativeLinks` throws `RedisRepositoryError('VERSION_CONFLICT', …)` on a refusal, exactly as
`closeSession` does, so the sweeper's handling matches the presence sweeper's established shape.

- [ ] **Step 1: Write the failing repository tests**

Add to the integration file:

```ts
it('reads the distinct binding ids named by a session list', async () => {
  /* … */
});
it('reports the binding with its link count', async () => {
  /* … */
});
it('lists the oldest links in score order', async () => {
  /* … */
});
it('trims through the repository and reports the new metadata', async () => {
  /* … */
});
it('throws VERSION_CONFLICT from the repository on a stale version', async () => {
  /* … */
});
```

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL — `repository.listSessionNativeBindingIds is not a function`.

- [ ] **Step 3: Implement**

`listSessionNativeBindingIds`: `MGET` over `keys.sessionNativeBinding(id)` for every supplied
session id, in chunks of 256; keep non-empty strings; de-duplicate preserving first-seen order.
Return `[]` for an empty input without issuing a command.

`getNativeRetentionState`: `HGETALL` the binding through `parseNativeBindingHash`, `ZCARD` the links
zset; return `null` when the binding is absent.

`listOldestNativeLinks`: `ZRANGE key 0 limit-1`, then `HGETALL` each member through
`parseNativeLinkHash`; skip members whose hash is missing. Return `[]` when `limit < 1`.

`trimNativeLinks`: build the `2 + 2N` key list from `keys.nativeSessionBinding`,
`keys.nativeSessionLinks`, `keys.nativeSessionLink(link.id)` and
`keys.sessionNativeBinding(link.sessionId)`; `FCALL` with `String(expectedVersion)` and the declared
JSON; parse the reply with a new `parseNativeLinkTrimResult` that throws
`RedisRepositoryError(code, …)` on `status === 'error'` and validates the numbers.

- [ ] **Step 4: Run and watch them pass**

Expected: PASS, 21 tests in the file.

---

## Task 5: The retention sweeper service

**Files:**

- Modify: `packages/runtime/src/native-link-retention.ts`
- Test: `packages/runtime/src/native-link-retention.test.ts`

**Interfaces:**

- Produces:

```ts
export interface NativeLinkRetentionRepository {
  listBindingIds(sessionIds: readonly string[]): Promise<string[]>;
  getRetentionState(bindingId: string): Promise<{
    version: number;
    openLinkId?: string;
    linkCount: number;
  } | null>;
  listOldestLinks(bindingId: string, limit: number): Promise<RetainedNativeLink[]>;
  trimLinks(input: {
    bindingId: string;
    expectedVersion: number;
    links: NativeLinkTrimTarget[];
  }): Promise<'trimmed' | 'conflict'>;
}

export type NativeLinkRetentionSweepResult = {
  bindings: number;
  trimmed: number;
  conflicts: number;
  unchanged: number;
};

export function createNativeLinkRetentionSweeper(options: {
  repository: NativeLinkRetentionRepository;
  retentionMax: number;
  maxPerCall?: number;
}): {
  sweepOnce(sessionIds: readonly string[]): Promise<NativeLinkRetentionSweepResult>;
  stop(): void;
};
```

- [ ] **Step 1: Write the failing sweeper tests**

```ts
it('trims one batch per binding and leaves the rest to the next sweep', async () => {
  // 1064 closed links, bound 1000 -> first sweep trims 32, second trims 32.
});

it('does not retry a conflicted binding inside the same sweep', async () => {
  // trimLinks resolves 'conflict'; assert exactly one call for that binding.
});

it('leaves a binding under the bound untouched and calls no trim', async () => {});

it('subtracts the open link from the retained count', async () => {
  // linkCount 1001 with an open link is 1000 closed -> nothing to trim.
});

it('stops sweeping after stop()', async () => {});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run packages/runtime/src/native-link-retention.test.ts`
Expected: FAIL — `createNativeLinkRetentionSweeper` is not exported.

- [ ] **Step 3: Implement**

```ts
class RuntimeNativeLinkRetentionSweeper {
  // for each binding id:
  //   state = await getRetentionState(id); if null -> unchanged
  //   closed = state.linkCount - (state.openLinkId === undefined ? 0 : 1)
  //   if closed <= retentionMax -> unchanged, no read of links
  //   want = Math.min(closed - retentionMax, maxPerCall)
  //   oldest = await listOldestLinks(id, want + 1)   // +1 covers the single open link
  //   links = selectTrimmableNativeLinks({...})
  //   if links.length === 0 -> unchanged
  //   outcome = await trimLinks({ bindingId: id, expectedVersion: state.version, links })
  //   'conflict' -> conflicts += 1 and continue to the next binding, no retry
}
```

- [ ] **Step 4: Run and watch them pass**

Expected: PASS, 11 tests in the file.

---

## Task 6: Daemon wiring

**Files:**

- Modify: `apps/daemon/src/runtime.ts`
- Test: `apps/daemon/src/runtime.test.ts`

**Interfaces:**

- Consumes: Tasks 1, 4, 5.
- Produces: `createNativeLinkRetentionRepository({ repository })`, an adapter from
  `RuntimeRepository` to `NativeLinkRetentionRepository`, exported for test.

- [ ] **Step 1: Write the failing adapter tests**

In `apps/daemon/src/runtime.test.ts`, beside the presence-sweeper adapter tests:

```ts
it('maps a repository version conflict to a conflict outcome', async () => {});
it('passes the declared links straight through to the repository', async () => {});
it('reports the binding link count and open link from the repository', async () => {});
```

Plus a lifecycle assertion that the sweeper stops with the runtime and that the retention pass owns
no new timer:

```ts
it('adds no timer of its own to the retention pass', () => {
  // assert the sweeper is invoked from the existing retention callback,
  // by counting setInterval calls before and after the change.
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run apps/daemon/src/runtime.test.ts -t 'native link retention'`
Expected: FAIL — `createNativeLinkRetentionRepository` is not exported.

- [ ] **Step 3: Implement**

Add the adapter, translating `RedisRepositoryError` with code `VERSION_CONFLICT` into `'conflict'`
and re-throwing anything else. Construct the sweeper beside `leaseExpirySweeper`. Call it **inside
the existing retention callback**, after `runMessageRetention`, reusing the `sessions` list already
read there:

```ts
await nativeLinkRetentionSweeper.sweepOnce(sessions.map(({ id }) => id));
```

Add `nativeLinkRetentionSweeper.stop()` beside `leaseExpirySweeper.stop()` in the shutdown block.
**Create no `setInterval`.**

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run apps/daemon/src/runtime.test.ts`
Expected: PASS, whole file.

---

## Task 7: Documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-08-11-native-session-binding-design.md`
- Modify: `docs/decisions/0022-native-session-binding.md`

- [ ] **Step 1: Update the spec**

§0 currently says A2 is unimplemented and that A1 alone is not acceptance. Replace the delivery
status with A2 implemented, and record D1, D2 and D3 in §11 as the decisions they are.

- [ ] **Step 2: Update the ADR**

Replace the "**A1 is not acceptance of A**" consequence with the retention behaviour that now holds,
naming the bound, the per-call cap, the enumeration route (D1) and the version decision (D3). Do not
weaken the remaining honest limitations: `usage.sessionId`, MCP self-registration and transcript
ingestion are still not solved.

- [ ] **Step 3: Verify formatting**

Run: `npx prettier --check docs/decisions/0022-native-session-binding.md docs/superpowers/specs/2026-08-11-native-session-binding-design.md docs/superpowers/plans/2026-08-12-native-session-link-retention.md`
Expected: all files use Prettier code style.

---

## Task 8: Full verification

- [ ] `pnpm format`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Measure the chosen Redis test database before the run; it must be empty.
- [ ] `LUWI_TEST_REDIS_URL=redis://127.0.0.1:6379/14 LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS=true pnpm test:integration`
- [ ] Confirm afterwards: `DBSIZE` 0, no `luwi:test:*` key, no `luwi_test_*` Function.
- [ ] `git diff --check`
- [ ] `git status` shows only the expected files, no untracked leftovers, no secrets.

---

## Regression coverage map

| Required regression                        | Where                                                 |
| ------------------------------------------ | ----------------------------------------------------- |
| 1. 1001 closed → only the oldest trimmed   | Task 3 case 1, Task 2 "selects exactly the overshoot" |
| 2. open link preserved even when oldest    | Task 3 case 2, Task 2 "skips the open link"           |
| 3. never more than 32 per call             | Task 3 cases 3 and 15, Task 2 cap test                |
| 4. hash, zset and reverse removed together | Task 3 case 4                                         |
| 5. metadata and version correct            | Task 3 cases 5 and 6                                  |
| 6. stale `expectedVersion` changes nothing | Task 3 case 7                                         |
| 7. key/payload or identity mismatch        | Task 3 cases 8–13                                     |
| 8. conflict not retried in the same sweep  | Task 5 "does not retry a conflicted binding"          |
| 9. second sweep clears the remainder       | Task 5 "leaves the rest to the next sweep"            |
| 10. binding under the bound unchanged      | Task 3 (no candidate), Task 5 "under the bound"       |
| 11. config default, override, invalid      | Task 1                                                |
| 12. lifecycle wiring, no timer leak        | Task 6                                                |
