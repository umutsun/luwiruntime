// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InspectorEmpty,
  InspectorPanel,
  formatSafeJson,
  type InspectorSelection,
} from './inspector-panel.js';
import type { DashboardEvent } from '../realtime/schema.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('read-only inspectors', () => {
  const relatedActivityLimit = 20;
  const project = {
    id: 'p1',
    name: 'LUWI',
    localPath: 'C:/luwi',
    activeSessions: { state: 'empty' as const, value: 0 },
  };
  const session = (overrides: Record<string, unknown> = {}) => ({
    id: 's1',
    agentId: 'agent-1',
    projectId: 'p1',
    projectName: 'LUWI',
    status: 'thinking',
    statusLabel: 'thinking',
    presence: 'online' as const,
    startedAt: '2026-08-05T07:00:00.000Z',
    lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
    ...overrides,
  });
  const event = (
    sequence: number,
    references: { projectId?: string; sessionId?: string } = {},
  ): DashboardEvent => ({
    streamId: `${String(sequence)}-0`,
    id: `event-${String(sequence)}`,
    version: 1,
    type: sequence % 2 === 0 ? 'session.heartbeat' : 'future.signal',
    occurredAt: `2026-08-05T08:${String(sequence % 60).padStart(2, '0')}:00.000Z`,
    workspaceId: 'local',
    ...references,
    payload: {},
  });

  /**
   * The event inspector stacks a detail list, a payload block and a navigation
   * block, and every one of them was always open. On a real event that is a
   * column of evidence you scroll past to reach the part you wanted, so the
   * blocks below the identity list fold — and the payload, which is the tallest
   * and the least often needed, starts folded.
   */
  it('folds the payload and related entities in the event inspector', () => {
    const selected: InspectorSelection = { kind: 'event', streamId: '3-0' };
    render(
      <InspectorPanel
        selection={selected}
        activity={[event(3, { projectId: 'p1', sessionId: 's1' })]}
        onClose={vi.fn()}
      />,
    );

    // The identity rows stay visible: they are what names the event.
    expect(screen.getByText('Event type')).toBeTruthy();

    const payload = screen.getByRole('button', { name: /payload/i });
    expect(payload.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(payload);
    expect(payload.getAttribute('aria-expanded')).toBe('true');

    const related = screen.getByRole('button', { name: /related entities/i });
    expect(related.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(related);
    expect(related.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /open project inspector/i })).toBeNull();
  });

  it('formats bounded safe JSON without rendering markup', () => {
    const rendered = formatSafeJson({
      markup: '<img src=x onerror=alert(1)>',
      value: 'x'.repeat(9000),
    });
    expect(rendered.length).toBeLessThanOrEqual(8193);
    expect(rendered).toContain('<img');
  });

  it('closes on Escape and restores focus to the opener', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button
            type="button"
            onClick={(event) => {
              event.currentTarget.focus();
              setOpen(true);
            }}
          >
            Open inspector
          </button>
          {open ? (
            <InspectorPanel
              selection={{
                kind: 'project',
                projectId: 'p1',
              }}
              projects={[project]}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </div>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open inspector' });
    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('shows canonical event identifiers and payload as text', () => {
    const selectedEvent: DashboardEvent = {
      streamId: '1-0',
      id: 'e1',
      version: 1,
      type: 'future.signal',
      occurredAt: '2026-08-05T08:00:00.000Z',
      workspaceId: 'local',
      payload: { markup: '<script>unsafe()</script>' },
    };
    render(
      <InspectorPanel
        selection={{ kind: 'event', streamId: '1-0' }}
        activity={[selectedEvent]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('1-0')).toBeTruthy();
    expect(screen.getByText('future.signal')).toBeTruthy();
    // The payload now starts folded, so open it before asserting on its text.
    // The claim under test is unchanged: the markup is rendered as text and
    // never becomes a live element.
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /payload/i }));
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>unsafe/)).toBeTruthy();
  });

  it('shows only matching, newest-first project activity within the explicit bound', () => {
    const activity = [
      ...Array.from({ length: relatedActivityLimit + 5 }, (_, index) =>
        event(index + 1, { projectId: 'p1' }),
      ),
      { ...event(99, { projectId: 'other' }), id: 'excluded-other-project-event' },
    ];
    render(
      <InspectorPanel
        selection={{
          kind: 'project',
          projectId: 'p1',
        }}
        projects={[project]}
        activity={activity}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Related activity' })).toBeTruthy();
    expect(
      screen.getByText('Most recent events in the local retained Activity window'),
    ).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(relatedActivityLimit);
    expect(items[0]?.textContent).toContain(`event-${String(relatedActivityLimit + 5)}`);
    expect(document.body.textContent).not.toContain('excluded-other-project-event');
  });

  it('shows matching session activity and derives active duration from start time only', () => {
    render(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session()]}
        activity={[event(1, { sessionId: 's1' }), event(2, { sessionId: 'other' })]}
        now={() => new Date('2026-08-05T08:30:00.000Z')}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('1 hour 30 minutes')).toBeTruthy();
    expect(screen.getByLabelText('Session duration: 1 hour 30 minutes')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(document.body.textContent).toContain('event-1');
    expect(document.body.textContent).not.toContain('event-2');
  });

  it('shows Unavailable for invalid or unsupported terminal duration data', () => {
    render(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[
          session({
            status: 'completed',
            statusLabel: 'completed',
            presence: 'offline',
            startedAt: 'invalid',
          }),
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Unavailable')).toBeTruthy();
  });

  it.each([
    ['invalid', 'invalid'],
    ['missing', undefined],
    ['future', '2026-08-05T09:00:00.000Z'],
  ])('does not open a duration interval for a %s session start', (_label, startedAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T08:00:00.000Z'));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    render(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session({ startedAt }) as never]}
        now={() => new Date(Date.now())}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it('captures one clock value so visible and accessible duration cannot cross a minute boundary', () => {
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date('2026-08-05T08:30:59.999Z'))
      .mockReturnValueOnce(new Date('2026-08-05T08:31:00.000Z'));
    render(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session({ lastHeartbeatAt: '2026-08-05T08:30:00.000Z' })]}
        now={now}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('1 hour 30 minutes')).toBeTruthy();
    expect(screen.getByLabelText('Session duration: 1 hour 30 minutes')).toBeTruthy();
    expect(now).toHaveBeenCalledOnce();
  });

  it('advances active duration on one bounded 60-second clock and clears it on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T08:00:00.000Z'));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const view = render(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session({ lastHeartbeatAt: '2026-08-05T08:00:00.000Z' })]}
        now={() => new Date(Date.now())}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('1 hour 0 minutes')).toBeTruthy();
    expect(intervalSpy).toHaveBeenCalledOnce();
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(60_000);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText('1 hour 1 minute')).toBeTruthy();
    expect(intervalSpy).toHaveBeenCalledOnce();

    view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts and stops exactly one duration interval as refreshed start data changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T08:00:00.000Z'));
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const now = () => new Date(Date.now());
    const view = render(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session({ startedAt: 'invalid' })]}
        now={now}
        onClose={vi.fn()}
      />,
    );
    expect(intervalSpy).not.toHaveBeenCalled();

    view.rerender(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session()]}
        now={now}
        onClose={vi.fn()}
      />,
    );
    expect(intervalSpy).toHaveBeenCalledOnce();

    view.rerender(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session({ lastHeartbeatAt: '2026-08-05T08:00:00.000Z' })]}
        now={now}
        onClose={vi.fn()}
      />,
    );
    expect(intervalSpy).toHaveBeenCalledOnce();

    view.rerender(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        sessions={[session({ startedAt: '2026-08-05T09:00:00.000Z' })]}
        now={now}
        onClose={vi.fn()}
      />,
    );
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });

  it('reconciles event identity against the retained Activity window', () => {
    const initial = event(1);
    const view = render(
      <InspectorPanel
        selection={{ kind: 'event', streamId: initial.streamId }}
        activity={[initial]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(initial.type)).toBeTruthy();

    const refreshed = { ...initial, type: 'session.status.changed', payload: { current: true } };
    view.rerender(
      <InspectorPanel
        selection={{ kind: 'event', streamId: initial.streamId }}
        activity={[refreshed]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('session.status.changed')).toBeTruthy();

    view.rerender(
      <InspectorPanel
        selection={{ kind: 'event', streamId: initial.streamId }}
        activity={[]}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Selected event unavailable from the retained Activity window'),
    ).toBeTruthy();
  });

  it('does not retain session details after the selected session is deleted', () => {
    render(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 'missing' }}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Selected session unavailable')).toBeTruthy();
    expect(screen.queryByText('agent-1')).toBeNull();
  });

  it('navigates from an event only to known project and session references', () => {
    function Harness() {
      const [selection, setSelection] = useState<InspectorSelection>({
        kind: 'event',
        streamId: '1-0',
      });
      return (
        <InspectorPanel
          selection={selection}
          activity={[event(1, { projectId: 'p1', sessionId: 's1' })]}
          projects={[
            {
              id: 'p1',
              name: 'LUWI',
              localPath: 'C:/luwi',
              activeSessions: { state: 'ready' as const, value: 1 },
            },
          ]}
          sessions={[
            {
              id: 's1',
              agentId: 'agent-1',
              projectId: 'p1',
              projectName: 'LUWI',
              status: 'thinking',
              statusLabel: 'thinking',
              presence: 'online',
              startedAt: '2026-08-05T07:00:00.000Z',
              lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
            },
          ]}
          onNavigate={setSelection}
          onClose={vi.fn()}
        />
      );
    }
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Open project inspector' }));
    expect(screen.getByRole('complementary', { name: 'Project inspector' })).toBeTruthy();
  });

  it('keeps a valid project action but suppresses a session owned by another project', () => {
    render(
      <InspectorPanel
        selection={{
          kind: 'event',
          streamId: '1-0',
        }}
        activity={[event(1, { projectId: 'p1', sessionId: 's2' })]}
        projects={[
          {
            id: 'p1',
            name: 'Project One',
            localPath: 'C:/p1',
            activeSessions: { state: 'empty' as const, value: 0 },
          },
          {
            id: 'p2',
            name: 'Project Two',
            localPath: 'C:/p2',
            activeSessions: { state: 'ready' as const, value: 1 },
          },
        ]}
        sessions={[
          {
            id: 's2',
            agentId: 'agent-2',
            projectId: 'p2',
            projectName: 'Project Two',
            status: 'thinking',
            statusLabel: 'thinking',
            presence: 'online',
            startedAt: '2026-08-05T07:00:00.000Z',
            lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
          },
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Open project inspector' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open session inspector' })).toBeNull();
    expect(
      screen.getByText(
        'Referenced session unavailable because its project does not match the event project.',
      ),
    ).toBeTruthy();
  });

  it('removes a session action when a refreshed snapshot makes the relationship incoherent', () => {
    const selection: InspectorSelection = {
      kind: 'event',
      streamId: '1-0',
    };
    const coherentSession = {
      id: 's2',
      agentId: 'agent-2',
      projectId: 'p1',
      projectName: 'Project One',
      status: 'thinking' as const,
      statusLabel: 'thinking',
      presence: 'online' as const,
      startedAt: '2026-08-05T07:00:00.000Z',
      lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
    };
    const view = render(
      <InspectorPanel
        selection={selection}
        activity={[event(1, { projectId: 'p1', sessionId: 's2' })]}
        projects={[
          {
            id: 'p1',
            name: 'Project One',
            localPath: 'C:/p1',
            activeSessions: { state: 'ready' as const, value: 1 },
          },
        ]}
        sessions={[coherentSession]}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open session inspector' })).toBeTruthy();

    view.rerender(
      <InspectorPanel
        selection={selection}
        activity={[event(1, { projectId: 'p1', sessionId: 's2' })]}
        projects={[
          {
            id: 'p1',
            name: 'Project One',
            localPath: 'C:/p1',
            activeSessions: { state: 'empty' as const, value: 0 },
          },
        ]}
        sessions={[{ ...coherentSession, projectId: 'p2', projectName: 'Project Two' }]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Open session inspector' })).toBeNull();
    expect(
      screen.getByText(
        'Referenced session unavailable because its project does not match the event project.',
      ),
    ).toBeTruthy();
  });

  it('navigates to a known session and Escape returns focus to the original event opener', async () => {
    function Harness() {
      const [selection, setSelection] = useState<InspectorSelection>();
      return (
        <>
          <button
            type="button"
            onClick={(click) => {
              click.currentTarget.focus();
              setSelection({
                kind: 'event',
                streamId: '1-0',
              });
            }}
          >
            Open event
          </button>
          {selection === undefined ? null : (
            <InspectorPanel
              selection={selection}
              activity={[event(1, { sessionId: 's1' })]}
              sessions={[
                {
                  id: 's1',
                  agentId: 'agent-1',
                  projectId: 'p1',
                  projectName: 'LUWI',
                  status: 'thinking',
                  statusLabel: 'thinking',
                  presence: 'online',
                  startedAt: '2026-08-05T07:00:00.000Z',
                  lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
                },
              ]}
              onNavigate={setSelection}
              onClose={() => setSelection(undefined)}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open event' });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Open session inspector' }));
    expect(screen.getByRole('complementary', { name: 'Session inspector' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('does not render dead navigation for unavailable referenced entities', () => {
    render(
      <InspectorPanel
        selection={{
          kind: 'event',
          streamId: '1-0',
        }}
        activity={[event(1, { projectId: 'missing-project', sessionId: 'missing-session' })]}
        projects={[]}
        sessions={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Open project inspector' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open session inspector' })).toBeNull();
    expect(screen.getByText('Referenced project unavailable')).toBeTruthy();
    expect(screen.getByText('Referenced session unavailable')).toBeTruthy();
  });

  it('shows an accurate empty retained-window state', () => {
    render(
      <InspectorPanel
        selection={{
          kind: 'project',
          projectId: 'p1',
        }}
        projects={[project]}
        activity={[]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('No related activity in the retained window')).toBeTruthy();
  });
  it('does not steal focus back on an unrelated re-render', () => {
    // `onClose` is an inline arrow in the parent, so it changes identity every
    // render. Keying the focus effect on it re-fired the focus call on every
    // accepted realtime event, yanking focus out from under anyone who had
    // moved it inside the open dialog.
    const view = render(
      <InspectorPanel
        selection={{ kind: 'project', projectId: 'p1' }}
        projects={[project]}
        activity={[]}
        onClose={() => undefined}
      />,
    );

    const inside = screen.getByRole('heading', { name: /related activity/i });
    inside.setAttribute('tabindex', '-1');
    inside.focus();
    expect(document.activeElement).toBe(inside);

    view.rerender(
      <InspectorPanel
        selection={{ kind: 'project', projectId: 'p1' }}
        projects={[project]}
        activity={[]}
        onClose={() => undefined}
      />,
    );

    expect(document.activeElement).toBe(inside);
  });

  it('moves focus to the panel when the selection changes', () => {
    const view = render(
      <InspectorPanel
        selection={{ kind: 'project', projectId: 'p1' }}
        projects={[project]}
        activity={[]}
        onClose={vi.fn()}
      />,
    );
    const close = screen.getByRole('button', { name: /close inspector/i });
    expect(document.activeElement).toBe(close);

    (document.activeElement as HTMLElement).blur();
    view.rerender(
      <InspectorPanel
        selection={{ kind: 'session', sessionId: 's1' }}
        projects={[project]}
        sessions={[session()]}
        activity={[]}
        onClose={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /close inspector/i }));
  });

  /**
   * This replaces "keeps Tab inside the dialog, because it declares aria-modal".
   *
   * That test was correct for an overlay. The inspector is a docked column now:
   * it is permanently visible, nothing behind it is inert, and it declares no
   * `aria-modal`. Trapping Tab in a region the user never entered would strand
   * them, so the trap was removed on purpose and this asserts the removal rather
   * than leaving a hole where a contract used to be.
   */
  it('lets Tab leave, because it is docked rather than modal', () => {
    render(
      <InspectorPanel
        selection={{ kind: 'event', streamId: '1-0' }}
        projects={[project]}
        sessions={[session()]}
        activity={[event(1, { projectId: 'p1', sessionId: 's1' })]}
        onClose={vi.fn()}
      />,
    );

    const pane = screen.getByRole('complementary', { name: 'Event inspector' });
    expect(pane.getAttribute('aria-modal')).toBeNull();

    const focusable = [...pane.querySelectorAll<HTMLElement>('button')];
    expect(focusable.length).toBeGreaterThan(1);
    const last = focusable[focusable.length - 1]!;

    // Tab is not intercepted, so focus stays where the browser left it rather
    // than wrapping to the first control.
    last.focus();
    fireEvent.keyDown(pane, { key: 'Tab' });
    expect(document.activeElement).toBe(last);
  });

  it('names itself as a landmark even with nothing selected', () => {
    render(<InspectorEmpty />);

    const pane = screen.getByRole('complementary', { name: 'Inspector' });
    expect(pane.textContent).toContain('Select a project, session or event');
  });
});
