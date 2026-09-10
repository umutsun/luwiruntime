// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '../api/messages-scope.js';
import type { WakeIntent } from '../api/wake-scope.js';
import type { PulseSnapshot } from '../pulse/model.js';
import { MessagesView } from './messages-view.js';

afterEach(cleanup);

type MessageOverrides = { [K in keyof AgentMessage]?: AgentMessage[K] | undefined };

/**
 * `exactOptionalPropertyTypes` is on, so an override of `undefined` cannot be
 * spread in as a present-but-undefined key. Stripping those keys is how a
 * fixture expresses "this field was never observed", which is exactly the state
 * these tests are about.
 */
function message(overrides: MessageOverrides = {}): AgentMessage {
  const merged: Record<string, unknown> = {
    id: 'msg-1',
    correlationId: 'corr-1',
    projectId: 'proj-1',
    sourceSessionId: 'sess-a',
    sourceAgentId: 'agent-a',
    targetSessionId: 'sess-b',
    targetAgentId: 'agent-b',
    selectionReason: 'only online session for the target agent',
    kind: 'question',
    subject: 'Who owns retention?',
    content: 'Asking before I change the trimming interval.',
    evidenceRequirements: ['session_state'],
    state: 'responded',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:04:00.000Z',
    deadlineAt: '2026-08-10T00:30:00.000Z',
    acknowledgedAt: '2026-08-10T00:01:00.000Z',
    respondedAt: '2026-08-10T00:04:00.000Z',
    response: {
      status: 'answered',
      answer: 'The background worker owns it.',
      confidence: 0.9,
      evidenceCount: 0,
      verifiedAt: '2026-08-10T00:04:00.000Z',
    },
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged as unknown as AgentMessage;
}

const inFlight = message({
  id: 'msg-2',
  correlationId: 'corr-2',
  state: 'delivered',
  subject: undefined,
  acknowledgedAt: undefined,
  respondedAt: undefined,
  response: undefined,
});

function view(items: AgentMessage[], truncated = false) {
  return <MessagesView messages={{ state: 'ready', data: { items, truncated } }} />;
}

const fallbackWake: WakeIntent = {
  id: 'wake-1',
  messageId: 'msg-1',
  workflowId: 'workflow-1',
  sourceSessionId: 'sess-a',
  correlationId: 'corr-1',
  terminalState: 'responded',
  adapter: 'codex-queue-v1',
  state: 'fallback_only',
  createdAt: '2026-08-10T00:00:01.000Z',
  updatedAt: '2026-08-10T00:00:06.000Z',
  reasonCode: 'target_unavailable',
};

const bridgedTarget = [
  {
    id: 'sess-b',
    agentId: 'agent-b',
    projectId: 'proj-1',
    projectName: 'Project One',
    status: 'idle',
    statusLabel: 'idle',
    presence: 'online',
    startedAt: '2026-08-09T00:00:00.000Z',
    lastHeartbeatAt: '2026-08-10T00:00:00.000Z',
    agentName: 'Agent B',
    agentKnown: true,
    context: { state: 'not-observed' },
    bridge: {
      state: 'observed',
      provider: 'antigravity',
      executionProfile: 'workspace-write',
      health: 'active',
      expiresAt: '2026-08-10T00:05:00.000Z',
    },
  },
] as unknown as PulseSnapshot['sessions'];

describe('MessagesView', () => {
  it('insets controls and notes without adding padding around the table', () => {
    render(view([message()]));

    const panel = screen.getByRole('region', { name: 'Messages' });
    const filters = within(panel).getByLabelText('State').closest('.table-filters');
    const note = within(panel).getByText(/message kinds and states/i);
    expect(filters?.parentElement?.classList.contains('panel__body')).toBe(true);
    expect(note.closest('.panel__body')).toBeTruthy();
    expect(within(panel).getByRole('table').closest('.panel__body')).toBeNull();
  });

  it('names both ends of the exchange and its state', () => {
    render(view([message()]));

    const row = screen.getByRole('row', { name: /agent-a/ });
    expect(within(row).getByText('agent-b')).toBeTruthy();
    expect(within(row).getByText('Responded')).toBeTruthy();
    expect(within(row).getByText('Who owns retention?')).toBeTruthy();
  });

  it('counts what is still in flight separately from what is retained', () => {
    render(view([message(), inFlight]));

    expect(screen.getByText(/2 retained · 1 in flight/i)).toBeTruthy();
  });

  it('says a message has no subject rather than leaving the cell blank', () => {
    render(view([inFlight]));

    expect(screen.getByText('No subject')).toBeTruthy();
  });

  it('reports no turnaround for an exchange that never recorded an end', () => {
    render(view([inFlight]));

    expect(screen.getByText('Not recorded')).toBeTruthy();
  });

  it('shows the routing reason and the request body only once opened', () => {
    render(view([message()]));
    expect(screen.queryByText(/only online session/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const detail = screen.getByRole('dialog', { name: 'Message detail' });
    expect(within(detail).getByText(/only online session/)).toBeTruthy();
    expect(within(detail).getByText(/Asking before I change/)).toBeTruthy();
    expect(within(detail).getByText('The background worker owns it.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Message detail' })).toBeNull();

    fireEvent.click(within(detail).getByRole('button', { name: 'Close drawer' }));
    expect(screen.queryByRole('dialog', { name: 'Message detail' })).toBeNull();
  });

  it('shows public wake timing, fallback delivery, and target bridge evidence', () => {
    render(
      <MessagesView
        messages={{ state: 'ready', data: { items: [message()], truncated: false } }}
        wakeIntents={{
          state: 'ready',
          data: { items: [fallbackWake], truncated: false },
        }}
        sessions={bridgedTarget}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const detail = screen.getByRole('dialog', { name: 'Message detail' });
    expect(within(detail).getByText('Fallback only')).toBeTruthy();
    expect(within(detail).getByText('2026-08-10T00:00:01.000Z')).toBeTruthy();
    expect(within(detail).getByText('2026-08-10T00:00:06.000Z')).toBeTruthy();
    expect(
      within(detail).getByText('antigravity · Declared profile: workspace-write'),
    ).toBeTruthy();
    expect(within(detail).getByText('Active')).toBeTruthy();
    expect(
      within(detail).getByText(
        'Automatic wake was unavailable; the durable inbox is the only delivery path.',
      ),
    ).toBeTruthy();
  });

  it('keeps a missing per-message wake unknown when the retained sample is truncated', () => {
    render(
      <MessagesView
        messages={{ state: 'ready', data: { items: [message()], truncated: false } }}
        wakeIntents={{ state: 'ready', data: { items: [], truncated: true } }}
        sessions={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const detail = screen.getByRole('dialog', { name: 'Message detail' });
    expect(within(detail).getByText('Wake evidence incomplete')).toBeTruthy();
    expect(within(detail).queryByText(/no automatic.*wake/i)).toBeNull();
  });

  it('opens the message selected by correlation once the bounded list arrives', () => {
    const { rerender } = render(
      <MessagesView messages={undefined} loading selectedCorrelationId="corr-2" />,
    );

    rerender(
      <MessagesView
        messages={{ state: 'ready', data: { items: [message(), inFlight], truncated: false } }}
        selectedCorrelationId="corr-2"
      />,
    );

    expect(screen.getByText(/still in flight/i)).toBeTruthy();
    expect(
      screen
        .getByRole('row', { name: /agent-a.*agent-b.*no subject/i })
        .getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('clears an old routed detail when a new correlation is outside the bounded list', () => {
    const resource = {
      state: 'ready' as const,
      data: { items: [message()], truncated: false },
    };
    const { rerender } = render(
      <MessagesView messages={resource} selectedCorrelationId="corr-1" />,
    );
    expect(screen.getByText('The background worker owns it.')).toBeTruthy();

    rerender(<MessagesView messages={resource} selectedCorrelationId="corr-not-retained" />);

    expect(screen.queryByText('The background worker owns it.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  });

  it('separates an in-flight message with no response from one that ended without a response', () => {
    const { unmount } = render(view([inFlight]));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByText(/still in flight/i)).toBeTruthy();
    unmount();

    render(view([message({ state: 'timed_out', response: undefined, respondedAt: undefined })]));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByText(/ended without a recorded response/i)).toBeTruthy();
  });

  it('reports an unreported confidence rather than rendering it as zero', () => {
    render(
      view([
        message({
          response: {
            status: 'answered',
            answer: 'Yes.',
            evidenceCount: 1,
            verifiedAt: '2026-08-10T00:04:00.000Z',
          },
        }),
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByText('Not reported')).toBeTruthy();
  });

  it('filters by state', () => {
    render(view([message(), inFlight]));

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'delivered' } });

    expect(screen.queryByText('Who owns retention?')).toBeNull();
    expect(screen.getByText('No subject')).toBeTruthy();
  });

  it('says an emptied filter is an empty filter, not an empty runtime', () => {
    // Reached by a realtime refresh rather than by one interaction: the state
    // stays selected while the bounded list rolls the last matching message
    // out. Without this branch the panel would look like a runtime with no
    // messages at all.
    const { rerender } = render(view([message(), inFlight]));
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'delivered' } });

    rerender(view([message()]));

    expect(screen.getByText(/no messages match this filter/i)).toBeTruthy();
    expect(screen.queryByText(/no messages recorded between agents/i)).toBeNull();
  });

  it('discloses truncation', () => {
    render(view([message()], true));

    expect(screen.getByText(/more messages exist/i)).toBeTruthy();
  });

  it('separates an empty message set from an unavailable read', () => {
    const { unmount } = render(
      <MessagesView messages={{ state: 'ready', data: { items: [], truncated: false } }} />,
    );
    expect(screen.getByText(/no messages recorded between agents/i)).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
    unmount();

    render(<MessagesView messages={{ state: 'unavailable' }} />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });

  it('reports an in-flight read as loading rather than as a fault', () => {
    render(<MessagesView messages={undefined} loading />);

    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('offers no control that would send, cancel or answer anything', () => {
    render(view([message()]));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/send|ask|retry|cancel|answer|reject|respond/i);
    }
  });
});
