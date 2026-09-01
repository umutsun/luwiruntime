// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MessageMutations } from '../api/message-mutations.js';
import type { PulseSnapshot } from '../pulse/model.js';
import { AskSessionDialog } from './ask-session-dialog.js';

afterEach(cleanup);

type SessionRow = PulseSnapshot['sessions'][number];

function row(id: string, agentId: string): SessionRow {
  return {
    id,
    agentId,
    projectId: 'project-1',
    status: 'thinking',
    projectName: 'Runtime',
    statusLabel: 'thinking',
    agentName: agentId,
    agentKnown: false,
    context: { state: 'unavailable' },
    presence: 'online',
    startedAt: '2026-08-24T00:00:00.000Z',
    lastHeartbeatAt: '2026-08-24T00:01:00.000Z',
  };
}

const target = row('target-session', 'agent-b');
const sources = [row('source-one', 'agent-a'), row('source-two', 'agent-c')];

describe('AskSessionDialog', () => {
  it('creates the initial draft idempotency key only once across rerenders', () => {
    const createIdempotencyKey = vi.fn(() => 'draft-1');
    const props = {
      target,
      sources,
      mutations: { ask: vi.fn<MessageMutations['ask']>() },
      createIdempotencyKey,
      onSuccess: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(<AskSessionDialog {...props} />);

    view.rerender(<AskSessionDialog {...props} />);

    expect(createIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('shows the explicit source to target dispatch and submits one bounded question', async () => {
    const ask = vi.fn<MessageMutations['ask']>().mockResolvedValue({
      state: 'ok',
      httpStatus: 202,
      data: { correlationId: 'corr-1', targetSessionId: target.id, idempotent: false },
    });
    const onSuccess = vi.fn();
    render(
      <AskSessionDialog
        target={target}
        sources={sources}
        mutations={{ ask }}
        createIdempotencyKey={() => 'draft-1'}
        onSuccess={onSuccess}
        onCancel={() => undefined}
      />,
    );

    expect(screen.getByLabelText('Dispatch source-one to target-session')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Source session'), {
      target: { value: 'source-two' },
    });
    fireEvent.change(screen.getByLabelText('Subject (optional)'), {
      target: { value: '  Retention owner  ' },
    });
    fireEvent.change(screen.getByLabelText('Question'), {
      target: { value: 'Who owns the retention worker?' },
    });
    fireEvent.change(screen.getByLabelText('Deadline'), { target: { value: '300000' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Ask agent' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Ask agent' }));

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask).toHaveBeenCalledWith({
      sourceSessionId: 'source-two',
      targetSessionId: 'target-session',
      subject: '  Retention owner  ',
      content: 'Who owns the retention worker?',
      timeoutMs: 300_000,
      idempotencyKey: 'draft-1',
    });
    expect(onSuccess).toHaveBeenCalledWith('corr-1');
  });

  it('retains the draft key for an unchanged retry and rotates it after an edit', async () => {
    const ask = vi.fn<MessageMutations['ask']>().mockResolvedValue({
      state: 'failed',
      reason: 'http',
      code: 'SESSION_OFFLINE',
      message: 'The source session is offline.',
      httpStatus: 409,
    });
    const keys = ['draft-a', 'draft-b'];
    render(
      <AskSessionDialog
        target={target}
        sources={sources}
        mutations={{ ask }}
        createIdempotencyKey={() => keys.shift() ?? 'draft-c'}
        onSuccess={() => undefined}
        onCancel={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'First draft' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Ask agent' }));
    await screen.findByRole('alert');
    fireEvent.submit(screen.getByRole('form', { name: 'Ask agent' }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    expect(ask.mock.calls[0]?.[0].idempotencyKey).toBe('draft-b');
    expect(ask.mock.calls[1]?.[0].idempotencyKey).toBe('draft-b');

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Second draft' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Ask agent' }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
    expect(ask.mock.calls[2]?.[0].idempotencyKey).toBe('draft-c');
  });

  it('moves focus into the modal, closes on Escape, and returns focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onCancel = vi.fn();
    const { unmount } = render(
      <AskSessionDialog
        target={target}
        sources={sources}
        mutations={{ ask: vi.fn() }}
        onSuccess={() => undefined}
        onCancel={onCancel}
      />,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('Source session'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
