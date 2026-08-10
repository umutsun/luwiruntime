# Dashboard Configuration Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `#/config` the ability to create, apply and roll back native configuration plans, behind a confirmation gate, and harden the daemon's request validation for state-changing methods.

**Architecture:** The daemon's existing `validateLocalHttpRequest` becomes method-aware: a state-changing request with no `Origin` is accepted only when its media type is `application/json`, which a browser cannot send cross-site without a preflight the daemon never answers. In the dashboard a single new module, `api/config-mutations.ts`, is the only production module permitted to issue a state-changing request; the read client keeps exposing `get` and nothing else. Apply is gated by a confirmation dialog, and `approve` and `apply` run inside one handler so the one-time token never outlives the gesture.

**Tech Stack:** TypeScript, Fastify, React 19, Zod, Vitest, Testing Library.

## Global Constraints

- Source of truth for the design: `docs/superpowers/specs/2026-08-10-dashboard-config-mutations-design.md`.
- Node >= 22 (this machine runs v26.3.0); pnpm 11.9.0; run every command from the repository root.
- `pnpm test` already includes dashboard tests. `tsc -b` does **not** cover `apps/dashboard`; `pnpm typecheck` and `pnpm build` each have a separate dashboard leg.
- `exactOptionalPropertyTypes` is on. An optional property is added with a conditional spread — `...(x === undefined ? {} : { key: x })` — never as `key: undefined`.
- `@luwi/mcp-server` must never import `@luwi/redis`; `@luwi/protocol` and `@luwi/runtime` must never import `redis`.
- Anything re-exported from `packages/protocol/src/browser.ts` must transitively import nothing from `node:*`. `runtime-event.ts` imports `node:crypto`, so `realtime.ts` and `runtime-api.ts` are both poisoned for browser use. `apps/dashboard/vite.config.test.ts` runs a real Rollup build to catch violations.
- Every `className` literal used in `apps/dashboard/src/routes/config-view.tsx` must be defined in one of the five stylesheets listed in `apps/dashboard/src/styles/class-coverage.test.ts`. Add new rules to `apps/dashboard/src/styles/projects.css`, which is where the existing config-view classes live.
- In `projects.css`, every **opaque** colour must come from a token in `tokens.css`. Translucent `rgba()` is exempt. Enforced by `apps/dashboard/src/styles/tokens.test.ts`.
- Tokens whose names start with `--z-` are exempt from the light-theme override guard, so a new z-index token needs no light-block entry.
- Per `AGENTS.md` section 13 and `CLAUDE.md`, **do not run `git commit` unless the user explicitly asks.** The commit steps in this plan are written out so the user can approve them in one act; if no such approval has been given, complete the task's other steps and stop before committing.
- Never claim a command passed unless it actually ran and succeeded.

---

### Task 1: Method-aware local HTTP request validation

Makes a state-changing request with no `Origin` acceptable only when it carries a JSON media type. GET and HEAD keep today's behaviour exactly.

**Files:**

- Modify: `apps/daemon/src/websocket-hub.ts:160-177`
- Modify: `apps/daemon/src/websocket-hub.test.ts:200-240`
- Modify: `apps/daemon/src/app.ts:265-291`
- Modify: `apps/daemon/src/app.test.ts:75-121`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `LocalHttpRequestInput` gains `method: string` (required) and `contentType?: string`. `validateLocalHttpRequest(input: LocalHttpRequestInput): boolean` keeps its signature shape and return type.

- [ ] **Step 1: Add `method` to the three existing validator call sites so the suite still compiles**

In `apps/daemon/src/websocket-hub.test.ts`, the `HTTP loopback security` describe block has two direct calls and one call inside a `for` loop. Add `method: 'GET'` to each, because every one of them is asserting read behaviour:

```ts
it('accepts loopback CLI requests without Origin and exact browser origins', () => {
  expect(
    validateLocalHttpRequest({
      host: '127.0.0.1:4782',
      method: 'GET',
      remoteAddress: '127.0.0.1',
      expectedHosts,
      allowedOrigins,
    }),
  ).toBe(true);
  expect(
    validateLocalHttpRequest({
      host: 'localhost:4782',
      method: 'GET',
      origin: 'http://localhost:4782',
      remoteAddress: '::1',
      expectedHosts,
      allowedOrigins,
    }),
  ).toBe(true);
});
```

For the rejection loop, add `method: 'GET'` to the call that spreads each input, not to the input literals:

```ts
expect(
  validateLocalHttpRequest({
    ...input,
    method: 'GET',
    expectedHosts,
    allowedOrigins,
  }),
).toBe(false);
```

- [ ] **Step 2: Write the failing tests for the new rule**

Append to the `HTTP loopback security` describe block in `apps/daemon/src/websocket-hub.test.ts`:

```ts
it('keeps every read rule unchanged when the method is safe', () => {
  for (const method of ['GET', 'HEAD', 'get']) {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method,
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(true);
  }
});

it('accepts a state-changing request whose Origin is allowlisted, whatever it sends', () => {
  for (const contentType of ['application/json', 'text/plain', undefined]) {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method: 'POST',
        origin: 'http://127.0.0.1:4782',
        ...(contentType === undefined ? {} : { contentType }),
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(true);
  }
});

it('rejects a state-changing request whose Origin is not allowlisted', () => {
  expect(
    validateLocalHttpRequest({
      host: '127.0.0.1:4782',
      method: 'POST',
      origin: 'http://evil.test',
      contentType: 'application/json',
      remoteAddress: '127.0.0.1',
      expectedHosts,
      allowedOrigins,
    }),
  ).toBe(false);
});

it('accepts an Origin-less state-changing request only with a JSON media type', () => {
  // The CLI, the MCP server and the seed script all send this header. A
  // browser cannot send it cross-site without a preflight the daemon never
  // answers, so an absent Origin plus JSON means a non-browser client.
  for (const contentType of [
    'application/json',
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
  ]) {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method: 'POST',
        contentType,
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(true);
  }

  for (const contentType of [
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain; charset=utf-8',
  ]) {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method: 'POST',
        contentType,
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(false);
  }

  expect(
    validateLocalHttpRequest({
      host: '127.0.0.1:4782',
      method: 'POST',
      remoteAddress: '127.0.0.1',
      expectedHosts,
      allowedOrigins,
    }),
  ).toBe(false);
});

it('applies the rule to every state-changing method, not only POST', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method,
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(false);
  }
});

it('still rejects a literal null Origin on a state-changing request', () => {
  expect(
    validateLocalHttpRequest({
      host: '127.0.0.1:4782',
      method: 'POST',
      origin: 'null',
      contentType: 'application/json',
      remoteAddress: '127.0.0.1',
      expectedHosts,
      allowedOrigins,
    }),
  ).toBe(false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run apps/daemon/src/websocket-hub.test.ts`

Expected: FAIL. TypeScript reports `method` is not a known property of `LocalHttpRequestInput`, and the JSON-media-type assertions fail because the current implementation returns `true` for any absent origin.

- [ ] **Step 4: Implement the method-aware rule**

Replace `apps/daemon/src/websocket-hub.ts:160-177` with:

```ts
export type LocalHttpRequestInput = {
  host: string | undefined;
  method: string;
  origin?: string;
  contentType?: string;
  remoteAddress: string | undefined;
  expectedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
};

/** Methods that cannot change state, and therefore keep the original rule. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

function mediaType(value: string | undefined): string | undefined {
  return value?.split(';')[0]?.trim().toLowerCase();
}

export function validateLocalHttpRequest(input: LocalHttpRequestInput): boolean {
  const host = input.host?.trim().toLowerCase();
  if (!isLoopback(input.remoteAddress) || host === undefined || !input.expectedHosts.has(host)) {
    return false;
  }
  if (input.origin === 'null') {
    return false;
  }
  if (input.origin !== undefined) {
    return input.allowedOrigins.has(input.origin);
  }
  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return true;
  }
  /**
   * A state-changing request that carries no Origin at all.
   *
   * A browser attaches Origin to every method other than GET and HEAD, so an
   * absent one already implies a non-browser client — but that is the browser's
   * promise rather than the daemon's. Requiring a media type a browser cannot
   * send cross-site without a preflight makes it the daemon's too: no
   * `Access-Control-*` header and no `OPTIONS` handler exists here, so the
   * preflight fails and the request never leaves the browser. The CLI, the MCP
   * server and the seed script all send this header already.
   */
  return mediaType(input.contentType) === 'application/json';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/daemon/src/websocket-hub.test.ts`

Expected: PASS, all cases.

- [ ] **Step 6: Write the failing route-level test**

In `apps/daemon/src/app.test.ts`, extend the `rejects DNS-rebinding Hosts and hostile browser Origins for reads and mutations` test. Add two entries to the rejection array, after the existing `http://evil.test` entry:

```ts
      {
        method: 'POST' as const,
        url: '/test/mutation',
        headers: {
          host: 'localhost:80',
          'content-type': 'text/plain',
        },
      },
      {
        method: 'POST' as const,
        url: '/test/mutation',
        headers: {
          host: 'localhost:80',
        },
      },
```

and add this assertion after the existing `GET /api/v1/runtime` success assertion at the end of the same test:

```ts
// The CLI and MCP shape: no Origin, JSON body. This must keep working, and
// it is the only Origin-less shape that may.
expect(
  (
    await app.inject({
      method: 'POST',
      url: '/test/mutation',
      headers: { host: 'localhost:80', 'content-type': 'application/json' },
      payload: {},
      remoteAddress: '127.0.0.1',
    })
  ).statusCode,
).toBe(200);
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm vitest run apps/daemon/src/app.test.ts -t 'rejects DNS-rebinding'`

Expected: FAIL. The two new rejection cases return 200 because the hook still passes no method to the validator.

- [ ] **Step 8: Pass the method and content type from the request hook**

In `apps/daemon/src/app.ts`, inside the `onRequest` hook, replace the `validateLocalHttpRequest` call arguments with:

```ts
    const contentType = request.headers['content-type'];
    if (
      !validateLocalHttpRequest({
        host: request.headers.host,
        method: request.method,
        ...(typeof origin === 'string' ? { origin } : {}),
        ...(typeof contentType === 'string' ? { contentType } : {}),
        remoteAddress: request.raw.socket.remoteAddress,
        expectedHosts,
        allowedOrigins,
      })
    ) {
```

Leave the 403 response body exactly as it is: `REQUEST_ORIGIN_REJECTED` with the same message. No new error code, no CORS header, no `OPTIONS` handler.

- [ ] **Step 9: Run the daemon suite**

Run: `pnpm vitest run apps/daemon/src`

Expected: PASS. If any other test constructs `LocalHttpRequestInput`, add `method` to it — the type is required precisely so no call site can be silently permissive.

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/websocket-hub.ts apps/daemon/src/websocket-hub.test.ts apps/daemon/src/app.ts apps/daemon/src/app.test.ts
git commit -m "feat: require a JSON media type on Origin-less state-changing requests"
```

---

### Task 2: Browser-safe protocol exports

Gives the dashboard the schemas the mutations return, without dragging `node:crypto` into the browser bundle.

**Files:**

- Create: `packages/protocol/src/public-error.ts`
- Modify: `packages/protocol/src/runtime-api.ts:16-24`
- Modify: `packages/protocol/src/browser.ts:1-11`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/public-error.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `publicErrorResponseSchema`, `configPlanSchema`, `configPlanApprovalResponseSchema` and `configOperationReceiptSchema` all importable from `@luwi/protocol/browser`. `PublicErrorResponse` type unchanged.

- [ ] **Step 1: Write the failing leaf-module test**

Create `packages/protocol/src/public-error.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { publicErrorResponseSchema } from './public-error.js';

describe('public error response', () => {
  it('accepts the shape the daemon returns for a refused mutation', () => {
    const parsed = publicErrorResponseSchema.parse({
      error: { code: 'CONFIG_PLAN_EXPIRED', message: 'The configuration plan has expired.' },
    });

    expect(parsed.error.code).toBe('CONFIG_PLAN_EXPIRED');
  });

  it('accepts bounded safe details and rejects unbounded ones', () => {
    expect(
      publicErrorResponseSchema.safeParse({
        error: { code: 'X', message: 'y', details: { existingProjectId: 'p-1', count: 2 } },
      }).success,
    ).toBe(true);
    expect(
      publicErrorResponseSchema.safeParse({
        error: { code: 'X', message: 'y', details: { nested: { deep: true } } },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty code or message, so a failure cannot render as blank', () => {
    expect(publicErrorResponseSchema.safeParse({ error: { code: '', message: 'y' } }).success).toBe(
      false,
    );
    expect(publicErrorResponseSchema.safeParse({ error: { code: 'X', message: '' } }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/protocol/src/public-error.test.ts`

Expected: FAIL with a module-not-found error for `./public-error.js`.

- [ ] **Step 3: Create the leaf module**

Create `packages/protocol/src/public-error.ts`:

```ts
import { z } from 'zod';

/**
 * The daemon's public error body.
 *
 * This lives in its own leaf module rather than in `runtime-api.ts` for the
 * same reason `stream-id.ts` does: `runtime-api.ts` imports `realtime.ts`,
 * which imports `runtime-event.ts`, which imports `node:crypto`. Re-exporting
 * this schema through `browser.ts` from there would pull a Node builtin into
 * the browser bundle, which `apps/dashboard/vite.config.test.ts` catches and
 * which AGENTS.md section 5 exists to protect. Nothing about the schema itself
 * changed when it moved.
 */

const safeErrorDetailSchema = z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]);

export const publicErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
    details: z.record(z.string(), safeErrorDetailSchema).optional(),
  }),
});

export type PublicErrorResponse = z.infer<typeof publicErrorResponseSchema>;
```

- [ ] **Step 4: Re-export from `runtime-api.ts` so existing consumers are untouched**

In `packages/protocol/src/runtime-api.ts`, delete the local `safeErrorDetailSchema` constant and the local `publicErrorResponseSchema` declaration, and delete the `export type { PublicErrorResponse }` line if it duplicates the leaf. Add near the top, beside the other imports:

```ts
export { publicErrorResponseSchema } from './public-error.js';
export type { PublicErrorResponse } from './public-error.js';
```

- [ ] **Step 5: Export the four schemas from the browser entry**

In `packages/protocol/src/browser.ts`, add the three control-plane schemas to the existing `from './control-plane.js'` export list, keeping it alphabetical:

```ts
export {
  agentDefinitionCollectionSchema,
  capabilityCollectionSchema,
  capabilityProfileCollectionSchema,
  configDriftCollectionSchema,
  configOperationReceiptSchema,
  configPlanApprovalResponseSchema,
  configPlanCollectionSchema,
  configPlanSchema,
  configSnapshotCollectionSchema,
  contextFootprintSchema,
  contextSourceCollectionSchema,
  effectiveAgentConfigurationSchema,
  projectAgentBindingCollectionSchema,
} from './control-plane.js';
```

and add a new line for the leaf module — from `./public-error.js`, never from `./runtime-api.js`:

```ts
export { publicErrorResponseSchema } from './public-error.js';
```

- [ ] **Step 6: Verify `index.ts` still exports what it did**

`packages/protocol/src/index.ts` re-exports `publicErrorResponseSchema` through `runtime-api.js`. Confirm it still resolves; if it names the file directly, point it at `./public-error.js` instead. Run:

Run: `pnpm --filter @luwi/protocol build`

Expected: build succeeds with no unresolved export.

- [ ] **Step 7: Run the protocol tests and the bundle boundary guard**

Run: `pnpm vitest run packages/protocol/src apps/dashboard/vite.config.test.ts`

Expected: PASS. The bundle test performs a real Rollup build and fails if any `node:` builtin is externalised into the browser entry.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src/public-error.ts packages/protocol/src/public-error.test.ts packages/protocol/src/runtime-api.ts packages/protocol/src/browser.ts packages/protocol/src/index.ts
git commit -m "refactor: move the public error schema to a browser-safe leaf module"
```

---

### Task 3: The dashboard mutation module

The only production module in the dashboard permitted to issue a state-changing request.

**Files:**

- Create: `apps/dashboard/src/api/config-mutations.ts`
- Create: `apps/dashboard/src/api/config-mutations.test.ts`
- Modify: `apps/dashboard/src/product-independence.test.ts:38-52`

**Interfaces:**

- Consumes: the four schemas exported from `@luwi/protocol/browser` in Task 2.
- Produces:
  - `type MutationResult<T>` as defined below.
  - `createConfigMutations(fetchImpl?: typeof fetch)` returning an object with `createImportPlan`, `createRenderPlan`, `createRollbackPlan`, `scanDrift`, `applyPlanWithApproval`.
  - `type ConfigMutations = ReturnType<typeof createConfigMutations>`.
  - `type PlanCreateInput = { agentId: string; projectId?: string; adoptUnmanaged: boolean }`.

- [ ] **Step 1: Widen the guard test first, so the new module is legal**

In `apps/dashboard/src/product-independence.test.ts`, replace the whole `issues no mutation request from any production module` test with:

```ts
it('issues mutation requests from the config mutation module and nowhere else', () => {
  const files = productionSources(sourceRoot);
  const mutationModule = join(sourceRoot, 'api', 'config-mutations.ts');
  expect(files, 'the allowlisted module must exist, or this test passes vacuously').toContain(
    mutationModule,
  );

  // Dashboard mutations were approved on 2026-08-10 for the configuration
  // plan chain only. The ban is not lifted, it is narrowed to one module, so
  // a mutation that appears anywhere else is still a defect.
  const elsewhere = files
    .filter((path) => path !== mutationModule)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  expect(elsewhere).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
  expect(elsewhere).not.toMatch(/['"`][^'"`]*\/(?:scan|rebuild|apply|approve|rollback)['"`]/);
});

it('calls no prohibited mutation, including from the allowlisted module', () => {
  const source = productionSources(sourceRoot)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  // These carry their own prohibitions elsewhere in AGENTS.md and the
  // dashboard-mutation approval explicitly does not carry them in.
  expect(source).not.toMatch(/\/proposals\/[^'"`]*\/(?:accept|reject|evaluate)/);
  expect(source).not.toMatch(/\/graph\/rebuild/);
  expect(source).not.toMatch(/\/config\/reconcile/);
  expect(source).not.toMatch(/\/git\/[^'"`]*\/(?:commit|checkout|push)/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/dashboard/src/product-independence.test.ts`

Expected: FAIL on `the allowlisted module must exist, or this test passes vacuously` — the module is not written yet.

- [ ] **Step 3: Write the failing mutation module tests**

Create `apps/dashboard/src/api/config-mutations.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createConfigMutations } from './config-mutations.js';

const timestamp = '2026-08-10T00:00:00.000Z';

const plan = {
  id: 'plan-1',
  agentId: 'codex-main',
  projectId: 'proj-1',
  state: 'prepared',
  kind: 'render',
  changes: [
    {
      path: 'C:/fixture/.codex/config.toml',
      operation: 'update',
      managementMode: 'managed-fragment',
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64),
      redactedDiff: '+ enabled = true',
      warnings: [],
    },
  ],
  preconditionHashes: { 'C:/fixture/.codex/config.toml': 'a'.repeat(64) },
  createdAt: timestamp,
  expiresAt: '2026-08-10T00:15:00.000Z',
};

const receipt = {
  id: 'op-1',
  planId: 'plan-1',
  agentId: 'codex-main',
  projectId: 'proj-1',
  state: 'completed',
  targetPaths: ['C:/fixture/.codex/config.toml'],
  expectedHashes: { 'C:/fixture/.codex/config.toml': 'a'.repeat(64) },
  committedHashes: { 'C:/fixture/.codex/config.toml': 'b'.repeat(64) },
  startedAt: timestamp,
  updatedAt: timestamp,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('config mutations', () => {
  it('sends a JSON media type on every request, which the daemon now requires', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(plan, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    await mutations.createRenderPlan({ agentId: 'codex-main', adoptUnmanaged: false });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('creates an import plan and a render plan at their own endpoints', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(plan, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    await mutations.createImportPlan({ agentId: 'codex-main', adoptUnmanaged: true });
    await mutations.createRenderPlan({
      agentId: 'codex-main',
      projectId: 'proj-1',
      adoptUnmanaged: false,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/config/import-plan');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/config/render-plan');
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      agentId: 'codex-main',
      adoptUnmanaged: true,
    });
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      agentId: 'codex-main',
      projectId: 'proj-1',
      adoptUnmanaged: false,
    });
  });

  it('returns the plan a rollback produced', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ...plan, kind: 'rollback' }, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.createRollbackPlan('snap-1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/config/snapshots/snap-1/rollback-plan');
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.data.kind).toBe('rollback');
  });

  it('percent-encodes an identifier so it cannot escape its path segment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(plan, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    await mutations.createRollbackPlan('../../config/reconcile');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/v1/config/snapshots/..%2F..%2Fconfig%2Freconcile/rollback-plan',
    );
  });

  it('approves then applies, passing the token the approval returned', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ plan: { ...plan, state: 'approved' }, approvalToken: 't'.repeat(48) }),
      )
      .mockResolvedValueOnce(jsonResponse(receipt));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.applyPlanWithApproval('plan-1');

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/config/plans/plan-1/approve');
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/config/plans/plan-1/apply');
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      approvalToken: 't'.repeat(48),
    });
    expect(result.state).toBe('ok');
  });

  it('never applies when the approval failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: { code: 'CONFIG_PLAN_EXPIRED', message: 'The configuration plan has expired.' },
        },
        409,
      ),
    );
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.applyPlanWithApproval('plan-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'CONFIG_PLAN_EXPIRED',
      message: 'The configuration plan has expired.',
    });
  });

  it('reports an apply failure as its own, so an approved-but-dead plan is not called success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ plan: { ...plan, state: 'approved' }, approvalToken: 't'.repeat(48) }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'CONFIG_APPLY_FAILED',
              message: 'Another configuration operation currently owns a target file.',
            },
          },
          409,
        ),
      );
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.applyPlanWithApproval('plan-1');

    expect(result.state).toBe('failed');
    if (result.state !== 'failed' || result.reason !== 'http') return;
    expect(result.code).toBe('CONFIG_APPLY_FAILED');
  });

  it('keeps the daemon code and message for a refused runtime', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'RUNTIME_NOT_READY',
            message: 'The runtime is not ready to accept mutations.',
          },
        },
        503,
      ),
    );
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    const result = await mutations.scanDrift();

    expect(result).toEqual({
      state: 'failed',
      reason: 'http',
      httpStatus: 503,
      code: 'RUNTIME_NOT_READY',
      message: 'The runtime is not ready to accept mutations.',
    });
  });

  it('reports a transport rejection without inventing a status', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network'));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.scanDrift()).toEqual({ state: 'failed', reason: 'transport' });
  });

  it('reports a body that does not validate as invalid rather than trusting it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ plans: 'not a plan' }, 201));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    expect(
      await mutations.createRenderPlan({ agentId: 'codex-main', adoptUnmanaged: false }),
    ).toEqual({ state: 'failed', reason: 'invalid', httpStatus: 201 });
  });

  it('reports an unparseable error body as invalid rather than as a coded failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    const mutations = createConfigMutations(fetchImpl as unknown as typeof fetch);

    expect(await mutations.scanDrift()).toEqual({
      state: 'failed',
      reason: 'invalid',
      httpStatus: 502,
    });
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run apps/dashboard/src/api/config-mutations.test.ts`

Expected: FAIL with a module-not-found error for `./config-mutations.js`.

- [ ] **Step 5: Write the mutation module**

Create `apps/dashboard/src/api/config-mutations.ts`:

```ts
import {
  configDriftCollectionSchema,
  configOperationReceiptSchema,
  configPlanApprovalResponseSchema,
  configPlanSchema,
  publicErrorResponseSchema,
} from '@luwi/protocol/browser';
import type { z } from 'zod';

import type { ConfigDriftRecord, ConfigPlanRecord } from './config-scope.js';
import { driftKind } from './config-scope.js';

/**
 * The configuration plan chain, and the only production module in the dashboard
 * that issues a state-changing request.
 *
 * It builds its own request function rather than extending the read client, so
 * that `createDaemonClient` stays incapable of writing and the guard in
 * `product-independence.test.ts` can name exactly one legal module. AGENTS.md
 * section 21 approved dashboard mutations for this chain; `reconcile`,
 * optimization accept/reject/evaluate, graph rebuild and Git mutation are not
 * carried in by that approval and are absent here.
 *
 * Every request sends `content-type: application/json`, which the daemon
 * requires of a state-changing request that carries no Origin.
 */

export type MutationResult<T> =
  | { state: 'ok'; data: T; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number }
  | { state: 'failed'; reason: 'http'; httpStatus: number; code: string; message: string };

export type PlanCreateInput = {
  agentId: string;
  projectId?: string;
  adoptUnmanaged: boolean;
};

/** A daemon receipt for one applied plan. */
export type ConfigReceiptRecord = {
  id: string;
  planId: string;
  state: string;
  targetPaths: string[];
};

async function request<T>(
  fetchImpl: typeof fetch,
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
): Promise<MutationResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { state: 'failed', reason: 'transport' };
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { state: 'failed', reason: 'invalid', httpStatus: response.status };
  }

  if (!response.ok) {
    /**
     * The daemon's own code and message are carried through rather than
     * collapsed. `CONFIG_PLAN_EXPIRED` and `CONFIG_APPLY_FAILED` tell the
     * reader different true things, and this is the surface that writes their
     * configuration files.
     */
    const error = publicErrorResponseSchema.safeParse(value);
    return error.success
      ? {
          state: 'failed',
          reason: 'http',
          httpStatus: response.status,
          code: error.data.error.code,
          message: error.data.error.message,
        }
      : { state: 'failed', reason: 'invalid', httpStatus: response.status };
  }

  // `safeParse` can throw rather than return, which is how a rejected promise
  // once escaped every caller in the read client. Treated the same way here.
  let parsed: ReturnType<typeof schema.safeParse>;
  try {
    parsed = schema.safeParse(value);
  } catch {
    return { state: 'failed', reason: 'invalid', httpStatus: response.status };
  }
  return parsed.success
    ? { state: 'ok', data: parsed.data, httpStatus: response.status }
    : { state: 'failed', reason: 'invalid', httpStatus: response.status };
}

function toPlanRecord(plan: z.infer<typeof configPlanSchema>): ConfigPlanRecord {
  return {
    id: plan.id,
    agentId: plan.agentId,
    ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
    state: plan.state,
    kind: plan.kind,
    changes: plan.changes.map((change) => ({
      path: change.path,
      operation: change.operation,
      managementMode: change.managementMode,
      redactedDiff: change.redactedDiff,
      warnings: [...change.warnings],
    })),
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    ...(plan.snapshotId === undefined ? {} : { snapshotId: plan.snapshotId }),
    ...(plan.operationId === undefined ? {} : { operationId: plan.operationId }),
  };
}

export function createConfigMutations(fetchImpl: typeof fetch = fetch) {
  const planBody = (input: PlanCreateInput): Record<string, unknown> => ({
    agentId: input.agentId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    adoptUnmanaged: input.adoptUnmanaged,
  });

  const createPlanAt = async (
    path: string,
    input: PlanCreateInput,
  ): Promise<MutationResult<ConfigPlanRecord>> => {
    const result = await request(fetchImpl, path, configPlanSchema, planBody(input));
    return result.state === 'ok'
      ? { state: 'ok', data: toPlanRecord(result.data), httpStatus: result.httpStatus }
      : result;
  };

  return {
    createImportPlan: (input: PlanCreateInput) => createPlanAt('/api/v1/config/import-plan', input),

    createRenderPlan: (input: PlanCreateInput) => createPlanAt('/api/v1/config/render-plan', input),

    createRollbackPlan: async (snapshotId: string): Promise<MutationResult<ConfigPlanRecord>> => {
      const result = await request(
        fetchImpl,
        `/api/v1/config/snapshots/${encodeURIComponent(snapshotId)}/rollback-plan`,
        configPlanSchema,
        {},
      );
      return result.state === 'ok'
        ? { state: 'ok', data: toPlanRecord(result.data), httpStatus: result.httpStatus }
        : result;
    },

    scanDrift: async (): Promise<MutationResult<ConfigDriftRecord[]>> => {
      const result = await request(
        fetchImpl,
        '/api/v1/config/drift/scan',
        configDriftCollectionSchema,
        {},
      );
      return result.state === 'ok'
        ? {
            state: 'ok',
            httpStatus: result.httpStatus,
            data: result.data.drifts.map((entry) => ({
              id: entry.id,
              agentId: entry.agentId,
              ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
              path: entry.path,
              expectedHash: entry.expectedHash,
              observedHash: entry.observedHash,
              severity: entry.severity,
              resolution: entry.resolution,
              detectedAt: entry.detectedAt,
              kind: driftKind(entry),
            })),
          }
        : result;
    },

    /**
     * Approve and apply, in one call, deliberately.
     *
     * `approve` mints a one-time token and the plan state machine allows no
     * second approval, so a token that outlives this function is a plan the
     * runtime can never apply. It is held in a local variable and never written
     * to component state, storage, the URL or a log. The caller is responsible
     * for having obtained the user's confirmation before calling this.
     */
    applyPlanWithApproval: async (planId: string): Promise<MutationResult<ConfigReceiptRecord>> => {
      const id = encodeURIComponent(planId);
      const approval = await request(
        fetchImpl,
        `/api/v1/config/plans/${id}/approve`,
        configPlanApprovalResponseSchema,
        {},
      );
      if (approval.state !== 'ok') return approval;

      const applied = await request(
        fetchImpl,
        `/api/v1/config/plans/${id}/apply`,
        configOperationReceiptSchema,
        { approvalToken: approval.data.approvalToken },
      );
      return applied.state === 'ok'
        ? {
            state: 'ok',
            httpStatus: applied.httpStatus,
            data: {
              id: applied.data.id,
              planId: applied.data.planId,
              state: applied.data.state,
              targetPaths: [...applied.data.targetPaths],
            },
          }
        : applied;
    },
  };
}

export type ConfigMutations = ReturnType<typeof createConfigMutations>;
```

- [ ] **Step 6: Run the module tests**

Run: `pnpm vitest run apps/dashboard/src/api/config-mutations.test.ts`

Expected: PASS, all thirteen cases.

- [ ] **Step 7: Run the guard test**

Run: `pnpm vitest run apps/dashboard/src/product-independence.test.ts`

Expected: PASS. If the `elsewhere` assertion fails, a mutation leaked outside the allowlisted module — fix the module, not the test.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/api/config-mutations.ts apps/dashboard/src/api/config-mutations.test.ts apps/dashboard/src/product-independence.test.ts
git commit -m "feat: add the dashboard config mutation module behind a narrowed guard"
```

---

### Task 4: The agents read joins the config scope

The plan form needs a list of agents to choose from. `GET /api/v1/agents` already exists; this makes `#/config` a consumer of it.

**Files:**

- Modify: `apps/dashboard/src/api/config-scope.ts:108-145` and its `loadConfigScope` body
- Modify: `apps/dashboard/src/api/config-scope.test.ts`

**Interfaces:**

- Consumes: `agentDefinitionCollectionSchema` from `@luwi/protocol/browser` (already exported).
- Produces: `ConfigResources` gains `agents: ResourceState<ConfigAgentOption[]>`; `ConfigResourceKey` gains `'agents'`; `configResourceKeys` gains `'agents'`. `type ConfigAgentOption = { id: string; displayName: string; enabled: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/dashboard/src/api/config-scope.test.ts`:

```ts
describe('config scope agents read', () => {
  it('loads the agent options the plan form needs', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({
        state: 'ready',
        httpStatus: 200,
        receivedAt: '2026-08-10T00:00:00.000Z',
        data: {
          agents: [
            {
              id: 'codex-main',
              kind: 'codex',
              displayName: 'Codex',
              enabled: true,
              adapterId: 'adapter-1',
              nativeConfigRoots: [],
              createdAt: '2026-08-10T00:00:00.000Z',
              updatedAt: '2026-08-10T00:00:00.000Z',
              metadata: {},
            },
          ],
        },
      }),
    };

    const result = await loadConfigScope(client as never, ['agents']);

    expect(client.get).toHaveBeenCalledWith('/api/v1/agents', expect.anything(), {});
    expect(result.agents).toEqual({
      state: 'ready',
      data: [{ id: 'codex-main', displayName: 'Codex', enabled: true }],
    });
  });

  it('marks the agents read unavailable rather than offering an empty picker', async () => {
    const client = { get: vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'http' }) };

    const result = await loadConfigScope(client as never, ['agents']);

    expect(result.agents).toEqual({ state: 'unavailable' });
  });

  it('refreshes the agent list when an agent event arrives', () => {
    expect(configResourcesForEvent('agent.registered')).toContain('agents');
    expect(configResourcesForEvent('agent.updated')).toContain('agents');
    expect(configResourcesForEvent('config.plan.created')).not.toContain('agents');
  });

  it('includes agents in the keys the route loads', () => {
    expect(configResourceKeys).toContain('agents');
  });
});
```

Ensure `configResourceKeys` and `configResourcesForEvent` are in the file's import list, and `vi` is imported from `vitest`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/dashboard/src/api/config-scope.test.ts`

Expected: FAIL — `'agents'` is not assignable to `ConfigResourceKey`.

- [ ] **Step 3: Add the agents resource**

In `apps/dashboard/src/api/config-scope.ts`, add `agentDefinitionCollectionSchema` to the import from `@luwi/protocol/browser`, then:

```ts
/**
 * Only the three fields the plan form needs. The daemon's agent record carries
 * native config roots and metadata that this picker has no use for, and a
 * narrower type is one less thing to keep in step.
 */
export type ConfigAgentOption = {
  id: string;
  displayName: string;
  enabled: boolean;
};
```

Add `agents: ResourceState<ConfigAgentOption[]>;` to `ConfigResources`, and put `'agents'` first in `configResourceKeys`:

```ts
export const configResourceKeys: readonly ConfigResourceKey[] = [
  'agents',
  'drifts',
  'plans',
  'snapshots',
];
```

Add the event set and its branch:

```ts
const AGENT_EVENTS = new Set(['agent.registered', 'agent.updated', 'agent.removed']);
```

and inside `configResourcesForEvent`, before the `DRIFT_EVENTS` check:

```ts
if (AGENT_EVENTS.has(eventType)) return ['agents'];
```

Add the loader branch at the top of `loadConfigScope`'s body, before the `drifts` branch:

```ts
if (keys.includes('agents')) {
  const response = await client.get('/api/v1/agents', agentDefinitionCollectionSchema, get);
  result.agents =
    response.state === 'ready'
      ? {
          state: 'ready',
          data: response.data.agents.map((entry) => ({
            id: entry.id,
            displayName: entry.displayName,
            enabled: entry.enabled,
          })),
        }
      : { state: 'unavailable' };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/dashboard/src/api/config-scope.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/api/config-scope.ts apps/dashboard/src/api/config-scope.test.ts
git commit -m "feat: read the agent list into the config scope for the plan form"
```

---

### Task 5: The confirmation dialog component

A focus-trapping modal, built as a plain element rather than `<dialog>` because `showModal` is not reliably implemented in jsdom and the gate must be testable.

**Files:**

- Create: `apps/dashboard/src/components/confirm-dialog.tsx`
- Create: `apps/dashboard/src/components/confirm-dialog.test.tsx`
- Modify: `apps/dashboard/src/styles/tokens.css`
- Modify: `apps/dashboard/src/styles/projects.css`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `ConfirmDialog` with props `{ title: string; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void; children: ReactNode }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/components/confirm-dialog.test.tsx`:

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog.js';

afterEach(cleanup);

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Apply plan-1"
      confirmLabel="Apply"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    >
      <p>Writes two files.</p>
    </ConfirmDialog>,
  );
  return { onConfirm, onCancel };
}

describe('confirm dialog', () => {
  it('is a modal dialog labelled by its own heading', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Apply plan-1');
  });

  it('moves focus into the dialog so the keyboard is not left behind it', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('confirms and cancels through their own buttons', () => {
    const { onConfirm, onCancel } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', () => {
    const { onCancel } = renderDialog();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog in both directions', () => {
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Apply' });

    confirm.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(cancel).toHaveFocus();

    cancel.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
  });

  it('disables both controls while the confirmed work is in flight', () => {
    const { onConfirm, onCancel } = renderDialog({ busy: true });

    const confirm = screen.getByRole('button', { name: 'Apply' });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/dashboard/src/components/confirm-dialog.test.tsx`

Expected: FAIL with a module-not-found error for `./confirm-dialog.js`.

- [ ] **Step 3: Write the component**

Create `apps/dashboard/src/components/confirm-dialog.tsx`:

```tsx
import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A confirmation gate for an action that writes to the developer's own files.
 *
 * Built from a plain element rather than `<dialog>` because `showModal` is not
 * reliably implemented in jsdom, and a gate whose behaviour cannot be asserted
 * is not a gate. Focus is moved in on mount, trapped while open, and returned
 * to whatever opened it on unmount.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  /** The confirmed work is in flight; neither control may fire again. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  return (
    <div className="dialog-scrim">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          // Two controls, so the trap is a swap rather than a ring walk.
          event.preventDefault();
          const target = document.activeElement === cancelRef.current ? confirmRef : cancelRef;
          target.current?.focus();
        }}
      >
        <h2 id={headingId}>{title}</h2>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions">
          <button type="button" ref={cancelRef} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="dialog__confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/dashboard/src/components/confirm-dialog.test.tsx`

Expected: PASS, all six cases.

- [ ] **Step 5: Add the z-index token**

In `apps/dashboard/src/styles/tokens.css`, add to the `:root` block beside `--z-skip`:

```css
--z-dialog: 200;
```

No light-theme entry is needed: `tokens.test.ts` exempts `--z-` names from the colour override guard.

- [ ] **Step 6: Add the dialog styles**

Append to `apps/dashboard/src/styles/projects.css`. The scrim uses a translucent `rgba()`, which the colour guard exempts because it composites over whatever themed ground is beneath it; every opaque colour here comes from a token:

```css
.dialog-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(8, 10, 16, 0.62);
}

.dialog {
  width: min(46rem, 100%);
  max-height: 80vh;
  overflow-y: auto;
  padding: var(--space-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  color: var(--text);
}

.dialog h2 {
  margin: 0 0 var(--space-2);
  font-size: 1rem;
}

.dialog__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.dialog__confirm {
  border-color: var(--danger);
  color: var(--danger);
}

.dialog__confirm:disabled {
  color: var(--text-muted);
  border-color: var(--border);
}
```

- [ ] **Step 7: Run the style guards**

Run: `pnpm vitest run apps/dashboard/src/styles`

Expected: PASS. `tokens.test.ts` confirms no opaque literal colour was introduced; `class-coverage.test.ts` still passes because the route views have not changed yet.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/confirm-dialog.tsx apps/dashboard/src/components/confirm-dialog.test.tsx apps/dashboard/src/styles/tokens.css apps/dashboard/src/styles/projects.css
git commit -m "feat: add a focus-trapping confirmation dialog"
```

---

### Task 6: Config route controls

Puts the four controls on `#/config`: create a plan, apply a plan behind the dialog, create a rollback plan, rescan drift.

**Files:**

- Modify: `apps/dashboard/src/routes/config-view.tsx`
- Modify: `apps/dashboard/src/routes/config-view.test.tsx`
- Modify: `apps/dashboard/src/styles/projects.css`

**Interfaces:**

- Consumes: `ConfirmDialog` (Task 5), `ConfigMutations`, `MutationResult`, `PlanCreateInput` (Task 3), `ConfigAgentOption` (Task 4).
- Produces: `ConfigView` gains two optional props — `agents?: ResourceState<ConfigAgentOption[]>` and `mutations?: ConfigMutations` — plus `onMutated?: () => void`. When `mutations` is undefined every control is absent, which is what keeps every existing render test valid.

- [ ] **Step 1: Write the failing tests**

Append to `apps/dashboard/src/routes/config-view.test.tsx`. Use the file's existing `plan`, `drift` and `snapshot` factories:

```tsx
function agentsReady() {
  return {
    state: 'ready' as const,
    data: [{ id: 'codex-main', displayName: 'Codex', enabled: true }],
  };
}

function stubMutations(overrides: Partial<ConfigMutations> = {}): ConfigMutations {
  return {
    createImportPlan: vi.fn(),
    createRenderPlan: vi.fn(),
    createRollbackPlan: vi.fn(),
    scanDrift: vi.fn(),
    applyPlanWithApproval: vi.fn(),
    ...overrides,
  } as unknown as ConfigMutations;
}

describe('config view mutations', () => {
  it('offers no control at all when no mutation capability was passed', () => {
    render(
      <ConfigView
        drifts={{ state: 'ready', data: [drift()] }}
        plans={{ state: 'ready', data: [plan({ state: 'prepared' })] }}
        snapshots={{ state: 'ready', data: [snapshot()] }}
      />,
    );

    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /rescan/i })).toBeNull();
  });

  it('offers Apply on a prepared plan and nothing on an approved one', () => {
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{
          state: 'ready',
          data: [
            plan({ id: 'plan-prepared', state: 'prepared' }),
            plan({ id: 'plan-approved', state: 'approved' }),
          ],
        }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Apply plan-prepared' })).toBeInTheDocument();
    // The dashboard holds no token for an already-approved plan and the state
    // machine mints no second one, so offering a control would be a lie.
    expect(screen.queryByRole('button', { name: 'Apply plan-approved' })).toBeNull();
  });

  it('does not approve anything until the dialog is confirmed', () => {
    const applyPlanWithApproval = vi.fn();
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{ state: 'ready', data: [plan({ id: 'plan-1', state: 'prepared' })] }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations({ applyPlanWithApproval })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(applyPlanWithApproval).not.toHaveBeenCalled();
  });

  it('names every file the apply will write inside the dialog', () => {
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{ state: 'ready', data: [plan({ id: 'plan-1', state: 'prepared' })] }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText('C:/fixture/.codex/config.toml')).toBeInTheDocument();
    expect(within(dialog).getByText(/writes/i)).toBeInTheDocument();
  });

  it('cancelling the dialog approves nothing', () => {
    const applyPlanWithApproval = vi.fn();
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{ state: 'ready', data: [plan({ id: 'plan-1', state: 'prepared' })] }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations({ applyPlanWithApproval })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(applyPlanWithApproval).not.toHaveBeenCalled();
  });

  it('applies once on confirmation and reports the outcome', async () => {
    const applyPlanWithApproval = vi.fn().mockResolvedValue({
      state: 'ok',
      httpStatus: 200,
      data: { id: 'op-1', planId: 'plan-1', state: 'completed', targetPaths: ['a'] },
    });
    const onMutated = vi.fn();
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{ state: 'ready', data: [plan({ id: 'plan-1', state: 'prepared' })] }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations({ applyPlanWithApproval })}
        onMutated={onMutated}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await screen.findByText(/applied/i);
    expect(applyPlanWithApproval).toHaveBeenCalledTimes(1);
    expect(applyPlanWithApproval).toHaveBeenCalledWith('plan-1');
    expect(onMutated).toHaveBeenCalled();
  });

  it('renders the daemon message when the apply is refused', async () => {
    const applyPlanWithApproval = vi.fn().mockResolvedValue({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'CONFIG_APPLY_FAILED',
      message: 'Another configuration operation currently owns a target file.',
    });
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{ state: 'ready', data: [plan({ id: 'plan-1', state: 'prepared' })] }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations({ applyPlanWithApproval })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(
      await screen.findByText('Another configuration operation currently owns a target file.'),
    ).toBeInTheDocument();
  });

  it('rescans drift and creates a rollback plan through their own controls', async () => {
    const scanDrift = vi.fn().mockResolvedValue({ state: 'ok', httpStatus: 200, data: [] });
    const createRollbackPlan = vi
      .fn()
      .mockResolvedValue({ state: 'ok', httpStatus: 201, data: plan({ kind: 'rollback' }) });
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{ state: 'ready', data: [] }}
        drifts={{ state: 'ready', data: [drift()] }}
        snapshots={{ state: 'ready', data: [snapshot()] }}
        mutations={stubMutations({ scanDrift, createRollbackPlan })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Rescan drift' }));
    fireEvent.click(screen.getByRole('button', { name: /roll back/i }));

    await vi.waitFor(() => {
      expect(scanDrift).toHaveBeenCalledTimes(1);
      expect(createRollbackPlan).toHaveBeenCalledWith('snapshot-1');
    });
  });

  it('creates a plan from the form at whichever endpoint was pressed', async () => {
    const createRenderPlan = vi
      .fn()
      .mockResolvedValue({ state: 'ok', httpStatus: 201, data: plan() });
    render(
      <ConfigView
        agents={agentsReady()}
        plans={{ state: 'ready', data: [] }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations({ createRenderPlan })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Render plan' }));

    await vi.waitFor(() => {
      expect(createRenderPlan).toHaveBeenCalledWith({
        agentId: 'codex-main',
        adoptUnmanaged: false,
      });
    });
  });

  it('offers no plan form while the agent list is unavailable', () => {
    render(
      <ConfigView
        agents={{ state: 'unavailable' }}
        plans={{ state: 'ready', data: [] }}
        drifts={{ state: 'ready', data: [] }}
        snapshots={{ state: 'ready', data: [] }}
        mutations={stubMutations()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Render plan' })).toBeNull();
  });
});
```

Add `vi` to the `vitest` import, and import `type ConfigMutations` from `../api/config-mutations.js` and `type ConfigAgentOption` from `../api/config-scope.js`. Add a `snapshot` factory if the file does not already have one, with `id: 'snapshot-1'`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/dashboard/src/routes/config-view.test.tsx`

Expected: FAIL — `agents`, `mutations` and `onMutated` are not props of `ConfigView`.

- [ ] **Step 3: Add the mutation state hook to the view**

At the top of `apps/dashboard/src/routes/config-view.tsx`, extend the imports and add a small state holder used by every control:

```tsx
import { useState, type ReactNode } from 'react';

import type { ConfigAgentOption } from '../api/config-scope.js';
import type { ConfigMutations, MutationResult } from '../api/config-mutations.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
```

```tsx
/** What the surface says after a mutation returned. */
type Outcome = { tone: 'success' | 'danger'; text: string };

function outcomeOf(result: MutationResult<unknown>, success: string): Outcome {
  if (result.state === 'ok') return { tone: 'success', text: success };
  if (result.reason === 'transport') {
    return { tone: 'danger', text: 'The daemon could not be reached.' };
  }
  if (result.reason === 'invalid') {
    return { tone: 'danger', text: 'The daemon returned a response this view cannot validate.' };
  }
  // The daemon's own words. It knows why it refused and this view does not.
  return { tone: 'danger', text: result.message };
}

function OutcomeLine({ outcome }: { outcome: Outcome | undefined }) {
  if (outcome === undefined) return null;
  return (
    <p className={outcome.tone === 'success' ? 'outcome outcome--ok' : 'outcome outcome--bad'}>
      {outcome.text}
    </p>
  );
}
```

- [ ] **Step 4: Add the plan form**

Add this component to the same file:

```tsx
function PlanForm({
  agents,
  mutations,
  onMutated,
}: {
  agents: readonly ConfigAgentOption[];
  mutations: ConfigMutations;
  onMutated: () => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [adoptUnmanaged, setAdoptUnmanaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  const run = (
    create: (input: {
      agentId: string;
      adoptUnmanaged: boolean;
    }) => Promise<MutationResult<unknown>>,
  ) => {
    setBusy(true);
    setOutcome(undefined);
    void create({ agentId, adoptUnmanaged }).then((result) => {
      setBusy(false);
      setOutcome(outcomeOf(result, 'Plan prepared. Review its changes, then apply it.'));
      if (result.state === 'ok') onMutated();
    });
  };

  return (
    <Panel title="New plan" meta="Prepares changes; writes nothing until applied">
      <div className="plan-form">
        <label htmlFor="plan-form-agent">Agent</label>
        <select
          id="plan-form-agent"
          value={agentId}
          disabled={busy}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.displayName}
            </option>
          ))}
        </select>

        <label htmlFor="plan-form-adopt">
          <input
            id="plan-form-adopt"
            type="checkbox"
            checked={adoptUnmanaged}
            disabled={busy}
            onChange={(event) => setAdoptUnmanaged(event.target.checked)}
          />
          Adopt files LUWI does not already manage
        </label>

        <div className="plan-form__actions">
          <button
            type="button"
            disabled={busy || agentId === ''}
            onClick={() => run(mutations.createImportPlan)}
          >
            Import plan
          </button>
          <button
            type="button"
            disabled={busy || agentId === ''}
            onClick={() => run(mutations.createRenderPlan)}
          >
            Render plan
          </button>
        </div>
      </div>
      <OutcomeLine outcome={outcome} />
      <p className="bounded-note">
        An import plan brings the agent&apos;s existing native configuration under management. A
        render plan writes what LUWI would produce. Neither touches a file until it is applied.
      </p>
    </Panel>
  );
}
```

- [ ] **Step 5: Add the apply gate, rollback and rescan controls**

Extend `ConfigView`'s signature and body. Add the three optional props, the dialog state, and the controls:

```tsx
export function ConfigView({
  drifts,
  plans,
  snapshots,
  agents,
  mutations,
  onMutated,
  loading = false,
}: {
  drifts: ResourceState<ConfigDriftRecord[]> | undefined;
  plans: ResourceState<ConfigPlanRecord[]> | undefined;
  snapshots: ResourceState<ConfigSnapshotRecord[]> | undefined;
  agents?: ResourceState<ConfigAgentOption[]> | undefined;
  /** Absent on a read-only render, which is what every existing test does. */
  mutations?: ConfigMutations | undefined;
  onMutated?: (() => void) | undefined;
  loading?: boolean;
}) {
```

Inside the component, beside the existing `useState` calls:

```tsx
const [pendingPlan, setPendingPlan] = useState<ConfigPlanRecord>();
const [busy, setBusy] = useState(false);
const [planOutcome, setPlanOutcome] = useState<Outcome>();
const [driftOutcome, setDriftOutcome] = useState<Outcome>();
const notifyMutated = onMutated ?? (() => undefined);

const confirmApply = () => {
  if (mutations === undefined || pendingPlan === undefined) return;
  const planId = pendingPlan.id;
  setBusy(true);
  void mutations.applyPlanWithApproval(planId).then((result) => {
    setBusy(false);
    setPendingPlan(undefined);
    setPlanOutcome(outcomeOf(result, `Plan ${planId} applied.`));
    if (result.state === 'ok') notifyMutated();
  });
};
```

Render the plan form above the drift panel, only when both a capability and a usable agent list are present:

```tsx
{
  mutations === undefined || agents?.state !== 'ready' || agents.data.length === 0 ? null : (
    <PlanForm agents={agents.data} mutations={mutations} onMutated={notifyMutated} />
  );
}
```

Add the rescan control to the drift panel body, immediately before its existing `bounded-note`:

```tsx
{
  mutations === undefined ? null : (
    <div className="panel-actions">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setDriftOutcome(undefined);
          void mutations.scanDrift().then((result) => {
            setBusy(false);
            setDriftOutcome(outcomeOf(result, 'Drift rescanned.'));
            if (result.state === 'ok') notifyMutated();
          });
        }}
      >
        Rescan drift
      </button>
      <OutcomeLine outcome={driftOutcome} />
    </div>
  );
}
```

In the plans table, add an `Apply` column header after `Detail`, and this cell in each row:

```tsx
<td>
  {mutations === undefined || plan.state !== 'prepared' ? (
    <span className="unavailable">—</span>
  ) : (
    <button type="button" disabled={busy} onClick={() => setPendingPlan(plan)}>
      {`Apply ${plan.id}`}
    </button>
  )}
</td>
```

Render `<OutcomeLine outcome={planOutcome} />` directly after the plans `ResourcePanel`.

In the snapshots table, add a `Roll back` column header and this cell:

```tsx
<td>
  {mutations === undefined ? (
    <span className="unavailable">—</span>
  ) : (
    <button
      type="button"
      disabled={busy}
      aria-label={`Roll back to ${snapshot.id}`}
      onClick={() => {
        setBusy(true);
        void mutations.createRollbackPlan(snapshot.id).then((result) => {
          setBusy(false);
          setPlanOutcome(
            outcomeOf(result, 'Rollback plan prepared. Review its changes, then apply it.'),
          );
          if (result.state === 'ok') notifyMutated();
        });
      }}
    >
      Roll back
    </button>
  )}
</td>
```

Finally, render the dialog at the end of the `route-stack` div:

```tsx
{
  pendingPlan === undefined ? null : (
    <ConfirmDialog
      title={`Apply ${pendingPlan.id}`}
      confirmLabel="Apply"
      busy={busy}
      onConfirm={confirmApply}
      onCancel={() => setPendingPlan(undefined)}
    >
      <p>
        This writes {pendingPlan.changes.length} file
        {pendingPlan.changes.length === 1 ? '' : 's'} belonging to{' '}
        <code>{pendingPlan.agentId}</code>. These are your own agent configuration files.
      </p>
      <ul className="name-list">
        {pendingPlan.changes.map((change, index) => (
          <li key={`${change.path}-${String(index)}`}>
            <code>{change.path}</code> — {change.operation}
            {change.warnings.length === 0
              ? null
              : ` (${String(change.warnings.length)} warning${change.warnings.length === 1 ? '' : 's'})`}
          </li>
        ))}
      </ul>
      <p className="bounded-note">
        A snapshot of what is there now is written first, so this can be rolled back.
      </p>
    </ConfirmDialog>
  );
}
```

Delete the two sentences in the file's header comment and in the drift and plan `bounded-note` text that say nothing here can apply, approve or rescan — they are no longer true. Replace the header comment's second paragraph with:

```
 * Plan creation, apply, rollback and rescan are reachable here as of the
 * dashboard-mutation approval recorded in AGENTS.md section 21. Apply is the
 * only one gated by a confirmation, because it is the only one that writes the
 * developer's own configuration files; a plan prepares changes and writes
 * nothing. `reconcile` remains absent.
```

- [ ] **Step 6: Add the control styles**

Append to `apps/dashboard/src/styles/projects.css`:

```css
.plan-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.plan-form__actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.outcome {
  margin: var(--space-2) 0 0;
  font-size: 0.85rem;
}

.outcome--ok {
  color: var(--success);
}

.outcome--bad {
  color: var(--danger);
}
```

- [ ] **Step 7: Run the view tests and both style guards**

Run: `pnpm vitest run apps/dashboard/src/routes/config-view.test.tsx apps/dashboard/src/styles`

Expected: PASS. If `class-coverage.test.ts` reports a missing class, add the rule rather than removing the `className`.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/routes/config-view.tsx apps/dashboard/src/routes/config-view.test.tsx apps/dashboard/src/styles/projects.css
git commit -m "feat: reach the config plan chain from the dashboard behind a confirmation"
```

---

### Task 7: Wiring

Threads the mutation capability from `main.tsx` through `DashboardApp` into `ConfigView`, and refreshes the chain on success.

**Files:**

- Modify: `apps/dashboard/src/app.tsx:155-200` and `:397-403`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/app.test.tsx`

**Interfaces:**

- Consumes: `ConfigMutations` (Task 3), the `ConfigView` props from Task 6.
- Produces: `DashboardApp` gains `configMutations?: ConfigMutations` and `onConfigMutated?: () => void`.

- [ ] **Step 1: Write the failing wiring test**

Append to `apps/dashboard/src/app.test.tsx`:

```tsx
it('passes no mutation capability to the config route by default', () => {
  render(<DashboardApp snapshot={snapshot} websocketState="open" />);
  window.location.hash = '#/config';

  expect(screen.queryByRole('button', { name: /rescan drift/i })).toBeNull();
});
```

Follow whatever route-navigation helper the neighbouring tests in this file already use rather than setting the hash directly if one exists.

- [ ] **Step 2: Thread the props through `DashboardApp`**

In `apps/dashboard/src/app.tsx`, add to the destructured props and to the prop type:

```tsx
  configMutations,
  onConfigMutated,
```

```tsx
  configMutations?: ConfigMutations | undefined;
  onConfigMutated?: (() => void) | undefined;
```

with `import type { ConfigMutations } from './api/config-mutations.js';` beside the other type imports, and pass them at the render site:

```tsx
<ConfigView
  drifts={configResources.drifts}
  plans={configResources.plans}
  snapshots={configResources.snapshots}
  agents={configResources.agents}
  loading={configLoading}
  {...(configMutations === undefined ? {} : { mutations: configMutations })}
  {...(onConfigMutated === undefined ? {} : { onMutated: onConfigMutated })}
/>
```

- [ ] **Step 3: Construct the capability once in `main.tsx` and refresh on success**

In `apps/dashboard/src/main.tsx`, import the factory beside the other `api` imports:

```ts
import { createConfigMutations, type ConfigMutations } from './api/config-mutations.js';
```

Create it once at module scope, next to where the read `client` is created:

```ts
const configMutations: ConfigMutations = createConfigMutations();
```

Add the success refresh callback beside `refreshConfigScope`:

```ts
/**
 * Realtime already invalidates this chain — `configResourcesForEvent` maps
 * `config.applied`, `config.rolled_back` and the drift events — but that path
 * is silent while the socket is disconnected, and a write whose result never
 * appears is worse here than a redundant read.
 */
const onConfigMutated = useCallback(() => {
  refreshConfigScope(configResourceKeys);
}, [refreshConfigScope]);
```

and pass both to `DashboardApp` in the returned element:

```tsx
configMutations = { configMutations };
onConfigMutated = { onConfigMutated };
```

- [ ] **Step 4: Run the dashboard suite**

Run: `pnpm vitest run apps/dashboard/src`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/app.tsx apps/dashboard/src/app.test.tsx apps/dashboard/src/main.tsx
git commit -m "feat: wire the config mutation capability into the dashboard shell"
```

---

### Task 8: Verification and documentation

**Files:**

- Create: `docs/decisions/0021-dashboard-configuration-mutations.md`
- Modify: `AGENTS.md` section 21
- Modify: `CLAUDE.md` "Repository state" table and "Current implementation status"
- Modify: `README.md` "Current status"

- [ ] **Step 1: Run the full definition-of-done sequence**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build`

Expected: every leg passes. Report the actual output. If a leg fails, fix it before continuing — do not proceed to documentation with a red suite.

- [ ] **Step 2: Run the opt-in Redis integration tests**

Use the `/redis-it` skill, which handles the required environment variables and the dedicated test database.

Expected: PASS. Nothing in this plan touches Redis, so a failure here is pre-existing and should be reported as such rather than absorbed.

- [ ] **Step 3: Write ADR 0021**

Use the `/adr` skill to follow the existing convention. It must record: the three decisions and the alternatives rejected for each; that `approved → approved` is not a legal transition and what that costs; that no CORS header or `OPTIONS` handler was added and why; that `reconcile` is deliberately absent; and that `publicErrorResponseSchema` moved to a leaf module for the same reason `stream-id.ts` exists.

- [ ] **Step 4: Update `AGENTS.md` section 21**

Replace the `### Approved, not started: dashboard mutations` subsection with what is now true: the configuration plan chain is built, the three decisions are settled and recorded in ADR 0021, and the remaining prohibitions stand unchanged. Keep the final `**Every other prohibition below still stands.**` paragraph, and add `reconcile` to it.

`AGENTS.md` is in `.prettierignore`, so a scripted rewrite leaves CRLF behind on this machine. Use the editing tools.

- [ ] **Step 5: Update `CLAUDE.md` and `README.md`**

Add the new commit to the `CLAUDE.md` repository-state table once it exists. In "Current implementation status", state that the dashboard is no longer read-only: `#/config` creates, applies and rolls back configuration plans behind a confirmation, and that `reconcile`, optimization accept/reject, graph rebuild and Git mutation remain out of scope. Update `README.md` "Current status" to match.

- [ ] **Step 6: Verify the documentation claims against the code**

Run: `pnpm format`

Then re-read what was written and confirm each claim is true of the code as committed. Per `CLAUDE.md`, do not label planned behaviour as implemented.

- [ ] **Step 7: Commit**

```bash
git add docs/decisions/0021-dashboard-configuration-mutations.md AGENTS.md CLAUDE.md README.md
git commit -m "docs: record ADR 0021 and the dashboard mutation status"
```

---

## Self-Review

**Spec coverage:**

| Spec section                              | Task    |
| ----------------------------------------- | ------- |
| Decision 1, method-aware origin hardening | 1       |
| Decision 2, confirmation before approve   | 5, 6    |
| Decision 3, scope minus `reconcile`       | 3, 6    |
| Daemon method-aware validation            | 1       |
| Protocol browser-safe exports             | 2       |
| Dashboard mutation module                 | 3       |
| Agents read joins the config scope        | 4       |
| Config route controls and dialog          | 5, 6, 7 |
| Guard test rewritten as an allowlist      | 3       |
| Testing, daemon                           | 1       |
| Testing, dashboard                        | 3, 5, 6 |
| Not built: `reconcile`, `inspect`, others | 3, 8    |

**Type consistency:** `MutationResult<T>`, `PlanCreateInput`, `ConfigMutations`, `ConfigAgentOption` and `ConfigPlanRecord` are used in Tasks 3, 4, 6 and 7 under the names Task 3 and Task 4 define. `createConfigMutations` returns the five operations Task 6 calls, and no other.

**Known judgement calls left to the implementer:**

- Task 7 Step 1 depends on how `app.test.tsx` navigates between routes; follow the neighbouring tests rather than the sketch given.
- Task 6 Step 1 assumes `config-view.test.tsx` has a `snapshot` factory. If it does not, add one whose `id` is `snapshot-1`.
