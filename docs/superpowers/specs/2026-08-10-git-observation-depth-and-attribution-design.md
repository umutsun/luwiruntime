# Git Observation Depth and Commit Attribution — Design

Date: 2026-08-10

Closes the visible half of item 10 in `docs/2026-08-09-dashboard-ui-audit.md`, plus the two
Git-shaped findings in its section 4 and the one real defect recorded in its section 6.

## Why this scope and not another

Item 10 lists five unbuilt read domains: inter-agent messaging, the capability/profile catalogue,
effective agent configuration, git attribution, and config drift. The audit ranked them by user
loss. This design ranks them by a second axis the audit did not measure — whether the domain has
any data on the machine that runs the dashboard.

Measured against the live Memurai instance (`luwi:v1:*`, 3072 keys), by namespace:

| Namespace               | Records | Consumed by the dashboard |
| ----------------------- | ------: | ------------------------- |
| `graph`                 |    2669 | yes                       |
| `package`               |      42 | yes                       |
| `git`                   |      28 | partly                    |
| `attribution`           |      17 | **no**                    |
| `session`               |       9 | yes                       |
| `project`               |       1 | yes                       |
| `message`               |       0 | no                        |
| `capability`, `profile` |       0 | count only                |
| `config`                |       0 | no                        |
| `context`               |       0 | yes (empty)               |
| `usage`, `optimization` |       0 | yes (empty)               |

Four of item 10's five domains hold nothing. Building a view over them would produce a route that
cannot be looked at, and this repository has already paid for changes that passed their tests and
were wrong on screen. Git attribution is the one domain with records, so it is the one this design
consumes. The other four are deferred, not rejected; ADR 0017 records the reasoning and the
measurement so the decision can be revisited when the data exists.

The audit named the pair-scoped context reads as "the cheapest honest place to start" because
`docs/phase5-dashboard-capability-matrix.md:17` already counts them in scope. That remains true
about scope and false about verifiability: the `context` namespace is empty, so those panels would
render nothing. They stay deferred on the same evidence as the rest.

### What the attribution panel will actually say

All 17 records carry `confidence: "unknown"`, `reasons: ["insufficient-session-correlation"]`, and
no `sessionId` or `agentId`. The panel will therefore report, for every row, that the runtime
observed a commit and could not tie it to a session.

That is the design intent, not a shortfall. The runtime computes attribution on every git scan and
currently throws the result away at the dashboard boundary; surfacing "attempted, not correlated"
is a true statement about the runtime that no surface makes today. The panel carries a note saying
so, because a column of `Unknown` with no explanation reads as a broken feature rather than as an
honest negative result.

## Work item 1 — Git observation depth

`gitObservationSchema` (`packages/protocol/src/intelligence.ts:372`) carries `branches` (max 1000),
`tags` (max 1000), and `worktrees` (max 1000, each with `path`, `headSha`, `branch`, `detached`,
`locked`). `apps/dashboard/src/api/project-scope.ts:196-198` reduces all three to `.length`, and
`branchCount`, `tagCount`, and `worktreeCount` appear in zero `.tsx` files. The data is already in
the response body, so the loss is total and the fix costs no request.

### Model change

`ProjectGit` replaces the three counts:

```ts
export type ProjectWorktree = {
  path: string;
  headSha: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
};

// worktreeCount / branchCount / tagCount are replaced by:
branches: string[];
tags: string[];
worktrees: ProjectWorktree[];
```

Optional fields follow the file's existing `exactOptionalPropertyTypes` idiom — spread-conditional
rather than assigning `undefined`.

### Render

`RepositoryBody` in `apps/dashboard/src/projects/projects-view.tsx` gains three labelled groups
below the existing summary, each headed by its noun and its count:

1. **Branches** and **Tags** as inline pill lists bounded to the first 25 entries each.
2. **Worktrees** as a table: Path (abbreviated, full in `title`), HEAD (abbreviated sha, full in
   `title`), Branch, State. `State` renders `Detached` and/or `Locked` as `StatusChip`s and nothing
   when neither flag is set. This is also the evidence that
   `GET /api/v1/projects/:projectId/git/worktrees` is redundant with the observation.
3. **Recent commits** keeps its existing table and joins the same labelled-group idiom, so the four
   blocks in the panel read consistently.

An empty collection renders its label, a count of `0`, and an explicit `No … recorded` line rather
than disappearing — an absent section would read as "not measured".

**Revised after looking at the rendered page.** The counts first went into the `key-values` summary
grid as large metrics, with the lists below them unlabelled. On screen that produced two identical
rows of pills — `master` and `phase-1-projects-sessions` — with nothing to say which was a branch
and which was a tag, and a `PATH / HEAD / BRANCH / STATE` table with no visible heading. The test
suite was green throughout, because every assertion was about presence rather than about whether a
reader could tell the blocks apart. Moving the count into the group label fixed the ambiguity and
removed the duplication in one change.

### Display bound versus read bound

The existing `TruncationNote` asserts that more records exist than were read. That is not the
claim here: the arrays arrive complete (the schema caps them at 1000, and the scanner would have
to exceed that for the read itself to be short). What is bounded is the display. The wording is
therefore distinct — `Showing the first 25 of N branches.` — so the two facts are never confused,
matching the way the codebase already keeps `not-observed`, `unavailable`, and `empty` apart.

## Work item 2 — Commit attribution

`GET /api/v1/projects/:projectId/git/attributions` (`apps/daemon/src/app.ts:620-628`) is a bounded
read that already parses `attributionCollectionSchema` on the daemon side. It has no consumer.

### Protocol

`packages/protocol/src/browser.ts` re-exports `attributionCollectionSchema` from
`./intelligence.js`. The browser entry point exists so the dashboard validates responses without
pulling the full protocol surface into the bundle; the schema is not currently re-exported, so this
is the one-line prerequisite.

### Project scope

`ProjectScopeResources` gains a fifth key, `attributions`. Selecting a project becomes five
independent bounded reads rather than four, each still carrying its own state so one failure
cannot erase its siblings.

```ts
export type ProjectAttribution = {
  id: string;
  commitSha: string;
  sessionId?: string;
  agentId?: string;
  confidence: 'exact' | 'correlated' | 'estimated' | 'unknown';
  reasons: string[];
  observedAt: string;
};
```

The read is `GET /api/v1/projects/:projectId/git/attributions?limit=100`, mapped through
`collected()` rather than `observed()`. The endpoint answers with an empty collection rather than
404 when nothing has been recorded, so `not-observed` has no meaning here and an empty list is the
empty answer — the same rule the packages and technologies reads already follow.

`projectScopeResourceKeys` gains `'attributions'`, which is what makes `runtime.` invalidate it.

### Realtime

`projectResourcesForEvent` maps `attribution.` to `['attributions']`. It deliberately does not add
`attributions` to the `git.` branch: `apps/daemon/src/intelligence-service.ts:1426-1447` emits
`attribution.recorded` once per attribution during a git scan, so the precise prefix already covers
every case a scan produces, and mapping both would refresh the panel twice for one cause.
`attribution.` is already accepted by `apps/dashboard/src/realtime/schema.ts`, so no change is
needed there.

### Confidence chip

`attributionConfidenceSchema` is `exact | correlated | estimated | unknown`
(`packages/protocol/src/intelligence.ts:473`). The existing `ConfidenceChip` in
`apps/dashboard/src/components/panel.tsx` is typed to `high | medium | low | unknown` and cannot be
reused. A sibling `AttributionConfidenceChip` is added alongside it with its own label and tone
maps, keeping the rule the original encodes: the label is always text, never colour alone.

Tones: `exact` → success, `correlated` → info, `estimated` → warning, `unknown` → unknown.

### Panel

A `ResourcePanel<Bounded<ProjectAttribution>>` titled `Commit attribution`, placed after the
Repository panel because it is about the same subject, with columns Commit, Attributed to,
Confidence, and Reasons.

- **Commit** — abbreviated sha in `<code>`, full sha in `title`, matching `RepositoryBody`.
- **Attributed to** — `agentId` and `sessionId` when present; `Unattributed` in the `unavailable`
  style when both are absent. An absent attribution is never rendered as a blank cell.
- **Confidence** — `AttributionConfidenceChip`.
- **Reasons** — the `reasons` array joined with a comma and a space; an empty array renders as the `unavailable`
  style `No reason recorded`, because a graded attribution with no stated reason is a different
  fact from an ungraded one.

Empty message: `No commit attribution recorded`. Truncation uses the existing `TruncationNote` with
noun `attributions`, since here the bound genuinely is the read.

A note below the table states that attribution is observed, not asserted: a commit the runtime
could not tie to a session stays unattributed rather than being assigned a guess, and the reason
column says why.

## Work item 3 — Graph explorer dead state

`apps/dashboard/src/routes/graph-explorer-view.tsx:124` seeds the root once with
`useState(() => seeds[0])` and never re-syncs it to `seeds`.

**Reproduction:** reload the page while on `#/graph`. `GraphView` mounts `GraphExplorerView` as
soon as `loadSubgraph` is defined, which is on the first render (`apps/dashboard/src/main.tsx`
binds it once), while the Pulse snapshot is still empty. `seeds` is therefore `[]` at mount and the
lazy initialiser captures `undefined`. When the snapshot arrives, the `seeds.length === 0` early
return at `:150-161` stops firing, but `root` is still `undefined`, so the load effect returns
immediately and the render falls to the `result === undefined || loading` branch — a permanent
`Reading the bounded subgraph` with `aria-busy="true"`. Recoverable only by touching the Root
select.

### Fix

A narrow re-sync effect:

```ts
useEffect(() => {
  if (root === undefined && seeds.length > 0) setRoot(seeds[0]);
}, [root, seeds]);
```

The alternative — deriving `const root = rootOverride ?? seeds[0]` — is rejected. `seeds` is
rebuilt by `useMemo` on every snapshot change (`apps/dashboard/src/app.tsx:181`), so a derived root
would change identity on every refresh, and `root` is a dependency of the load effect. That would
turn every snapshot refresh into a redundant subgraph request. The conditional effect fires once
and then its guard is false forever.

The `seeds.length === 0` early return stays. It is correct for the genuinely-empty case and this
change does not touch it.

## Testing

Per AGENTS.md section 15, each transition gets a test.

| File                                  | Added assertions                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/project-scope.test.ts`           | attributions ready / empty / unavailable; branches, tags, worktrees mapped as arrays; `attribution.` event mapping; `runtime.` covering the new key                                       |
| `projects/projects-view.test.tsx`     | attribution panel in all four states; `Unattributed` row; confidence chip label text; truncation note; worktree table including detached/locked; the `Showing the first 25 of N` sentence |
| `routes/graph-explorer-view.test.tsx` | mounting with empty seeds renders the empty state; re-rendering with seeds syncs the root and issues one load; no permanent busy state                                                    |
| `components/panel.test.tsx`           | `AttributionConfidenceChip` labels and tones for all four values                                                                                                                          |

## Documentation

- **ADR 0017** — records the scope decision: consume the git attribution read, defer the four
  zero-data domains, with the measurement that drove it.
- `docs/phase5-dashboard-capability-matrix.md` — a Git attribution row, and the project scope
  request set corrected from four reads to five.
- `docs/2026-08-09-dashboard-ui-audit.md` — item 10 marked partly closed, naming what remains open.
- `AGENTS.md` section 21, `CLAUDE.md`, `README.md` — the approval and the resulting state, matching
  how phases 5C, 5D and ADRs 0012–0016 are already recorded.

## Out of scope

Inter-agent messaging, the capability and profile catalogue, effective agent configuration and its
conflicts, and config drift, plans and snapshots. No mutation endpoint is called. Nothing here
adds a dependency, a datastore, or a write path.
