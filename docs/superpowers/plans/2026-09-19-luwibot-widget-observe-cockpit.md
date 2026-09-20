# LuwiBot Widget Observe Cockpit (Faz 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the dashboard's LuwiBot chat widget so that, when it is open and a project is focused, it shows that project's active autopilot goal and its tasks/verdicts live and read-only.

**Architecture:** The widget (`luwibot-chat.tsx`) is mounted as a sibling of the app in `main.tsx`, so it has no access to the app's focus state. It reads the focused project id from the route hash itself and loads the autopilot flow through an injected `loadAutopilotFlow` prop (the same reader the drill-down uses, `api/autopilot-flow.ts`). A pure `cockpitView(flow)` function maps the flow to a render-ready view; the widget renders it above the chat and refreshes it on a timer while open. No mutation, no new daemon-write module — this is Faz 1 (observe) of `docs/superpowers/specs/2026-09-19-luwibot-hitl-autopilot-cockpit-design.md`.

**Tech Stack:** TypeScript, React 18, Vite, Vitest + jsdom, the dashboard's design-token CSS (`tokens.test.ts`, `class-coverage.test.ts`).

## Global Constraints

- **Product-independence:** no HTTP daemon-mutation verb in the widget; `apps/dashboard/src/api/product-independence.test.ts` must stay green. Faz 1 is read-only (`loadAutopilotFlow` is a GET reader).
- **Design tokens:** every new CSS class must match a rule so `tokens.test.ts` and `class-coverage.test.ts` pass — no raw pixels in spacing/font properties, no opaque colour literals, every `luwibot-cockpit*` class covered.
- **No `localStorage` in tests:** jsdom here exposes none; do not read it in new code paths without a try/catch (the existing widget already avoids it).
- **Reuse, do not re-fetch shapes:** consume `AutopilotFlow`/`FlowGoal`/`FlowTask` from `apps/dashboard/src/api/autopilot-flow.ts` verbatim; do not redefine them.

---

### Task 1: Pure `cockpitView` model

**Files:**
- Create: `apps/dashboard/src/components/luwibot-cockpit.ts`
- Test: `apps/dashboard/src/components/luwibot-cockpit.test.ts`

**Interfaces:**
- Consumes: `AutopilotFlow`, `FlowGoal`, `FlowTask` from `../api/autopilot-flow.js`.
- Produces:
  - `type CockpitView = { kind: 'empty' } | { kind: 'goal'; goalId: string; title: string; stateLabel: string; tasks: CockpitTaskRow[]; moreGoals: number }`
  - `type CockpitTaskRow = { id: string; label: string; stateLabel: string; verdict: 'pass' | 'fail' | undefined }`
  - `function cockpitView(flow: AutopilotFlow | undefined): CockpitView`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';

import type { AutopilotFlow } from '../api/autopilot-flow.js';
import { cockpitView } from './luwibot-cockpit.js';

const flow = (goals: AutopilotFlow['goals'], more = 0): AutopilotFlow => ({ goals, more });

describe('cockpitView', () => {
  it('is empty when there is no flow or no active goal', () => {
    expect(cockpitView(undefined)).toEqual({ kind: 'empty' });
    expect(cockpitView(flow([]))).toEqual({ kind: 'empty' });
  });

  it('renders the first active goal with its tasks, verdicts, and extra-goal count', () => {
    const view = cockpitView(
      flow(
        [
          {
            id: 'goal-1',
            title: 'Localized dates',
            state: 'running',
            tasks: [
              { id: 't1', kind: 'implement', agentId: 'albanoosh-claude-coder', state: 'done', verdict: undefined },
              { id: 't2', kind: 'review', agentId: 'codex', state: 'running', verdict: 'fail' },
            ],
          },
        ],
        2,
      ),
    );
    expect(view).toEqual({
      kind: 'goal',
      goalId: 'goal-1',
      title: 'Localized dates',
      stateLabel: 'Running',
      moreGoals: 2,
      tasks: [
        { id: 't1', label: 'implement · albanoosh-claude-coder', stateLabel: 'Done', verdict: undefined },
        { id: 't2', label: 'review · codex', stateLabel: 'Running', verdict: 'fail' },
      ],
    });
  });

  it('labels a blocked goal and a task with no agent', () => {
    const view = cockpitView(
      flow([{ id: 'g', title: 'X', state: 'blocked', tasks: [{ id: 't', kind: 'implement', agentId: undefined, state: 'ready', verdict: undefined }] }]),
    );
    expect(view).toMatchObject({ kind: 'goal', stateLabel: 'Blocked', tasks: [{ label: 'implement', stateLabel: 'Ready' }] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/dashboard && pnpm exec vitest run src/components/luwibot-cockpit.test.ts`
Expected: FAIL — `cockpitView` is not defined / module missing.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { AutopilotFlow, FlowTask } from '../api/autopilot-flow.js';

export type CockpitTaskRow = {
  id: string;
  label: string;
  stateLabel: string;
  verdict: 'pass' | 'fail' | undefined;
};

export type CockpitView =
  | { kind: 'empty' }
  | {
      kind: 'goal';
      goalId: string;
      title: string;
      stateLabel: string;
      tasks: CockpitTaskRow[];
      moreGoals: number;
    };

// Snake/lower state values become a single Title Case word: 'plan_review' -> 'Plan review'.
const titleCase = (value: string): string =>
  value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const taskRow = (task: FlowTask): CockpitTaskRow => ({
  id: task.id,
  label: task.agentId === undefined ? task.kind : `${task.kind} · ${task.agentId}`,
  stateLabel: titleCase(task.state),
  verdict: task.verdict,
});

export function cockpitView(flow: AutopilotFlow | undefined): CockpitView {
  const goal = flow?.goals[0];
  if (goal === undefined) return { kind: 'empty' };
  return {
    kind: 'goal',
    goalId: goal.id,
    title: goal.title,
    stateLabel: titleCase(goal.state),
    tasks: goal.tasks.map(taskRow),
    moreGoals: flow?.more ?? 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/dashboard && pnpm exec vitest run src/components/luwibot-cockpit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/luwibot-cockpit.ts apps/dashboard/src/components/luwibot-cockpit.test.ts
git commit -m "feat(dashboard): pure cockpitView model for the LuwiBot widget"
```

---

### Task 2: Widget reads focus, loads the flow, renders the cockpit

**Files:**
- Modify: `apps/dashboard/src/components/luwibot-chat.tsx` (add the `loadAutopilotFlow` prop, focus-from-hash, the flow load, the cockpit render)
- Modify: `apps/dashboard/src/main.tsx:612` (pass the bound loader)
- Test: `apps/dashboard/src/components/luwibot-chat.test.tsx` (new)

**Interfaces:**
- Consumes: `cockpitView`, `CockpitView` from `./luwibot-cockpit.js`; `AutopilotFlow` and `loadAutopilotFlow`'s bound form; `parseRoute` from `../routing.js`; `ResourceState` from `./panel.js`.
- Produces: `LuwiBotChat` now accepts `{ loadAutopilotFlow?: (projectId: string, options?: { signal?: AbortSignal }) => Promise<ResourceState<AutopilotFlow>> }`. When the prop is absent (its default), the widget is chat-only as today.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AutopilotFlow } from '../api/autopilot-flow.js';
import type { ResourceState } from './panel.js';
import { LuwiBotChat } from './luwibot-chat.js';

const ready = (flow: AutopilotFlow): ResourceState<AutopilotFlow> => ({ state: 'ready', data: flow });

afterEach(() => {
  window.location.hash = '';
});

describe('LuwiBotChat cockpit', () => {
  it('shows the focused project active goal when open', async () => {
    window.location.hash = '#/projects/p1';
    const load = () =>
      Promise.resolve(
        ready({
          goals: [{ id: 'g1', title: 'Localized dates', state: 'running', tasks: [] }],
          more: 0,
        }),
      );
    render(<LuwiBotChat loadAutopilotFlow={load} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask LuwiBot' }));
    await waitFor(() => expect(screen.getByText('Localized dates')).toBeInTheDocument());
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('shows no cockpit when no project is focused', async () => {
    window.location.hash = '#/pulse';
    const load = () => Promise.resolve(ready({ goals: [], more: 0 }));
    render(<LuwiBotChat loadAutopilotFlow={load} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask LuwiBot' }));
    await waitFor(() => expect(screen.getByLabelText('LuwiBot assistant')).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Autopilot goal' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/dashboard && pnpm exec vitest run src/components/luwibot-chat.test.tsx`
Expected: FAIL — `LuwiBotChat` takes no props / no cockpit region rendered.

- [ ] **Step 3: Write the implementation**

In `luwibot-chat.tsx`, change the exported component and panel to thread the prop, read the focused project from the hash, load the flow while open, and render the cockpit. Add these imports at the top:

```tsx
import { cockpitView, type CockpitView } from './luwibot-cockpit.js';
import type { AutopilotFlow } from '../api/autopilot-flow.js';
import type { ResourceState } from './panel.js';
import { parseRoute } from '../routing.js';
```

Replace the `LuwiBotChat` wrapper and add a props type:

```tsx
type LuwiBotChatProps = {
  loadAutopilotFlow?: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<AutopilotFlow>>;
};

export function LuwiBotChat(props: LuwiBotChatProps = {}) {
  if (!ENABLED) return null;
  return <LuwiBotChatPanel {...props} />;
}

// The focused project id from the route hash, or undefined off a project route.
// parseRoute returns `{ name: 'projects', projectId?, agentId? }` for the project
// detail routes (`#/projects/<id>` and `#/projects/<id>/agents/<agentId>`).
function focusedProjectId(): string | undefined {
  const route = parseRoute(window.location.hash);
  return route.name === 'projects' ? route.projectId : undefined;
}
```

Inside `LuwiBotChatPanel(props: LuwiBotChatProps)`, add cockpit state and a load effect that runs while open, keyed to the focused project and re-run on `hashchange`, refreshing every 5s:

```tsx
const [view, setView] = useState<CockpitView>({ kind: 'empty' });

useEffect(() => {
  const load = props.loadAutopilotFlow;
  if (!open || load === undefined) {
    setView({ kind: 'empty' });
    return;
  }
  let cancelled = false;
  const controller = new AbortController();
  const run = async () => {
    const projectId = focusedProjectId();
    if (projectId === undefined) {
      if (!cancelled) setView({ kind: 'empty' });
      return;
    }
    const result = await load(projectId, { signal: controller.signal });
    if (!cancelled) setView(cockpitView(result.state === 'ready' ? result.data : undefined));
  };
  void run();
  const timer = window.setInterval(() => void run(), 5_000);
  const onHash = () => void run();
  window.addEventListener('hashchange', onHash);
  return () => {
    cancelled = true;
    controller.abort();
    window.clearInterval(timer);
    window.removeEventListener('hashchange', onHash);
  };
}, [open, props.loadAutopilotFlow]);
```

Render the cockpit just inside `<section className="luwibot__panel" …>`, above the `luwibot__log`:

```tsx
{view.kind === 'goal' ? (
  <section className="luwibot-cockpit" aria-label="Autopilot goal">
    <div className="luwibot-cockpit__head">
      <span className="luwibot-cockpit__title">{view.title}</span>
      <span className="luwibot-cockpit__state">{view.stateLabel}</span>
    </div>
    <ol className="luwibot-cockpit__tasks">
      {view.tasks.map((task) => (
        <li key={task.id} className="luwibot-cockpit__task">
          <span className="luwibot-cockpit__task-label">{task.label}</span>
          <span className="luwibot-cockpit__task-state">{task.stateLabel}</span>
          {task.verdict === undefined ? null : (
            <span className={`luwibot-cockpit__verdict luwibot-cockpit__verdict--${task.verdict}`}>
              {task.verdict === 'pass' ? 'PASS' : 'FAIL'}
            </span>
          )}
        </li>
      ))}
    </ol>
    {view.moreGoals > 0 ? (
      <p className="luwibot-cockpit__more">+{view.moreGoals} more</p>
    ) : null}
  </section>
) : null}
```

In `main.tsx:612`, pass the loader (a bound `fetchAutopilotFlow` already exists near `loadAutopilotFlow` in `main.tsx`; reuse it):

```tsx
<LuwiBotChat loadAutopilotFlow={fetchAutopilotFlow} />
```

> Note: if `fetchAutopilotFlow` is scoped inside a component in `main.tsx`, hoist the `<LuwiBotChat/>` mount to where that binding is in scope, or define the bound loader beside the mount. Keep the mount inside `DashboardErrorBoundary`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/dashboard && pnpm exec vitest run src/components/luwibot-chat.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the guard tests**

Run: `cd apps/dashboard && pnpm exec vitest run src/api/product-independence.test.ts`
Expected: PASS — the widget added no daemon-mutation module.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/luwibot-chat.tsx apps/dashboard/src/main.tsx apps/dashboard/src/components/luwibot-chat.test.tsx
git commit -m "feat(dashboard): LuwiBot widget shows the focused project's autopilot goal (observe)"
```

---

### Task 3: Cockpit styling under the token guard

**Files:**
- Modify: `apps/dashboard/src/styles/shell.css` (the stylesheet that defines `.luwibot__panel`)
- Test: `apps/dashboard/src/overview/tokens.test.ts`, `apps/dashboard/src/overview/class-coverage.test.ts` (existing — must stay green)

**Interfaces:**
- Consumes the stylesheet's existing tokens: text `--text` / muted `--text-muted`, border `--border`, spacing `--space-1`/`--space-2`/`--space-3`, font size `--font-size-sm`, accents `--success` (pass) and `--danger` (fail).
- Produces: rules for `.luwibot-cockpit`, `.luwibot-cockpit__head`, `.luwibot-cockpit__title`, `.luwibot-cockpit__state`, `.luwibot-cockpit__tasks`, `.luwibot-cockpit__task`, `.luwibot-cockpit__task-label`, `.luwibot-cockpit__task-state`, `.luwibot-cockpit__verdict`, `.luwibot-cockpit__verdict--pass`, `.luwibot-cockpit__verdict--fail`, `.luwibot-cockpit__more`.

- [ ] **Step 1: Run the coverage guard to see it fail**

Run: `cd apps/dashboard && pnpm exec vitest run src/overview/class-coverage.test.ts`
Expected: FAIL — the new `luwibot-cockpit*` classes rendered in Task 2 have no matching CSS rule.

- [ ] **Step 2: Add the CSS rules using existing tokens**

Add to `apps/dashboard/src/styles/shell.css`, beside the existing `.luwibot__*` rules, using the file's real tokens:

```css
.luwibot-cockpit {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--border);
}
.luwibot-cockpit__head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}
.luwibot-cockpit__title {
  font-weight: 500;
  color: var(--text);
}
.luwibot-cockpit__state {
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}
.luwibot-cockpit__tasks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.luwibot-cockpit__task {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
}
.luwibot-cockpit__task-label {
  color: var(--text);
}
.luwibot-cockpit__task-state {
  margin-inline-start: auto;
  color: var(--text-muted);
}
.luwibot-cockpit__verdict {
  font-size: var(--font-size-2xs);
}
.luwibot-cockpit__verdict--pass {
  color: var(--success);
}
.luwibot-cockpit__verdict--fail {
  color: var(--danger);
}
.luwibot-cockpit__more {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}
```

> `class-coverage.test.ts` requires every rendered `luwibot-cockpit*` class to match a rule. If it still flags one after adding the above (e.g. a base `.luwibot-cockpit__verdict` variant), add a bare rule for it. Confirm `--font-size-2xs`, `--success`, `--danger` exist in `shell.css` (they do as of this writing); if a token was renamed, use the file's current name.

- [ ] **Step 3: Run both guards to verify they pass**

Run: `cd apps/dashboard && pnpm exec vitest run src/overview/class-coverage.test.ts src/overview/tokens.test.ts`
Expected: PASS.

- [ ] **Step 4: Full dashboard check**

Run: `cd apps/dashboard && pnpm typecheck && pnpm exec vitest run`
Expected: typecheck clean; all dashboard tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src
git commit -m "style(dashboard): LuwiBot cockpit styling under the token guard"
```

---

## Self-Review

- **Spec coverage (Faz 1 only):** the spec's "Observe" (component 2, idle vs cockpit states) is Tasks 1–3; the render shows plan tasks + verdicts + goal state. The spec's blocked-question display and all intervention controls are Faz 2 (not in this plan) — this plan is read-only observe. Product-independence (spec Non-goals) is Task 2 Step 5. Token discipline (spec component 2 last bullet) is Task 3.
- **Deferred to Faz 2 (own plan):** Approve/Reject/Answer/Stop controls, the blocked-goal question surface, the intent WS protocol, and the LuwiBot server operator-proxy session. These need `luwibot/server.mjs` changes and a new WS message kind — a separate plan across two repos.
- **Prerequisite (Faz 0, not code here):** deploy LUWI fix #5 (coordinator read-batching) and the "reviewer-unavailable → escalate" behaviour before running a supervised goal to watch. Faz 1's UI is buildable and testable now with fixtures regardless.
- **Placeholder scan:** the CSS token names in Task 3 are explicitly flagged as file-specific to be replaced from the real stylesheet; the `parseRoute` discriminant in Task 2 is flagged to confirm from `routing.ts`. These are the only lookups; every other step is concrete.
- **Type consistency:** `CockpitView`/`CockpitTaskRow` defined in Task 1 are consumed unchanged in Task 2; `loadAutopilotFlow`'s signature matches `api/autopilot-flow.ts`.
