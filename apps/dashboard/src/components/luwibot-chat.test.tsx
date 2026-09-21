// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivity } from '../api/agent-activity.js';
import type { AutopilotFlow } from '../api/autopilot-flow.js';
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

describe('LuwiBotChat cockpit', () => {
  it("shows the focused project's active goal with its state and verdict", async () => {
    open({
      loadAutopilotFlow: flowReady(
        oneGoal({
          title: 'Localized dates',
          state: 'running',
          tasks: [
            { id: 't1', kind: 'review', agentId: 'reviewer-a', state: 'done', verdict: 'accept' },
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
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByLabelText('Answer')).toBeNull();
    // The agentic rail marks Review as the operator's active touchpoint.
    expect(screen.getByLabelText('Where you come in')).toBeTruthy();
    expect(screen.getByText('Your turn — approve or reject the plan.')).toBeTruthy();
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
});
