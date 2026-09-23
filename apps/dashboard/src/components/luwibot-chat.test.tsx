// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivity } from '../api/agent-activity.js';
import type { AutopilotFlow } from '../api/autopilot-flow.js';
import type { GoalMutations } from '../api/goal-mutations.js';
import type { ResourceState } from './panel.js';
import { LuwiBotChat } from './luwibot-chat.js';

// jsdom has no WebSocket, and Node's global one would open a real connection to
// the LuwiBot service; this fake stays off the network, records sent frames, and
// lets a test push a server frame back. readyState OPEN so an intent sends at once.
const sockets: FakeSocket[] = [];
const lastSocket = (): FakeSocket | undefined => sockets.at(-1);
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  private listeners: Record<string, ((event: unknown) => void)[]> = {};
  constructor() {
    sockets.push(this);
  }
  addEventListener(type: string, cb: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  emit(type: string, event: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
}

const flowReady = (flow: AutopilotFlow) => () =>
  Promise.resolve<ResourceState<AutopilotFlow>>({ state: 'ready', data: flow });
const activityReady = (agents: AgentActivity[]) => () =>
  Promise.resolve<ResourceState<AgentActivity[]>>({ state: 'ready', data: agents });

const oneGoal = (over: Partial<AutopilotFlow['goals'][number]>): AutopilotFlow => ({
  goals: [
    {
      id: 'g1',
      title: 'Add dates',
      objective: 'Localize the dates',
      acceptanceCriteria: [],
      state: 'running',
      tasks: [],
      ...over,
    },
  ],
  more: 0,
});

const open = (props: Parameters<typeof LuwiBotChat>[0], hash = '#/pulse/p1') => {
  window.location.hash = hash;
  render(<LuwiBotChat {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ask LuwiBot' }));
};

const sentIntent = () =>
  (lastSocket()?.sent ?? [])
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .find((frame) => frame.kind === 'intent');

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('LuwiBotChat grounding', () => {
  it('sends the focused project with a chat message, so the answer is about that project', async () => {
    open({ loadAutopilotFlow: flowReady(oneGoal({ title: 'Localized dates', state: 'running' })) });
    await waitFor(() => expect(screen.getByText('Localized dates')).toBeTruthy());
    lastSocket()?.emit('open', {});
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Ne üzerinde çalışıyoruz?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const chat = (lastSocket()?.sent ?? [])
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame.message === 'Ne üzerinde çalışıyoruz?');
    expect(chat).toMatchObject({ projectId: 'p1' });
  });
});

describe('LuwiBotChat cockpit', () => {
  it("shows the focused project's active goal with its state and verdict", async () => {
    open({
      loadAutopilotFlow: flowReady(
        oneGoal({
          title: 'Localized dates',
          state: 'running',
          tasks: [
            {
              id: 't1',
              kind: 'review',
              title: 'Review the dates',
              brief: 'Confirm the fix.',
              paths: [],
              agentId: 'reviewer-a',
              state: 'done',
              verdict: 'accept',
            },
          ],
        }),
      ),
    });
    await waitFor(() => expect(screen.getByText('Localized dates')).toBeTruthy());
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('accept')).toBeTruthy();
    // Header carries the live autopilot status on a focus, not a second "LuwiBot".
    expect(screen.getByText('Autopilot · Working')).toBeTruthy();
    expect(screen.queryByText('LuwiBot')).toBeNull();
  });

  it('reads a proposed goal as queued with its objective, not "Planning…"', async () => {
    open({
      loadAutopilotFlow: flowReady(oneGoal({ state: 'proposed', objective: 'Ship the widget' })),
    });
    await waitFor(() => expect(screen.getByText('Queued · waiting to plan')).toBeTruthy());
    expect(screen.getByText('Ship the widget')).toBeTruthy();
    expect(screen.queryByText('Planning…')).toBeNull();
  });

  it('expands the goal objective and acceptance criteria on click', async () => {
    open({
      loadAutopilotFlow: flowReady(
        oneGoal({
          objective: 'Localize every admin-facing date to the viewer timezone.',
          acceptanceCriteria: ['Dates render in the local timezone', 'Existing tests still pass'],
        }),
      ),
    });
    await waitFor(() =>
      expect(
        screen.getByText('Localize every admin-facing date to the viewer timezone.'),
      ).toBeTruthy(),
    );
    const summary = screen.getByText('Localize every admin-facing date to the viewer timezone.');
    const details = summary.closest('details');
    // Collapsed by default: the native <details> starts closed.
    expect(details?.open).toBeFalsy();
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(screen.getByText('Dates render in the local timezone')).toBeTruthy();
    expect(screen.getByText('Existing tests still pass')).toBeTruthy();
  });

  it('shows no cockpit when no project is focused', async () => {
    open({ loadAutopilotFlow: flowReady({ goals: [], more: 0 }) }, '#/pulse');
    await waitFor(() => expect(screen.getByLabelText('LuwiBot assistant')).toBeTruthy());
    expect(screen.queryByLabelText('Autopilot goal')).toBeNull();
    // Off a project focus the header names itself.
    expect(screen.getByText('LuwiBot')).toBeTruthy();
  });

  it('offers Approve/Reject and Stop on a plan_review goal, not Answer', async () => {
    open({ loadAutopilotFlow: flowReady(oneGoal({ state: 'plan_review' })) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop the goal' })).toBeTruthy();
    expect(screen.queryByLabelText('Answer')).toBeNull();
    // The agentic rail marks Review as the operator's active touchpoint.
    expect(screen.getByLabelText('Where you come in')).toBeTruthy();
    expect(screen.getByText('Your turn — approve or reject the plan.')).toBeTruthy();
  });

  it("shows a task's brief and paths inside its own details on a plan_review goal", async () => {
    open({
      loadAutopilotFlow: flowReady(
        oneGoal({
          state: 'plan_review',
          tasks: [
            {
              id: 't1',
              kind: 'work',
              title: 'Localize date rendering',
              brief: 'Format every admin date through the user locale.',
              paths: ['apps/admin/dates.ts'],
              doneCriteria: 'All admin dates show the local timezone.',
              agentId: 'antigravity',
              state: 'awaiting_approval',
              verdict: undefined,
            },
          ],
        }),
      ),
    });
    await waitFor(() => expect(screen.getByText('Localize date rendering')).toBeTruthy());
    const summary = screen.getByText('Localize date rendering');
    const details = summary.closest('details');
    // Collapsed by default: the native <details> starts closed.
    expect(details?.open).toBeFalsy();
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(screen.getByText('Format every admin date through the user locale.')).toBeTruthy();
    expect(screen.getByText('apps/admin/dates.ts')).toBeTruthy();
    expect(screen.getByText('All admin dates show the local timezone.')).toBeTruthy();
  });

  it('shows the plan (task titles and paths) inside the approve confirm before sending', async () => {
    open({
      loadAutopilotFlow: flowReady(
        oneGoal({
          state: 'plan_review',
          tasks: [
            {
              id: 't1',
              kind: 'work',
              title: 'Localize date rendering',
              brief: 'Format every admin date through the user locale.',
              paths: ['apps/admin/dates.ts'],
              agentId: 'antigravity',
              state: 'awaiting_approval',
              verdict: undefined,
            },
            {
              id: 't2',
              kind: 'review',
              title: 'Review the date change',
              brief: 'Confirm the fix and run the tests.',
              paths: [],
              agentId: 'codex',
              state: 'ready',
              verdict: undefined,
            },
          ],
        }),
      ),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const confirm = screen.getByRole('group', { name: 'Approve plan' });
    expect(within(confirm).getByText(/Localize date rendering — antigravity/)).toBeTruthy();
    expect(within(confirm).getByText('apps/admin/dates.ts')).toBeTruthy();
    expect(within(confirm).getByText(/Review the date change — codex/)).toBeTruthy();
    expect(within(confirm).getByText('Whole project')).toBeTruthy();
    expect(sentIntent()).toBeUndefined(); // shown before the intent is sent
  });

  it('shows the question and an Answer box on a blocked goal, not Approve', async () => {
    open({
      loadAutopilotFlow: flowReady(oneGoal({ state: 'blocked', question: 'Which timezone?' })),
    });
    await waitFor(() => expect(screen.getByText('Which timezone?')).toBeTruthy());
    expect(screen.getByLabelText('Answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('sends an approve_plan intent over the socket only after confirming', async () => {
    open({ loadAutopilotFlow: flowReady(oneGoal({ state: 'plan_review' })) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(sentIntent()).toBeUndefined(); // dialog open, nothing sent yet
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    expect(sentIntent()).toMatchObject({ kind: 'intent', action: 'approve_plan', goalId: 'g1' });
    expect(typeof sentIntent()?.requestId).toBe('string');
  });

  it('surfaces a refused intent error relayed from the server', async () => {
    open({ loadAutopilotFlow: flowReady(oneGoal({ state: 'plan_review' })) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    const requestId = sentIntent()?.requestId as string;
    lastSocket()?.emit('message', {
      data: JSON.stringify({
        kind: 'intent_result',
        requestId,
        ok: false,
        error: 'plan not under review',
      }),
    });
    await waitFor(() => expect(screen.getByText('plan not under review')).toBeTruthy());
  });

  it('lists working agents and summarizes idle ones', async () => {
    open({
      loadAutopilotFlow: flowReady({ goals: [], more: 0 }),
      loadAgentActivity: activityReady([
        { agentId: 'coder', working: true },
        { agentId: 'reviewer', working: false },
      ]),
    });
    await waitFor(() => expect(screen.getByText(/1 working · 1 idle/)).toBeTruthy());
    expect(screen.getByText('coder')).toBeTruthy(); // working → listed
    expect(screen.queryByText('reviewer')).toBeNull(); // idle → summarized, not listed
  });

  it('marks the launcher offline and refuses to open a dead cockpit', async () => {
    window.location.hash = '#/pulse/p1';
    render(<LuwiBotChat loadAutopilotFlow={flowReady({ goals: [], more: 0 })} />);
    // The socket warms on mount; a refused connection marks the chat offline —
    // distinct from an idle fleet, which stays openable.
    lastSocket()?.emit('error', {});
    const bar = await screen.findByRole('button', { name: 'LuwiBot offline' });
    expect((bar as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(bar);
    expect(screen.queryByLabelText('LuwiBot assistant')).toBeNull(); // did not open
  });

  it('opens normally when the fleet is merely idle (reachable, not offline)', async () => {
    window.location.hash = '#/pulse/p1';
    render(<LuwiBotChat loadAutopilotFlow={flowReady({ goals: [], more: 0 })} />);
    lastSocket()?.emit('open', {}); // reachable, idle fleet
    const bar = await screen.findByRole('button', { name: 'Ask LuwiBot' });
    expect((bar as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(bar);
    await waitFor(() => expect(screen.getByLabelText('LuwiBot assistant')).toBeTruthy());
  });

  it('surfaces the autopilot project cockpit when none is focused', async () => {
    // Bare overview, no project focused — the cockpit should still follow the work.
    open(
      {
        loadAutopilotFlow: flowReady(oneGoal({ state: 'running' })),
        loadAutopilotProjects: async () => ['p1'],
      },
      '#/pulse',
    );
    await waitFor(() => expect(screen.getByLabelText('Autopilot goal')).toBeTruthy());
    expect(screen.getByText('Add dates')).toBeTruthy(); // the goal title, without a focus
  });

  it('stays chat-only with no focus and no autopilot project', async () => {
    open({ loadAutopilotFlow: flowReady(oneGoal({ state: 'running' })) }, '#/pulse');
    await waitFor(() => expect(screen.getByLabelText('LuwiBot assistant')).toBeTruthy());
    expect(screen.queryByLabelText('Autopilot goal')).toBeNull(); // no reader → no cockpit
  });

  it('offers a New goal form and smart-pill suggestions when a project has no active goal', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ state: 'ok', httpStatus: 201, data: { title: 'X' } });
    open(
      {
        loadAutopilotFlow: flowReady({ goals: [], more: 0 }),
        loadAutopilotProjects: async () => ['p1'],
        goalMutations: { create } as unknown as GoalMutations,
      },
      '#/pulse',
    );
    const socket = lastSocket();
    socket?.emit('open', {});
    // The New goal form is offered when there is no goal in flight.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create goal' })).toBeTruthy());
    // A suggestion reply renders clickable pills; a click creates that goal.
    socket?.emit('message', {
      data: JSON.stringify({
        kind: 'goal_suggestions',
        suggestions: [{ title: 'Add dates', objective: 'Localize them' }],
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add dates' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('p1', { title: 'Add dates', objective: 'Localize them' }),
    );
  });

  it('offers a one-click create pill when a chat reply infers a goal', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ state: 'ok', httpStatus: 201, data: { title: 'X' } });
    open(
      {
        loadAutopilotFlow: flowReady(oneGoal({ state: 'running' })),
        goalMutations: { create } as unknown as GoalMutations,
      },
      '#/pulse/p1',
    );
    lastSocket()?.emit('message', {
      data: JSON.stringify({
        reply: 'Sure — here is a goal.',
        goalSuggestion: { title: 'Add dates', objective: 'Localize them' },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: '+ Create goal: Add dates' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('p1', { title: 'Add dates', objective: 'Localize them' }),
    );
  });
});
