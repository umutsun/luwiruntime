# Per-project graphify knowledge graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `#/knowledge/<projectId>` dashboard view that renders each project's
`graphify-out/graph.json` as a bounded, community-clustered god/hub/symbol graph with an inspector.

**Architecture:** A new bounded daemon read (`GET /api/v1/projects/:projectId/knowledge-graph`) parses
the project's graphify output the same bounded way the ADR 0029 observer does, a pure projection turns
it into a small render model (backbone nodes + edges + communities), and a new dashboard route draws it
with a static community-ring layout. No writes, no `luwi_v1`/Redis/protocol-Redis change.

**Tech Stack:** TypeScript, Zod (`@luwi/protocol`), Fastify (daemon), React + inline SVG (dashboard),
Vitest.

## Global Constraints

- **Read-only.** No graphify execution, no graph mutation (AGENTS.md §12/§18/§21). No new dashboard
  write module — `product-independence.test.ts` must stay green.
- **Bounded.** Real graphify graphs reach ~20k nodes; never return or render them all. Size cap on the
  file read (`MAX_OUTPUT_BYTES = 64 * 1024 * 1024`), node cap on the projection.
- **Loopback-only** (§4). The route is a `GET` read.
- **Node ≥ 22**, pnpm 11.9.0, Memurai (not touched here). Typecheck has two legs: `pnpm --filter
@luwi/dashboard typecheck && tsc -b`. `pnpm test` includes dashboard.
- **Honesty rules (ADR 0032):** where the comp drew a value the runtime cannot know, render the truth
  or drop it — never fabricate. `embeddings` is always `0` (graphify is structural).
- **CSS guards:** every new className in the dashboard must be matched by a rule in a registered
  stylesheet (`class-coverage.test.ts`) and use tokens, not raw pixels/opaque colours in spacing/font
  properties (`tokens.test.ts`).
- Commit only what a task changed. End commit bodies with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

- `packages/protocol/src/intelligence.ts` — add `knowledgeGraphResponseSchema` (+ node/edge/community
  sub-schemas). Modify.
- `packages/protocol/src/browser.ts` — re-export `knowledgeGraphResponseSchema` for the dashboard.
  Modify.
- `packages/protocol/src/index.ts` — export the schema from the leaf module (if not via a barrel).
  Modify.
- `apps/daemon/src/graphify-observer.ts` — export `MAX_OUTPUT_BYTES`. Modify (one line).
- `apps/daemon/src/graphify-knowledge.ts` — NEW. The reader (`readGraphifyKnowledge`) and the pure
  projection (`projectKnowledgeGraph`).
- `apps/daemon/src/graphify-knowledge.test.ts` — NEW. Reader + projection unit tests.
- `apps/daemon/src/app.ts` — register `GET /api/v1/projects/:projectId/knowledge-graph`. Modify.
- `apps/daemon/src/runtime.ts` — wire the reader + project lookup into the route dependencies. Modify.
- `apps/daemon/src/app-phase1.test.ts` — inject test for the route (project with output, without, 404).
  Modify.
- `apps/dashboard/src/routing.ts` — add the `knowledge` route (parse + href). Modify.
- `apps/dashboard/src/routing.test.ts` — route tests. Modify.
- `apps/dashboard/src/api/knowledge-scope.ts` — NEW. `loadKnowledgeScope` fetches the endpoint.
- `apps/dashboard/src/knowledge/model.ts` — NEW. `layoutKnowledge` + `knowledgePanel` (pure).
- `apps/dashboard/src/knowledge/model.test.ts` — NEW. Model tests.
- `apps/dashboard/src/knowledge/knowledge-view.tsx` — NEW. The view (canvas + stat strip + inspector).
- `apps/dashboard/src/knowledge/knowledge-view.test.tsx` — NEW. Render tests (empty state, selection).
- `apps/dashboard/src/styles/knowledge.css` — NEW. View styles (registered with the guards).
- `apps/dashboard/src/bootstrap.ts` — add `needsKnowledgeOf`, `selectedKnowledgeProjectOf`. Modify.
- `apps/dashboard/src/bootstrap.test.ts` — tests for the new selectors. Modify.
- `apps/dashboard/src/main.tsx` — load the knowledge scope while `#/knowledge` is open. Modify.
- `apps/dashboard/src/app.tsx` — render `KnowledgeView` for the route; add the overview drill-down link
  - Ctrl-K entry. Modify.

---

## Task 1: Protocol — `knowledgeGraphResponseSchema`

**Files:**

- Modify: `packages/protocol/src/intelligence.ts` (after `graphEdgeKindCountSchema`, ~line 702)
- Modify: `packages/protocol/src/browser.ts` (add to the intelligence re-export block)
- Test: `packages/protocol/src/intelligence.test.ts`

**Interfaces:**

- Produces: `knowledgeGraphResponseSchema` and `KnowledgeGraphResponse` = `z.infer<...>` with shape:
  `{ summary: { nodeCount, edgeCount, communityCount, hubCount, embeddings, builtAtCommit?, observedAt?, truncated }, communities: { id, name, size }[], nodes: { id, label, sourceFile, community?, communityName?, kind, degree }[], edges: { source, target, kind }[] }` where `kind` on a
  node is `'god' | 'hub' | 'symbol'` and on an edge is `'import' | 'call'`.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/intelligence.test.ts`:

```ts
import { knowledgeGraphResponseSchema } from './intelligence.js';

describe('knowledgeGraphResponseSchema', () => {
  it('accepts a bounded knowledge graph and rejects an unknown node kind', () => {
    const valid = {
      summary: {
        nodeCount: 120,
        edgeCount: 340,
        communityCount: 7,
        hubCount: 9,
        embeddings: 0,
        builtAtCommit: 'abc123',
        observedAt: '2026-09-15T09:00:00.000Z',
        truncated: true,
      },
      communities: [{ id: 0, name: 'graph', size: 40 }],
      nodes: [
        {
          id: 'src/graph/builder.ts::build',
          label: 'build',
          sourceFile: 'src/graph/builder.ts',
          community: 0,
          communityName: 'graph',
          kind: 'god',
          degree: 12,
        },
      ],
      edges: [{ source: 'a', target: 'b', kind: 'import' }],
    };
    expect(knowledgeGraphResponseSchema.parse(valid)).toEqual(valid);
    expect(
      knowledgeGraphResponseSchema.safeParse({
        ...valid,
        nodes: [{ ...valid.nodes[0], kind: 'planet' }],
      }).success,
    ).toBe(false);
  });

  it('accepts the empty projection a project without graphify output returns', () => {
    const empty = {
      summary: {
        nodeCount: 0,
        edgeCount: 0,
        communityCount: 0,
        hubCount: 0,
        embeddings: 0,
        truncated: false,
      },
      communities: [],
      nodes: [],
      edges: [],
    };
    expect(knowledgeGraphResponseSchema.parse(empty)).toEqual(empty);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/protocol/src/intelligence.test.ts -t knowledgeGraph`
Expected: FAIL — `knowledgeGraphResponseSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `packages/protocol/src/intelligence.ts`, after `graphEdgeKindCountSchema` (~line 702). The bounds
mirror the existing graph limits (`GRAPH_MAX_SUBGRAPH_NODE_LIMIT` is already defined above in this
file):

```ts
export const knowledgeNodeKindSchema = z.enum(['god', 'hub', 'symbol']);
export const knowledgeEdgeKindSchema = z.enum(['import', 'call']);

export const knowledgeGraphNodeSchema = z.strictObject({
  id: z.string().min(1).max(1024),
  label: z.string().min(1).max(256),
  sourceFile: z.string().min(1).max(4096),
  community: z.number().int().optional(),
  communityName: z.string().max(4096).optional(),
  kind: knowledgeNodeKindSchema,
  degree: z.number().int().nonnegative(),
});
export const knowledgeGraphEdgeSchema = z.strictObject({
  source: z.string().min(1).max(1024),
  target: z.string().min(1).max(1024),
  kind: knowledgeEdgeKindSchema,
});
export const knowledgeCommunitySchema = z.strictObject({
  id: z.number().int(),
  name: z.string().min(1).max(4096),
  size: z.number().int().nonnegative(),
});
export const knowledgeGraphSummarySchema = z.strictObject({
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  communityCount: z.number().int().nonnegative(),
  hubCount: z.number().int().nonnegative(),
  /** Always 0 — graphify is structural, no embeddings. Kept explicit so the stat is not fabricated. */
  embeddings: z.literal(0),
  builtAtCommit: z.string().min(1).max(256).optional(),
  /** Absent only for the empty projection of a project with no graphify output. */
  observedAt: timestampSchema.optional(),
  truncated: z.boolean(),
});
export const knowledgeGraphResponseSchema = z.strictObject({
  summary: knowledgeGraphSummarySchema,
  communities: z.array(knowledgeCommunitySchema).max(64),
  nodes: z.array(knowledgeGraphNodeSchema).max(GRAPH_MAX_SUBGRAPH_NODE_LIMIT),
  edges: z.array(knowledgeGraphEdgeSchema).max(GRAPH_MAX_SUBGRAPH_NODE_LIMIT * 4),
});
export type KnowledgeGraphResponse = z.infer<typeof knowledgeGraphResponseSchema>;
```

Confirm `timestampSchema` and `GRAPH_MAX_SUBGRAPH_NODE_LIMIT` are already imported/defined in this file
(they are — the existing graph schemas use both). If `GRAPH_MAX_SUBGRAPH_NODE_LIMIT` is not in scope
here, use `2000` literally with a comment.

- [ ] **Step 4: Export from the browser barrel**

In `packages/protocol/src/browser.ts`, add `knowledgeGraphResponseSchema` to the block that re-exports
from `./intelligence.js` (search for another intelligence schema like `graphSummarySchema`; if the
browser barrel does not already re-export intelligence schemas, add a new `export { ... } from
'./intelligence.js';` line). Confirm `index.ts` already surfaces intelligence exports (it does via
`export * from './intelligence.js'` or an explicit list — match the existing pattern).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/protocol/src/intelligence.test.ts`
Expected: PASS.
Run: `pnpm exec tsc -b --pretty false`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/intelligence.ts packages/protocol/src/browser.ts packages/protocol/src/intelligence.test.ts
git commit -m "feat(protocol): knowledge graph response schema"
```

---

## Task 2: Daemon — graphify knowledge reader

**Files:**

- Modify: `apps/daemon/src/graphify-observer.ts` (export `MAX_OUTPUT_BYTES`)
- Create: `apps/daemon/src/graphify-knowledge.ts`
- Test: `apps/daemon/src/graphify-knowledge.test.ts`

**Interfaces:**

- Consumes: `GRAPHIFY_OUTPUT_RELATIVE_PATH`, `MAX_OUTPUT_BYTES` from `./graphify-observer.js`.
- Produces:
  `KnowledgeDocument = { nodes: { id: string; sourceFile: string; community?: number; communityName?: string }[]; links: { source: string; target: string; relation: string }[]; builtAtCommit?: string; observedAt: string }`
  and `readGraphifyKnowledge(input: { localPath: string; maximumFileBytes?: number }): Promise<KnowledgeDocument | null>`. Returns `null` when the project has no `graphify-out/graph.json`; throws
  `GraphifyObserverError` on oversized/invalid (reuse the exported class).

- [ ] **Step 1: Export the size cap**

In `apps/daemon/src/graphify-observer.ts` change `const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;` to
`export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;`.

- [ ] **Step 2: Write the failing test**

Create `apps/daemon/src/graphify-knowledge.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GraphifyObserverError } from './graphify-observer.js';
import { readGraphifyKnowledge } from './graphify-knowledge.js';

async function projectWith(graphJson: string | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'luwi-knowledge-'));
  if (graphJson !== undefined) {
    await mkdir(join(root, 'graphify-out'), { recursive: true });
    await writeFile(join(root, 'graphify-out', 'graph.json'), graphJson);
  }
  return root;
}

describe('readGraphifyKnowledge', () => {
  it('returns null when the project has no graphify output', async () => {
    const root = await projectWith(undefined);
    try {
      expect(await readGraphifyKnowledge({ localPath: root })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads nodes, links and provenance from graph.json', async () => {
    const root = await projectWith(
      JSON.stringify({
        built_at_commit: 'abc123',
        nodes: [
          { id: 'a::build', source_file: 'src/a.ts', community: 0, community_name: 'a' },
          { id: 'b::run', source_file: 'src/b.ts', community: 1 },
        ],
        links: [{ source: 'a::build', target: 'b::run', relation: 'imports' }],
      }),
    );
    try {
      const doc = await readGraphifyKnowledge({ localPath: root });
      expect(doc?.nodes).toHaveLength(2);
      expect(doc?.nodes[0]).toMatchObject({
        id: 'a::build',
        sourceFile: 'src/a.ts',
        community: 0,
        communityName: 'a',
      });
      expect(doc?.links[0]).toEqual({ source: 'a::build', target: 'b::run', relation: 'imports' });
      expect(doc?.builtAtCommit).toBe('abc123');
      expect(typeof doc?.observedAt).toBe('string');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws GRAPHIFY_OUTPUT_TOO_LARGE past the cap', async () => {
    const root = await projectWith(JSON.stringify({ nodes: [], links: [] }));
    try {
      await expect(
        readGraphifyKnowledge({ localPath: root, maximumFileBytes: 4 }),
      ).rejects.toBeInstanceOf(GraphifyObserverError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run apps/daemon/src/graphify-knowledge.test.ts`
Expected: FAIL — module `./graphify-knowledge.js` not found.

- [ ] **Step 4: Write the reader**

Create `apps/daemon/src/graphify-knowledge.ts` (reader only for now — the projection is Task 3):

```ts
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import {
  GRAPHIFY_OUTPUT_RELATIVE_PATH,
  GraphifyObserverError,
  MAX_OUTPUT_BYTES,
} from './graphify-observer.js';

/**
 * Reads graphify's own knowledge structure (symbols, communities, typed edges)
 * from `graphify-out/graph.json`, bounded the same way the ADR 0029 observer
 * reads it. Unlike the observer it does not collapse symbols into files — the
 * per-project knowledge view needs the raw structure. It never runs graphify and
 * never follows anything inside the file (§12, §18).
 */

const nodeSchema = z.looseObject({
  id: z.string().min(1).max(1024),
  source_file: z.string().min(1).max(4096),
  community: z.number().int().optional(),
  community_name: z.string().max(4096).optional(),
});
const linkSchema = z.looseObject({
  source: z.string().min(1).max(1024),
  target: z.string().min(1).max(1024),
  relation: z.string().min(1).max(64),
});
const documentSchema = z.looseObject({
  nodes: z.array(z.unknown()),
  links: z.array(z.unknown()),
  built_at_commit: z.unknown().optional(),
});

export type KnowledgeDocument = {
  nodes: { id: string; sourceFile: string; community?: number; communityName?: string }[];
  links: { source: string; target: string; relation: string }[];
  builtAtCommit?: string;
  observedAt: string;
};

export async function readGraphifyKnowledge(input: {
  localPath: string;
  maximumFileBytes?: number;
}): Promise<KnowledgeDocument | null> {
  const maximumFileBytes = input.maximumFileBytes ?? MAX_OUTPUT_BYTES;
  let root: string;
  try {
    root = await realpath(resolve(input.localPath));
  } catch {
    return null;
  }
  const outputPath = resolve(root, GRAPHIFY_OUTPUT_RELATIVE_PATH);
  let output;
  try {
    output = await stat(outputPath);
  } catch {
    return null;
  }
  if (!output.isFile()) return null;
  if (Number(output.size) > maximumFileBytes) {
    throw new GraphifyObserverError(
      'GRAPHIFY_OUTPUT_TOO_LARGE',
      'The graphify output exceeds the bounded document size.',
    );
  }
  let document: z.infer<typeof documentSchema>;
  try {
    document = documentSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
  } catch {
    throw new GraphifyObserverError(
      'GRAPHIFY_OUTPUT_INVALID',
      'The graphify output could not be read as a graph document.',
    );
  }

  const nodes: KnowledgeDocument['nodes'] = [];
  for (const raw of document.nodes) {
    const parsed = nodeSchema.safeParse(raw);
    if (!parsed.success) continue; // skip a malformed node rather than fail the whole read
    nodes.push({
      id: parsed.data.id,
      sourceFile: parsed.data.source_file,
      ...(parsed.data.community === undefined ? {} : { community: parsed.data.community }),
      ...(parsed.data.community_name === undefined
        ? {}
        : { communityName: parsed.data.community_name }),
    });
  }
  const links: KnowledgeDocument['links'] = [];
  for (const raw of document.links) {
    const parsed = linkSchema.safeParse(raw);
    if (!parsed.success) continue;
    links.push({
      source: parsed.data.source,
      target: parsed.data.target,
      relation: parsed.data.relation,
    });
  }
  return {
    nodes,
    links,
    ...(typeof document.built_at_commit === 'string'
      ? { builtAtCommit: document.built_at_commit }
      : {}),
    observedAt: output.mtime.toISOString(),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/daemon/src/graphify-knowledge.test.ts`
Expected: PASS.
Run: `pnpm exec vitest run apps/daemon/src/graphify-observer.test.ts` (guard the one-line export change)
Expected: PASS (unchanged behaviour).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/graphify-observer.ts apps/daemon/src/graphify-knowledge.ts apps/daemon/src/graphify-knowledge.test.ts
git commit -m "feat(daemon): bounded graphify knowledge reader"
```

---

## Task 3: Daemon — bounded projection `projectKnowledgeGraph`

**Files:**

- Modify: `apps/daemon/src/graphify-knowledge.ts` (add the projection)
- Test: `apps/daemon/src/graphify-knowledge.test.ts` (add a `projectKnowledgeGraph` describe)

**Interfaces:**

- Consumes: `KnowledgeDocument` (Task 2), `KnowledgeGraphResponse` (Task 1, imported from `@luwi/protocol`).
- Produces: `projectKnowledgeGraph(document: KnowledgeDocument | null, options?: { godNodeCount?: number; maxRenderNodes?: number; maxCommunities?: number }): KnowledgeGraphResponse`. A `null`
  document yields the empty projection (all counts 0, empty arrays, no `observedAt`).

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/graphify-knowledge.test.ts`:

```ts
import { projectKnowledgeGraph } from './graphify-knowledge.js';
import type { KnowledgeDocument } from './graphify-knowledge.js';

describe('projectKnowledgeGraph', () => {
  it('projects the empty response for a project with no output', () => {
    const out = projectKnowledgeGraph(null);
    expect(out.summary).toMatchObject({
      nodeCount: 0,
      edgeCount: 0,
      embeddings: 0,
      truncated: false,
    });
    expect(out.summary.observedAt).toBeUndefined();
    expect(out.nodes).toEqual([]);
  });

  it('derives kind by degree, bounds the backbone, and keeps only in-set edges', () => {
    // hub0 is imported by 4 leaves; hub1 by 1; god is the most-connected overall.
    const nodes: KnowledgeDocument['nodes'] = [
      { id: 'core::god', sourceFile: 'src/core.ts', community: 0, communityName: 'core' },
      { id: 'a::hub', sourceFile: 'src/a.ts', community: 1, communityName: 'a' },
      { id: 'a::l1', sourceFile: 'src/a1.ts', community: 1 },
      { id: 'a::l2', sourceFile: 'src/a2.ts', community: 1 },
      { id: 'a::l3', sourceFile: 'src/a3.ts', community: 1 },
      { id: 'b::hub', sourceFile: 'src/b.ts', community: 2, communityName: 'b' },
    ];
    const links: KnowledgeDocument['links'] = [
      { source: 'a::l1', target: 'a::hub', relation: 'imports' },
      { source: 'a::l2', target: 'a::hub', relation: 'imports' },
      { source: 'a::l3', target: 'a::hub', relation: 'imports' },
      { source: 'a::hub', target: 'core::god', relation: 'imports' },
      { source: 'b::hub', target: 'core::god', relation: 'calls' },
      { source: 'core::god', target: 'a::l1', relation: 'imports' },
    ];
    const out = projectKnowledgeGraph(
      { nodes, links, builtAtCommit: 'c1', observedAt: '2026-09-15T00:00:00.000Z' },
      { godNodeCount: 1, maxRenderNodes: 4, maxCommunities: 12 },
    );
    expect(out.summary.nodeCount).toBe(6);
    expect(out.summary.edgeCount).toBe(6);
    expect(out.summary.communityCount).toBe(3);
    expect(out.summary.builtAtCommit).toBe('c1');
    // The highest-degree node overall is the god; per-community highest are hubs.
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('core::god')?.kind).toBe('god');
    expect(byId.get('a::hub')?.kind).toBe('hub');
    // maxRenderNodes=4 keeps god + 3 hubs/backbone; a leaf is dropped → truncated.
    expect(out.nodes.length).toBeLessThanOrEqual(4);
    expect(out.summary.truncated).toBe(true);
    // Every returned edge has both endpoints in the returned node set.
    const ids = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    }
    // relation classification
    expect(out.edges.every((e) => e.kind === 'import' || e.kind === 'call')).toBe(true);
    // label is the id's terminal segment
    expect(byId.get('a::hub')?.label).toBe('hub');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/daemon/src/graphify-knowledge.test.ts -t projectKnowledgeGraph`
Expected: FAIL — `projectKnowledgeGraph` not exported.

- [ ] **Step 3: Write the projection**

Append to `apps/daemon/src/graphify-knowledge.ts`:

```ts
import type { KnowledgeGraphResponse } from '@luwi/protocol';

/** Relations graphify treats as an import edge; everything else is a call. Mirrors ADR 0029. */
const IMPORT_RELATIONS = new Set(['imports', 'imports_from', 're_exports', 'dynamic_import']);
const DEFAULT_GOD_NODE_COUNT = 6;
const DEFAULT_MAX_RENDER_NODES = 40;
const DEFAULT_MAX_COMMUNITIES = 12;

/** The id's terminal segment: graphify ids are path-like (`a/b::symbol`). */
function labelOf(id: string): string {
  const tail = id.split(/[/:]/u).filter((part) => part !== '');
  return tail[tail.length - 1] ?? id;
}

const EMPTY: KnowledgeGraphResponse = {
  summary: {
    nodeCount: 0,
    edgeCount: 0,
    communityCount: 0,
    hubCount: 0,
    embeddings: 0,
    truncated: false,
  },
  communities: [],
  nodes: [],
  edges: [],
};

export function projectKnowledgeGraph(
  document: KnowledgeDocument | null,
  options: { godNodeCount?: number; maxRenderNodes?: number; maxCommunities?: number } = {},
): KnowledgeGraphResponse {
  if (document === null) return EMPTY;
  const godNodeCount = options.godNodeCount ?? DEFAULT_GOD_NODE_COUNT;
  const maxRenderNodes = options.maxRenderNodes ?? DEFAULT_MAX_RENDER_NODES;
  const maxCommunities = options.maxCommunities ?? DEFAULT_MAX_COMMUNITIES;

  const byId = new Map(document.nodes.map((node) => [node.id, node]));

  // Undirected degree from links whose endpoints are both known nodes.
  const degree = new Map<string, number>();
  for (const node of document.nodes) degree.set(node.id, 0);
  for (const link of document.links) {
    if (byId.has(link.source)) degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    if (byId.has(link.target)) degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  const sortedByDegree = [...document.nodes].sort(
    (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );

  // God = the top-degree nodes overall.
  const godIds = new Set(sortedByDegree.slice(0, godNodeCount).map((node) => node.id));
  // Hub = the highest-degree node in each community not already a god.
  const hubIds = new Set<string>();
  const seenCommunity = new Set<number>();
  for (const node of sortedByDegree) {
    if (godIds.has(node.id) || node.community === undefined) continue;
    if (seenCommunity.has(node.community)) continue;
    seenCommunity.add(node.community);
    hubIds.add(node.id);
  }

  const kindOf = (id: string): 'god' | 'hub' | 'symbol' =>
    godIds.has(id) ? 'god' : hubIds.has(id) ? 'hub' : 'symbol';

  // Backbone: all god + hub, then the next-highest-degree symbols up to the cap.
  const kept: typeof document.nodes = [];
  const keptIds = new Set<string>();
  const add = (node: (typeof document.nodes)[number]) => {
    if (keptIds.has(node.id) || kept.length >= maxRenderNodes) return;
    kept.push(node);
    keptIds.add(node.id);
  };
  for (const node of sortedByDegree) if (kindOf(node.id) !== 'symbol') add(node);
  for (const node of sortedByDegree) add(node);

  const nodes = kept.map((node) => ({
    id: node.id,
    label: labelOf(node.id),
    sourceFile: node.sourceFile,
    ...(node.community === undefined ? {} : { community: node.community }),
    ...(node.communityName === undefined ? {} : { communityName: node.communityName }),
    kind: kindOf(node.id),
    degree: degree.get(node.id) ?? 0,
  }));

  const edges = document.links
    .filter((link) => keptIds.has(link.source) && keptIds.has(link.target))
    .map((link) => ({
      source: link.source,
      target: link.target,
      kind: IMPORT_RELATIONS.has(link.relation) ? ('import' as const) : ('call' as const),
    }));

  // Communities over the whole document, largest first, bounded.
  const communityAgg = new Map<number, { id: number; name: string; size: number }>();
  for (const node of document.nodes) {
    if (node.community === undefined) continue;
    const existing = communityAgg.get(node.community) ?? {
      id: node.community,
      name: node.communityName ?? `community ${String(node.community)}`,
      size: 0,
    };
    existing.size += 1;
    if (node.communityName !== undefined) existing.name = node.communityName;
    communityAgg.set(node.community, existing);
  }
  const communities = [...communityAgg.values()]
    .sort((a, b) => b.size - a.size || a.id - b.id)
    .slice(0, maxCommunities);

  return {
    summary: {
      nodeCount: document.nodes.length,
      edgeCount: document.links.length,
      communityCount: communityAgg.size,
      hubCount: godIds.size + hubIds.size,
      embeddings: 0,
      ...(document.builtAtCommit === undefined ? {} : { builtAtCommit: document.builtAtCommit }),
      observedAt: document.observedAt,
      truncated: kept.length < document.nodes.length,
    },
    communities,
    nodes,
    edges,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/daemon/src/graphify-knowledge.test.ts`
Expected: PASS.
Run: `pnpm exec tsc -b --pretty false`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/graphify-knowledge.ts apps/daemon/src/graphify-knowledge.test.ts
git commit -m "feat(daemon): bounded knowledge-graph projection"
```

---

## Task 4: Daemon — the route

**Files:**

- Modify: `apps/daemon/src/runtime.ts` (build the read dependency and pass it to `createApp`)
- Modify: `apps/daemon/src/app.ts` (register `GET /api/v1/projects/:projectId/knowledge-graph`)
- Test: `apps/daemon/src/app-phase1.test.ts`

**Interfaces:**

- Consumes: `readGraphifyKnowledge`, `projectKnowledgeGraph` (Tasks 2–3), `knowledgeGraphResponseSchema`
  (Task 1), the project lookup already available to `createApp` (the `projectService`/`intelligence`
  used by the existing `/api/v1/projects/:projectId/git` route — reuse the same resolution).
- Produces: `GET /api/v1/projects/:projectId/knowledge-graph` → `knowledgeGraphResponseSchema`.

The route needs the project's `canonicalPath`. The existing `getProject`/project resolution the git
routes use resolves it; the reader is filesystem I/O, so inject it as a `createApp` option
`readKnowledgeGraph: (localPath: string) => Promise<KnowledgeDocument | null>` (defaulting to
`readGraphifyKnowledge`) so the inject test can stub it without touching disk. Follow how `createApp`
already receives injected collaborators.

- [ ] **Step 1: Write the failing test**

Add to `apps/daemon/src/app-phase1.test.ts` (this file holds the project-route inject precedents). Use
the file's existing app-building helper; stub `readKnowledgeGraph` to return a fixed document for a
known project id and `null` for another, and register both projects the way the helper already does.

```ts
it('serves a project knowledge graph, empty when there is no output, 404 for an unknown project', async () => {
  const app = await buildTestApp({
    // the helper's existing project fixtures include a project with id 'project-1';
    readKnowledgeGraph: async (localPath: string) =>
      localPath.includes('project-1')
        ? {
            nodes: [{ id: 'a::b', sourceFile: 'src/a.ts', community: 0, communityName: 'a' }],
            links: [],
            builtAtCommit: 'c1',
            observedAt: '2026-09-15T00:00:00.000Z',
          }
        : null,
  });

  const ok = await app.inject({ method: 'GET', url: '/api/v1/projects/project-1/knowledge-graph' });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().summary.nodeCount).toBe(1);
  expect(ok.json().nodes[0].kind).toBe('god');

  const empty = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/project-2/knowledge-graph',
  });
  expect(empty.statusCode).toBe(200);
  expect(empty.json().summary.nodeCount).toBe(0);

  const missing = await app.inject({
    method: 'GET',
    url: '/api/v1/projects/does-not-exist/knowledge-graph',
  });
  expect(missing.statusCode).toBe(404);

  await app.close();
});
```

Match `buildTestApp`/fixture names to what `app-phase1.test.ts` already uses (read the top of that
file first; if the helper is named differently, adapt the call and pass `readKnowledgeGraph` through
its options object).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/daemon/src/app-phase1.test.ts -t "knowledge graph"`
Expected: FAIL — route returns 404/500 or the option is unknown.

- [ ] **Step 3: Thread the dependency through `createApp`**

In `apps/daemon/src/app.ts`, add to the `createApp` options type (near the other injected reads):

```ts
readKnowledgeGraph?: (localPath: string) => Promise<KnowledgeDocument | null>;
```

Import at the top of `app.ts`:

```ts
import {
  projectKnowledgeGraph,
  readGraphifyKnowledge,
  type KnowledgeDocument,
} from './graphify-knowledge.js';
import { knowledgeGraphResponseSchema } from '@luwi/protocol';
```

Register the route beside the other `/api/v1/projects/:projectId/*` reads (after the git block, ~line
718). Resolve the project the same way the git routes do — find the exact call used there (e.g.
`intelligence.getProject(projectId)` or `projectService.get(projectId)`); if it returns
null/undefined, reply 404. Then read + project:

```ts
app.get('/api/v1/projects/:projectId/knowledge-graph', async (request, reply) => {
  const { projectId } = parseRequestInput(projectParamsSchema, request.params);
  const project = await projectService.get(projectId); // match the git routes' resolver
  if (project === null || project === undefined) {
    return reply.code(404).send({ code: 'PROJECT_NOT_FOUND', message: 'Unknown project.' });
  }
  const read =
    options.readKnowledgeGraph ?? ((localPath: string) => readGraphifyKnowledge({ localPath }));
  const document = await read(project.canonicalPath);
  return knowledgeGraphResponseSchema.parse(projectKnowledgeGraph(document));
});
```

Notes for the implementer:

- Use the **same project resolver and 404 shape** the neighbouring project routes use — read lines
  460–540 of `app.ts` and copy that exact idiom rather than inventing one. `projectService`/`getProject`
  is already in `createApp`'s closure; do not add a new dependency for the lookup, only for the read.
- A `GRAPHIFY_OUTPUT_TOO_LARGE`/`_INVALID` throw propagates to Fastify's error handler and becomes a
  500 naming the code (ADR 0015) — no special handling needed; do not swallow it into an empty graph.

- [ ] **Step 4: Default-wire in `runtime.ts`**

In `apps/daemon/src/runtime.ts`, where `createApp({...})` is called, no change is required if the
option defaults to `readGraphifyKnowledge` inside the route. If `createApp` forbids unknown/absent
options, pass `readKnowledgeGraph: (localPath) => readGraphifyKnowledge({ localPath })` explicitly and
add the import. Prefer the default (no runtime.ts change) to keep the diff minimal.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/daemon/src/app-phase1.test.ts`
Expected: PASS.
Run: `pnpm exec tsc -b --pretty false`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/app.ts apps/daemon/src/runtime.ts apps/daemon/src/app-phase1.test.ts
git commit -m "feat(daemon): project knowledge-graph route"
```

---

## Task 5: Dashboard — the `knowledge` route

**Files:**

- Modify: `apps/dashboard/src/routing.ts`
- Test: `apps/dashboard/src/routing.test.ts`

**Interfaces:**

- Produces: a `DashboardRoute` variant `{ name: 'knowledge'; projectId?: string }`; `parseRoute` maps
  `#/knowledge/<id>` and `#/knowledge`; `routeHref` renders both.

- [ ] **Step 1: Write the failing test**

Add to `apps/dashboard/src/routing.test.ts`:

```ts
it('parses and builds the knowledge route with and without a project id', () => {
  expect(parseRoute('#/knowledge/p1')).toEqual({ name: 'knowledge', projectId: 'p1' });
  expect(parseRoute('#/knowledge')).toEqual({ name: 'knowledge' });
  expect(parseRoute('#/knowledge/')).toEqual({ name: 'knowledge' });
  expect(routeHref({ name: 'knowledge', projectId: 'p1' })).toBe('#/knowledge/p1');
  expect(routeHref({ name: 'knowledge' })).toBe('#/knowledge');
  // an id containing a slash is encoded, not forged into a segment
  expect(routeHref({ name: 'knowledge', projectId: 'a/b' })).toBe('#/knowledge/a%2Fb');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run apps/dashboard/src/routing.test.ts -t knowledge`
Expected: FAIL.

- [ ] **Step 3: Add the route**

In `apps/dashboard/src/routing.ts`:

Add the variant to `DashboardRoute`:

```ts
| { name: 'knowledge'; projectId?: string }
```

In `parseRoute`, before the final `return { name: 'pulse' };`, add (mirrors the `pulse` project
handling):

```ts
if (head === 'knowledge') {
  if (second === undefined) return { name: 'knowledge' };
  const projectId = decodeSegment(second).trim();
  return projectId !== '' && projectId.length <= MAX_IDENTIFIER_LENGTH
    ? { name: 'knowledge', projectId }
    : { name: 'knowledge' };
}
```

In `routeHref`, before the final `return \`#/${route.name}\`;`, add:

```ts
if (route.name === 'knowledge') {
  return route.projectId === undefined
    ? '#/knowledge'
    : `#/knowledge/${encodeURIComponent(route.projectId)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/dashboard/src/routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/routing.ts apps/dashboard/src/routing.test.ts
git commit -m "feat(dashboard): #/knowledge route"
```

---

## Task 6: Dashboard — scope loader + shell wiring

**Files:**

- Create: `apps/dashboard/src/api/knowledge-scope.ts`
- Modify: `apps/dashboard/src/bootstrap.ts` + `apps/dashboard/src/bootstrap.test.ts`
- Modify: `apps/dashboard/src/main.tsx`
- Modify: `apps/dashboard/src/app.tsx` (pass the resource + a placeholder render; full view in Task 8)

**Interfaces:**

- Produces: `loadKnowledgeScope(client, projectId, { signal }) => Promise<ResourceState<KnowledgeGraphResponse>>`; `needsKnowledgeOf(hash) => boolean`;
  `selectedKnowledgeProjectOf(hash) => string | undefined`.

- [ ] **Step 1: Write the failing tests (selectors)**

Add to `apps/dashboard/src/bootstrap.test.ts`:

```ts
import { needsKnowledgeOf, selectedKnowledgeProjectOf } from './bootstrap.js';

describe('knowledge scope selectors', () => {
  it('loads only on #/knowledge with a project', () => {
    expect(needsKnowledgeOf('#/knowledge/p1')).toBe(true);
    expect(selectedKnowledgeProjectOf('#/knowledge/p1')).toBe('p1');
    expect(needsKnowledgeOf('#/knowledge')).toBe(false); // no project → nothing to load
    expect(selectedKnowledgeProjectOf('#/knowledge')).toBeUndefined();
    for (const route of ['#/pulse', '#/graph', '#/messages']) {
      expect(needsKnowledgeOf(route), route).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/dashboard/src/bootstrap.test.ts -t knowledge`
Expected: FAIL.

- [ ] **Step 3: Add the selectors**

In `apps/dashboard/src/bootstrap.ts`:

```ts
/** The overview never pays for it; the knowledge graph loads only while its own route is open. */
export function needsKnowledgeOf(hash: string): boolean {
  return selectedKnowledgeProjectOf(hash) !== undefined;
}

export function selectedKnowledgeProjectOf(hash: string): string | undefined {
  const route = parseRoute(hash);
  return route.name === 'knowledge' ? route.projectId : undefined;
}
```

- [ ] **Step 4: Add the scope loader**

Create `apps/dashboard/src/api/knowledge-scope.ts`:

```ts
import { knowledgeGraphResponseSchema } from '@luwi/protocol/browser';
import type { z } from 'zod';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

export type KnowledgeGraph = z.infer<typeof knowledgeGraphResponseSchema>;

/**
 * The per-project graphify knowledge graph, read-only, loaded only while
 * `#/knowledge/<projectId>` is open — the overview never pays for it.
 */
export async function loadKnowledgeScope(
  client: DaemonClient,
  projectId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResourceState<KnowledgeGraph>> {
  const get = options.signal === undefined ? {} : { signal: options.signal };
  return client.get(
    `/api/v1/projects/${encodeURIComponent(projectId)}/knowledge-graph`,
    knowledgeGraphResponseSchema,
    get,
  );
}
```

Confirm `client.get(path, schema, options)` matches the signature the other scope loaders use (e.g.
`api/messages-scope.ts`); adapt if the client returns a `ResourceState` differently.

- [ ] **Step 5: Wire the effect in `main.tsx`**

Follow the exact pattern the message scope uses (state + a `useEffect` keyed on the selected id +
`requestNumber`, aborting on change). Add near the message scope wiring:

```ts
const [knowledgeProjectId, setKnowledgeProjectId] = useState(() =>
  selectedKnowledgeProjectOf(window.location.hash),
);
const [knowledge, setKnowledge] = useState<ResourceState<KnowledgeGraph>>();
const [knowledgeLoading, setKnowledgeLoading] = useState(false);
```

In the existing `hashchange` handler, add `setKnowledgeProjectId(selectedKnowledgeProjectOf(window.location.hash));`.
Add the effect:

```ts
useEffect(() => {
  if (knowledgeProjectId === undefined) {
    setKnowledge(undefined);
    setKnowledgeLoading(false);
    return undefined;
  }
  const controller = new AbortController();
  setKnowledgeLoading(true);
  setKnowledge(undefined); // clear so a slow load never shows another project's graph
  void loadKnowledgeScope(client, knowledgeProjectId, { signal: controller.signal }).then(
    (next) => {
      if (controller.signal.aborted) return;
      setKnowledge(next);
      setKnowledgeLoading(false);
    },
  );
  return () => controller.abort();
}, [knowledgeProjectId, requestNumber]);
```

Pass `knowledge={knowledge}` and `knowledgeLoading={knowledgeLoading}` to `<DashboardApp .../>`. Import
`loadKnowledgeScope`, `selectedKnowledgeProjectOf`, and the `KnowledgeGraph` type.

A `knowledge.*` realtime event does not exist (graphify writes on its own git hooks), so there is no
refresh wiring — the graph refreshes on manual retry only. Do not add it to `routeRealtimeEvent`.

- [ ] **Step 6: Accept the props in `app.tsx` (placeholder render)**

Add to `DashboardApp`'s props: `knowledge?: ResourceState<KnowledgeGraph>; knowledgeLoading?: boolean;`.
In the route switch, add a branch for `route.name === 'knowledge'` that renders a temporary
`<pre>{JSON.stringify(knowledge)}</pre>` inside the route shell (replaced in Task 8). Add `knowledge`
to the `pageTitles`/titles map (`{ eyebrow: 'Knowledge graph', heading: 'Knowledge graph' }`).

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run apps/dashboard/src/bootstrap.test.ts`
Expected: PASS.
Run: `pnpm --filter @luwi/dashboard typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/api/knowledge-scope.ts apps/dashboard/src/bootstrap.ts apps/dashboard/src/bootstrap.test.ts apps/dashboard/src/main.tsx apps/dashboard/src/app.tsx
git commit -m "feat(dashboard): load the knowledge-graph scope on #/knowledge"
```

---

## Task 7: Dashboard — the pure model (`layoutKnowledge` + `knowledgePanel`)

**Files:**

- Create: `apps/dashboard/src/knowledge/model.ts`
- Test: `apps/dashboard/src/knowledge/model.test.ts`

**Interfaces:**

- Consumes: `KnowledgeGraph` (Task 6).
- Produces:
  `layoutKnowledge(graph: KnowledgeGraph, selectedId?: string): { nodes: LaidNode[]; edges: LaidEdge[]; communityLabels: { x: number; y: number; label: string }[] }` where
  `LaidNode = { id, label, kind, x, y, r, selected, neighbor, dim }` and
  `LaidEdge = { source, target, kind, x1, y1, x2, y2, active }`, on a fixed `1000×680` viewBox; and
  `knowledgePanel(graph, selectedId?): KnowledgePanel` (project summary vs node detail).

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/knowledge/model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import { knowledgePanel, layoutKnowledge } from './model.js';

const graph: KnowledgeGraph = {
  summary: {
    nodeCount: 3,
    edgeCount: 1,
    communityCount: 2,
    hubCount: 2,
    embeddings: 0,
    builtAtCommit: 'c1',
    observedAt: '2026-09-15T00:00:00.000Z',
    truncated: false,
  },
  communities: [
    { id: 0, name: 'graph', size: 2 },
    { id: 1, name: 'api', size: 1 },
  ],
  nodes: [
    {
      id: 'graph::god',
      label: 'god',
      sourceFile: 'src/graph.ts',
      community: 0,
      communityName: 'graph',
      kind: 'god',
      degree: 3,
    },
    {
      id: 'graph::leaf',
      label: 'leaf',
      sourceFile: 'src/leaf.ts',
      community: 0,
      communityName: 'graph',
      kind: 'symbol',
      degree: 1,
    },
    {
      id: 'api::hub',
      label: 'hub',
      sourceFile: 'src/api.ts',
      community: 1,
      communityName: 'api',
      kind: 'hub',
      degree: 2,
    },
  ],
  edges: [{ source: 'graph::god', target: 'api::hub', kind: 'import' }],
};

describe('layoutKnowledge', () => {
  it('places every node inside the viewBox, deterministically', () => {
    const a = layoutKnowledge(graph);
    const b = layoutKnowledge(graph);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    for (const n of a.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(1000);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(680);
    }
    expect(a.nodes.find((n) => n.id === 'graph::god')?.r).toBeGreaterThan(
      a.nodes.find((n) => n.id === 'graph::leaf')!.r,
    );
  });

  it('marks the selected node, its neighbors, and the active edge', () => {
    const laid = layoutKnowledge(graph, 'graph::god');
    expect(laid.nodes.find((n) => n.id === 'graph::god')?.selected).toBe(true);
    expect(laid.nodes.find((n) => n.id === 'api::hub')?.neighbor).toBe(true);
    expect(laid.nodes.find((n) => n.id === 'graph::leaf')?.dim).toBe(true);
    expect(laid.edges[0]?.active).toBe(true);
  });
});

describe('knowledgePanel', () => {
  it('summarizes the project when nothing is selected', () => {
    const panel = knowledgePanel(graph);
    expect(panel.kind).toBe('summary');
    if (panel.kind === 'summary') {
      expect(panel.facts.map((f) => f.k)).toEqual(['Nodes', 'Edges', 'God nodes']);
      expect(panel.communities[0]?.label).toBe('graph');
    }
  });

  it('describes a selected node with its connected edges', () => {
    const panel = knowledgePanel(graph, 'graph::god');
    expect(panel.kind).toBe('node');
    if (panel.kind === 'node') {
      expect(panel.title).toBe('god');
      expect(panel.badge).toBe('GOD');
      expect(panel.rows.some((r) => r.id === 'api::hub')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/dashboard/src/knowledge/model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the model**

Create `apps/dashboard/src/knowledge/model.ts`. Use a deterministic per-id hash for the intra-community
jitter (mirror the overview's radial layout approach — a small FNV hash seeded by node id, no
`Math.random`). Communities are placed on a ring; each community's nodes cluster around its ring point,
god/hub nearer the centre.

```ts
import type { KnowledgeGraph } from '../api/knowledge-scope.js';

const VIEW_W = 1000;
const VIEW_H = 680;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const RING = 235; // community ring radius
const R = { god: 15, hub: 10, symbol: 5.5 } as const;

export type LaidNode = {
  id: string;
  label: string;
  kind: 'god' | 'hub' | 'symbol';
  x: number;
  y: number;
  r: number;
  selected: boolean;
  neighbor: boolean;
  dim: boolean;
};
export type LaidEdge = {
  source: string;
  target: string;
  kind: 'import' | 'call';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  active: boolean;
};

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
/** Deterministic [0,1) from a string. */
function unit(value: string): number {
  return hash(value) / 4294967296;
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function layoutKnowledge(
  graph: KnowledgeGraph,
  selectedId?: string,
): {
  nodes: LaidNode[];
  edges: LaidEdge[];
  communityLabels: { x: number; y: number; label: string }[];
} {
  // Community index → ring angle. Communities present on kept nodes, ordered.
  const communityIds = [
    ...new Set(graph.nodes.map((n) => n.community).filter((c): c is number => c !== undefined)),
  ].sort((a, b) => a - b);
  const angleOf = new Map<number, number>();
  communityIds.forEach((id, i) =>
    angleOf.set(id, (i / Math.max(1, communityIds.length)) * Math.PI * 2),
  );

  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    (adjacency.get(edge.source) ?? adjacency.set(edge.source, new Set()).get(edge.source)!).add(
      edge.target,
    );
    (adjacency.get(edge.target) ?? adjacency.set(edge.target, new Set()).get(edge.target)!).add(
      edge.source,
    );
  }
  const neighbors =
    selectedId === undefined ? undefined : (adjacency.get(selectedId) ?? new Set<string>());

  const pos = new Map<string, { x: number; y: number }>();
  const nodes: LaidNode[] = graph.nodes.map((node) => {
    const base = node.community === undefined ? 0 : (angleOf.get(node.community) ?? 0);
    const cx = CX + RING * Math.cos(base);
    const cy = CY + RING * Math.sin(base);
    // Hubs/gods sit near the community centre; symbols spread on a small ring around it.
    const spread = node.kind === 'symbol' ? 78 : 26;
    const a = unit(node.id) * Math.PI * 2;
    const rad = spread * (0.35 + 0.65 * unit(`${node.id}:r`));
    const x = clamp(cx + rad * Math.cos(a), 24, VIEW_W - 24);
    const y = clamp(cy + rad * Math.sin(a), 24, VIEW_H - 24);
    pos.set(node.id, { x, y });
    const selected = node.id === selectedId;
    const neighbor = neighbors?.has(node.id) ?? false;
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      x,
      y,
      r: R[node.kind] + (selected ? 2 : 0),
      selected,
      neighbor,
      dim: selectedId !== undefined && !selected && !neighbor,
    };
  });

  const edges: LaidEdge[] = graph.edges
    .map((edge) => {
      const a = pos.get(edge.source);
      const b = pos.get(edge.target);
      if (a === undefined || b === undefined) return undefined;
      const active =
        selectedId !== undefined && (edge.source === selectedId || edge.target === selectedId);
      return {
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        active,
      };
    })
    .filter((edge): edge is LaidEdge => edge !== undefined);

  const communityLabels = communityIds.map((id) => {
    const base = angleOf.get(id) ?? 0;
    const label =
      graph.nodes.find((n) => n.community === id)?.communityName ?? `community ${String(id)}`;
    return { x: CX + RING * Math.cos(base), y: CY + RING * Math.sin(base) - 96, label };
  });

  return { nodes, edges, communityLabels };
}

export type KnowledgePanel =
  | {
      kind: 'summary';
      title: string;
      badge: string;
      sub: string;
      facts: { k: string; v: string }[];
      communities: { label: string; pct: string; n: number }[];
      rows: { id: string; rel: string; title: string; sub: string; meta: string }[];
    }
  | {
      kind: 'node';
      title: string;
      badge: string;
      eyebrow: string;
      sub: string;
      facts: { k: string; v: string }[];
      rows: { id: string; rel: string; title: string; sub: string; meta: string }[];
    };

export function knowledgePanel(graph: KnowledgeGraph, selectedId?: string): KnowledgePanel {
  const selected =
    selectedId === undefined ? undefined : graph.nodes.find((n) => n.id === selectedId);
  if (selected === undefined) {
    const total = Math.max(1, graph.summary.nodeCount);
    return {
      kind: 'summary',
      title: 'Project graph',
      badge: graph.summary.truncated ? 'BOUNDED' : 'COMPLETE',
      sub: `${String(graph.summary.edgeCount)} typed edges · no embeddings`,
      facts: [
        { k: 'Nodes', v: String(graph.summary.nodeCount) },
        { k: 'Edges', v: String(graph.summary.edgeCount) },
        { k: 'God nodes', v: String(graph.nodes.filter((n) => n.kind === 'god').length) },
      ],
      communities: graph.communities.map((c) => ({
        label: c.name,
        n: c.size,
        pct: `${String(Math.round((c.size / total) * 100))}%`,
      })),
      rows: graph.nodes
        .filter((n) => n.kind !== 'symbol')
        .slice(0, 8)
        .map((n) => ({
          id: n.id,
          rel: n.kind === 'god' ? '★' : '◦',
          title: n.label,
          sub: n.sourceFile,
          meta: `${String(n.degree)} deg`,
        })),
    };
  }
  const connectedIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source === selectedId) connectedIds.add(edge.target);
    if (edge.target === selectedId) connectedIds.add(edge.source);
  }
  const rows = [...connectedIds]
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is KnowledgeGraph['nodes'][number] => n !== undefined)
    .slice(0, 12)
    .map((n) => ({
      id: n.id,
      rel: n.kind === 'god' ? '★' : '◦',
      title: n.label,
      sub: n.sourceFile,
      meta: n.kind,
    }));
  return {
    kind: 'node',
    eyebrow: selected.communityName ?? 'symbol',
    title: selected.label,
    badge: selected.kind.toUpperCase(),
    sub: selected.sourceFile,
    facts: [
      { k: 'Degree', v: String(selected.degree) },
      { k: 'Kind', v: selected.kind },
      { k: 'Community', v: selected.communityName ?? '—' },
    ],
    rows,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run apps/dashboard/src/knowledge/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/knowledge/model.ts apps/dashboard/src/knowledge/model.test.ts
git commit -m "feat(dashboard): pure knowledge-graph layout and inspector model"
```

---

## Task 8: Dashboard — the view + styles + entry points

**Files:**

- Create: `apps/dashboard/src/knowledge/knowledge-view.tsx`
- Create: `apps/dashboard/src/knowledge/knowledge-view.test.tsx`
- Create: `apps/dashboard/src/styles/knowledge.css`
- Modify: `apps/dashboard/src/main.tsx` (import `./styles/knowledge.css`)
- Modify: `apps/dashboard/src/app.tsx` (render `KnowledgeView`; add the overview drill-down link + Ctrl-K entry)
- Modify: `apps/dashboard/src/styles/tokens.test.ts` and `class-coverage.test.ts` registrations if they
  enumerate stylesheets/views explicitly (they do — add `knowledge.css` and the view).

**Interfaces:**

- Consumes: `layoutKnowledge`, `knowledgePanel` (Task 7), `KnowledgeGraph` + `loadKnowledgeScope`'s
  `ResourceState` (Task 6).
- Produces: `KnowledgeView({ graph, loading, projectId, projects, onSelectProject })`.

- [ ] **Step 1: Write the failing render test**

Create `apps/dashboard/src/knowledge/knowledge-view.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import { KnowledgeView } from './knowledge-view.js';

const graph: KnowledgeGraph = {
  summary: {
    nodeCount: 2,
    edgeCount: 1,
    communityCount: 1,
    hubCount: 1,
    embeddings: 0,
    observedAt: '2026-09-15T00:00:00.000Z',
    truncated: false,
  },
  communities: [{ id: 0, name: 'graph', size: 2 }],
  nodes: [
    {
      id: 'g::god',
      label: 'god',
      sourceFile: 'src/g.ts',
      community: 0,
      communityName: 'graph',
      kind: 'god',
      degree: 1,
    },
    {
      id: 'g::leaf',
      label: 'leaf',
      sourceFile: 'src/l.ts',
      community: 0,
      communityName: 'graph',
      kind: 'symbol',
      degree: 1,
    },
  ],
  edges: [{ source: 'g::god', target: 'g::leaf', kind: 'import' }],
};

describe('KnowledgeView', () => {
  it('renders the stat strip from the summary', () => {
    render(<KnowledgeView graph={{ state: 'ready', data: graph }} projectId="p1" projects={[]} />);
    expect(screen.getByText('2')).toBeInTheDocument(); // nodes
    expect(screen.getByText(/no graphify/i)).not.toBeInTheDocument?.();
  });

  it('shows the empty state when the project has no graphify output', () => {
    const empty: KnowledgeGraph = {
      summary: {
        nodeCount: 0,
        edgeCount: 0,
        communityCount: 0,
        hubCount: 0,
        embeddings: 0,
        truncated: false,
      },
      communities: [],
      nodes: [],
      edges: [],
    };
    render(<KnowledgeView graph={{ state: 'ready', data: empty }} projectId="p1" projects={[]} />);
    expect(screen.getByText(/graphify build/i)).toBeInTheDocument();
  });
});
```

Match the render/test helpers to the existing dashboard test setup (e.g. how `overview.test.tsx`
renders); adapt imports as needed.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/dashboard/src/knowledge/knowledge-view.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the view**

Create `apps/dashboard/src/knowledge/knowledge-view.tsx`. Render: a stat strip (nodes/edges/communities/
hubs/embeddings 0 + legend), the SVG canvas from `layoutKnowledge` (nodes styled by kind, edges by
kind, click a node → `useState` selectedId; click background → clear), the docked inspector from
`knowledgePanel`, and the provenance line (`built <commit> · observed <time>`). Empty state when
`summary.nodeCount === 0`: a message with the read-only guidance `Run \`graphify build\` in this
project`. Use only classes defined in `knowledge.css`. Follow the SVG idiom in the comp (god = filled
ink, hub = paper fill + ink stroke, symbol = dim) but static — no `requestAnimationFrame`, no force
sim. The project switcher reuses the passed `projects`list; selecting one calls`onSelectProject(id)`which the shell turns into`#/knowledge/<id>` navigation.

Keep the file focused; if it grows past ~200 lines, split the SVG canvas into a `knowledge-canvas.tsx`
child. The inspector may reuse existing panel primitives (`StatusChip`, `IdBadge`) where they fit.

- [ ] **Step 4: Write the styles**

Create `apps/dashboard/src/styles/knowledge.css` using the overview's mono tokens
(`var(--ink)`, `var(--paper)`, `var(--line)`, `var(--text-*)`, spacing tokens). No raw pixel in a
spacing/font property that the token guard forbids (SVG geometry attributes are in the TSX, not the
CSS, so they are exempt). Register every class here that the TSX uses.

- [ ] **Step 5: Wire the view + entry points**

- In `app.tsx`, replace the Task 6 placeholder branch with `<KnowledgeView graph={knowledge}
loading={knowledgeLoading} projectId={route.projectId} projects={overviewProjectsForSwitcher}
onSelectProject={(id) => { window.location.hash = routeHref({ name: 'knowledge', projectId: id }); }} />`.
  Source the switcher list from the snapshot's projects (the same list the overview PROJECT filter
  uses).
- In the overview **project drill-down** (`overview/drill-down.tsx`, the project panel's links row —
  where "Inspect / Evidence / Settings" already are), add a "Knowledge graph" link → `routeHref({ name:
'knowledge', projectId })`.
- Add `knowledge` to the **Ctrl-K** command list (wherever the detail routes are enumerated for the
  palette) as "Knowledge graph", navigating to `#/knowledge/<focusedProjectId>` (or `#/knowledge` when
  no project is focused, which shows a "pick a project" empty state — the switcher then selects one).
- In `main.tsx`, add `import './styles/knowledge.css';` beside the other style imports.

- [ ] **Step 6: Update the guards**

If `tokens.test.ts` / `class-coverage.test.ts` enumerate stylesheets or view modules explicitly, add
`styles/knowledge.css` and `knowledge/knowledge-view.tsx` to those lists. Run them:

Run: `pnpm exec vitest run apps/dashboard/src/styles/tokens.test.ts apps/dashboard/src/styles/class-coverage.test.ts`
Expected: PASS (a failure names the unregistered class/file — register it).

- [ ] **Step 7: Run the full dashboard suite + typecheck + build**

Run: `pnpm exec vitest run apps/dashboard`
Expected: PASS.
Run: `pnpm --filter @luwi/dashboard typecheck`
Expected: exit 0.
Run: `pnpm --filter @luwi/dashboard build`
Expected: built.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/knowledge apps/dashboard/src/styles/knowledge.css apps/dashboard/src/styles/tokens.test.ts apps/dashboard/src/styles/class-coverage.test.ts apps/dashboard/src/main.tsx apps/dashboard/src/app.tsx
git commit -m "feat(dashboard): render the per-project knowledge graph view"
```

---

## Task 9: Full-gate verification + live check

**Files:** none (verification only).

- [ ] **Step 1: Format, lint, typecheck, test**

```bash
pnpm format && pnpm lint && pnpm exec tsc -b --pretty false && pnpm --filter @luwi/dashboard typecheck && pnpm test
```

Expected: green except the pre-existing untracked `apps/cli/src/codex-mcp-launcher.test.ts` baseline
failure. Any other failure must be fixed before proceeding.

- [ ] **Step 2: Live check (dashboard-only, no daemon restart)**

`pnpm --filter @luwi/dashboard build`, then open `http://127.0.0.1:4782/?v=knowledge#/knowledge/<a real
project id>` (a project known to have `graphify-out/graph.json`, e.g. the luwiruntime project id). Verify
the graph, stat strip, community bars, node-select inspector, and provenance line render, and that a
project without graphify output shows the empty state. The daemon serves `dist/` per request, so no
restart is needed — only the cache-busting query string. Verify the new route via
`curl -s http://127.0.0.1:4782/api/v1/projects/<id>/knowledge-graph | head -c 400`.

- [ ] **Step 3: Report**

Report the gate result honestly (numbers), the live evidence, and note the commits. Do not push (§13 —
the owner's call).

---

## Self-review notes

- **Spec coverage:** reader (Task 2), projection (Task 3), endpoint + empty/404/error (Task 4),
  `#/knowledge` route (Task 5), scope load kept off the overview (Task 6), static community-ring layout
  - inspector (Task 7), view with honest provenance + dropped write actions + empty state + entry
    points (Task 8), boundaries/guards throughout, full-gate + live (Task 9). Deferred items (orbit
    animation, node-expand call, prune/delete/rebuild) are intentionally not tasks.
- **Type consistency:** `KnowledgeGraphResponse` (protocol) === `KnowledgeGraph` (dashboard alias);
  `KnowledgeDocument` (daemon reader) feeds `projectKnowledgeGraph`; node `kind` is `'god'|'hub'|'symbol'`
  and edge `kind` is `'import'|'call'` in every layer; `projectKnowledgeGraph(null)` and
  `readGraphifyKnowledge → null` are the single empty-state path.
- **Placeholders:** none — every code step carries the real code; wiring steps that depend on
  file-local idioms (the daemon project resolver, the dashboard test harness, the guard registrations)
  say exactly which existing lines to copy.
