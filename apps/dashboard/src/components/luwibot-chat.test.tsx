// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const ready = (flow: AutopilotFlow): ResourceState<AutopilotFlow> => ({
  state: 'ready',
  data: flow,
});
const loader = (flow: AutopilotFlow) => () => Promise.resolve(ready(flow));
const oneGoal = (over: Partial<AutopilotFlow['goals'][number]>): AutopilotFlow => ({
  goals: [{ id: 'g1', title: 'Add dates', state: 'running', tasks: [], ...over }],
  more: 0,
});

const openWidget = (flow: AutopilotFlow, hash = '#/pulse/p1') => {
  window.location.hash = hash;
  render(<LuwiBotChat loadAutopilotFlow={loader(flow)} />);
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
  it("shows the focused project's active autopilot goal when open", async () => {
    openWidget(
      oneGoal({
        title: 'Localized dates',
        state: 'running',
        tasks: [
          { id: 't1', kind: 'review', agentId: 'reviewer-a', state: 'done', verdict: 'accept' },
        ],
      }),
    );
    await waitFor(() => expect(screen.getByText('Localized dates')).toBeTruthy());
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('accept')).toBeTruthy();
  });

  it('shows no autopilot flow when no project is focused', async () => {
    openWidget({ goals: [], more: 0 }, '#/pulse');
    await waitFor(() => expect(screen.getByLabelText('LuwiBot assistant')).toBeTruthy());
    expect(screen.queryByText('Autopilot flow')).toBeNull();
  });

  it('offers Approve/Reject and Stop on a plan_review goal, not Answer', async () => {
    openWidget(oneGoal({ state: 'plan_review' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByLabelText('Answer')).toBeNull();
  });

  it('offers the question and an Answer box on a blocked goal, not Approve', async () => {
    openWidget(oneGoal({ state: 'blocked', question: 'Which timezone?' }));
    await waitFor(() => expect(screen.getByText('Which timezone?')).toBeTruthy());
    expect(screen.getByLabelText('Answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('sends an approve_plan intent over the socket only after confirming', async () => {
    openWidget(oneGoal({ state: 'plan_review' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(sentIntent()).toBeUndefined(); // dialog open, nothing sent yet
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    expect(sentIntent()).toMatchObject({ kind: 'intent', action: 'approve_plan', goalId: 'g1' });
    expect(typeof sentIntent()?.requestId).toBe('string');
  });

  it('surfaces a refused intent error relayed from the server', async () => {
    openWidget(oneGoal({ state: 'plan_review' }));
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
});
