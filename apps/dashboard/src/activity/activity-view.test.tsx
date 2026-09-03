// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivityView } from './activity-view.js';
import { acceptActivityEvent, createActivityState } from '../realtime/activity-store.js';
import type { DashboardEvent } from '../realtime/schema.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const event = (streamId: string, type: string, projectId = 'project-1'): DashboardEvent => ({
  streamId,
  id: `event-${streamId}`,
  version: 1,
  type,
  occurredAt: '2026-08-05T08:00:00.000Z',
  workspaceId: 'local',
  projectId,
  payload: { safe: true },
});

describe('Activity view', () => {
  it('renders known and future event types and filters without dropping unknown events', () => {
    let state = createActivityState();
    state = acceptActivityEvent(state, event('1-0', 'session.heartbeat')).state;
    state = acceptActivityEvent(state, event('2-0', 'future.runtime.signal')).state;

    render(<ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />);

    expect(
      screen.getByRole('button', { name: 'Inspect future.runtime.signal event' }),
    ).toBeTruthy();
    expect(screen.getByText('Unsupported event type')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Event type'), {
      target: { value: 'future.runtime.signal' },
    });
    expect(
      screen.getByRole('button', { name: 'Inspect future.runtime.signal event' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspect session.heartbeat event' })).toBeNull();
  });

  it('pauses following on manual scroll and returns to the live edge when following resumes', () => {
    const onStateChange = vi.fn();
    const state = createActivityState();
    const view = render(
      <ActivityView state={state} onStateChange={onStateChange} onOpenEvent={vi.fn()} />,
    );

    const stream = screen.getByLabelText('Realtime activity stream');
    Object.defineProperty(stream, 'scrollTop', { configurable: true, value: 100 });
    fireEvent.scroll(stream);
    expect(onStateChange.mock.lastCall?.[0].following).toBe(false);

    const scrollTo = vi.fn();
    Object.defineProperty(stream, 'scrollTo', { configurable: true, value: scrollTo });
    view.rerender(
      <ActivityView
        state={{ ...state, following: false, pendingCount: 3 }}
        onStateChange={onStateChange}
        onOpenEvent={vi.fn()}
      />,
    );
    // Resuming is the shell's realtime switch now; this route carries no
    // control of its own and does not move until following is back on.
    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();

    view.rerender(
      <ActivityView
        state={{ ...state, following: true, pendingCount: 0 }}
        onStateChange={onStateChange}
        onOpenEvent={vi.fn()}
      />,
    );
    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'instant', top: 0 });
  });

  it('opens an event through a keyboard-accessible button', () => {
    const selected = event('3-0', 'project.updated');
    const state = acceptActivityEvent(createActivityState(), selected).state;
    const onOpenEvent = vi.fn();
    render(<ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={onOpenEvent} />);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect project.updated event' }));
    expect(onOpenEvent).toHaveBeenCalledWith(selected, expect.anything());
  });

  it('announces one live event after one bounded aggregation interval', async () => {
    vi.useFakeTimers();
    let state = createActivityState();
    const view = render(
      <ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />,
    );
    state = acceptActivityEvent(state, event('1-0', 'session.updated')).state;
    view.rerender(<ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />);

    await act(() => vi.advanceTimersByTimeAsync(750));

    expect(screen.getByLabelText('Activity updates').textContent).toBe(
      '1 new activity event. Latest event: session.updated.',
    );
  });

  it('aggregates bursts and ignores duplicate stream IDs', async () => {
    vi.useFakeTimers();
    let state = createActivityState();
    const view = render(
      <ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />,
    );
    for (const next of [
      event('1-0', 'session.updated'),
      event('2-0', 'project.updated'),
      event('2-0', 'project.updated'),
      event('3-0', 'usage.reported'),
    ]) {
      state = acceptActivityEvent(state, next).state;
      view.rerender(<ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />);
      await act(() => vi.advanceTimersByTimeAsync(100));
    }

    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(450));
    expect(screen.getByLabelText('Activity updates').textContent).toBe(
      '3 new activity events. Latest event: usage.reported.',
    );
  });

  it('announces pending live events while visual following is paused', async () => {
    vi.useFakeTimers();
    let state = { ...createActivityState(), following: false };
    const view = render(
      <ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />,
    );
    state = acceptActivityEvent(state, event('1-0', 'session.updated')).state;
    view.rerender(<ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />);

    await act(() => vi.advanceTimersByTimeAsync(750));
    expect(screen.getByLabelText('Activity updates').textContent).toBe(
      '1 new activity event pending while Activity is paused.',
    );
  });

  it('does not announce initial hydration and clears pending timers on unmount', async () => {
    vi.useFakeTimers();
    let state = acceptActivityEvent(createActivityState(), event('1-0', 'session.hydrated')).state;
    const view = render(
      <ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />,
    );
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByLabelText('Activity updates').textContent).toBe('');

    state = acceptActivityEvent(state, event('2-0', 'session.updated')).state;
    view.rerender(<ActivityView state={state} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('separates an unavailable activity read from a filter that matched nothing', () => {
    // A failed read used to flatten to an empty array and render the filter
    // message, which blames the filters for a fault they did not cause.
    const { unmount } = render(
      <ActivityView
        state={createActivityState()}
        available={false}
        onStateChange={vi.fn()}
        onOpenEvent={vi.fn()}
      />,
    );
    expect(screen.getByText(/activity snapshot unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/matches these filters/i)).toBeNull();
    unmount();

    render(
      <ActivityView state={createActivityState()} onStateChange={vi.fn()} onOpenEvent={vi.fn()} />,
    );
    expect(screen.getByText(/matches these filters/i)).toBeTruthy();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });
});
