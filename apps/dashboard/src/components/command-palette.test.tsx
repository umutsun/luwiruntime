// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { buildPulseSnapshot, type PulseInput } from '../pulse/model.js';
import { CommandPalette } from './command-palette.js';

afterEach(() => {
  cleanup();
  window.location.hash = '#/pulse';
});

const input = (): PulseInput => ({
  measuredLatencyMs: 1,
  snapshotAt: '2026-08-05T08:00:00.000Z',
  health: { state: 'unavailable' },
  projects: {
    state: 'ready',
    data: [{ id: 'p1', name: 'Alpha Project', localPath: 'C:/alpha' }],
  },
  sessions: {
    state: 'ready',
    data: [
      {
        id: 's1',
        agentId: 'a1',
        projectId: 'p1',
        status: 'thinking',
        presence: 'online',
        startedAt: '2026-08-05T07:00:00.000Z',
        lastHeartbeatAt: '2026-08-05T07:59:00.000Z',
      },
    ],
  },
  agents: {
    state: 'ready',
    data: [
      {
        id: 'a1',
        kind: 'other',
        displayName: 'Primary Runner',
        adapterId: 'x',
        enabled: true,
        updatedAt: '2026-08-05T08:00:00.000Z',
      },
    ],
  },
  usage: { state: 'ready', data: [] },
  context: { state: 'ready', data: [] },
  activity: { state: 'ready', data: [] },
  findings: { state: 'ready', data: [] },
});

function renderPalette() {
  return render(<CommandPalette snapshot={buildPulseSnapshot(input())} scopeSummary="1 project" />);
}

describe('command palette', () => {
  it('opens from the scope trigger and searches the loaded snapshot', () => {
    renderPalette();

    const trigger = screen.getByLabelText('Current scope');
    expect(trigger.textContent).toContain('1 project');
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: /search/i });
    const box = within(dialog).getByRole('combobox');
    fireEvent.change(box, { target: { value: 'alpha' } });

    expect(within(dialog).getByText('Alpha Project')).toBeTruthy();
    expect(within(dialog).queryByText('Primary Runner')).toBeNull();
  });

  it('navigates on Enter and closes', () => {
    renderPalette();
    fireEvent.click(screen.getByLabelText('Current scope'));
    const box = screen.getByRole('combobox');

    fireEvent.change(box, { target: { value: 'alpha' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(window.location.hash).toBe('#/projects/p1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('finds routes by name', () => {
    renderPalette();
    fireEvent.click(screen.getByLabelText('Current scope'));
    const box = screen.getByRole('combobox');

    fireEvent.change(box, { target: { value: 'usag' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(window.location.hash).toBe('#/usage');
  });

  it('opens with Ctrl+K and closes with Escape, returning focus', () => {
    renderPalette();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: /search/i })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Current scope'));
  });

  it('says so when nothing matches, instead of an empty pane', () => {
    renderPalette();
    fireEvent.click(screen.getByLabelText('Current scope'));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz-none' } });

    expect(screen.getByText(/no matches in the loaded snapshot/i)).toBeTruthy();
  });

  it('moves the selection with the arrow keys', () => {
    renderPalette();
    fireEvent.click(screen.getByLabelText('Current scope'));
    const box = screen.getByRole('combobox');

    // Two known matches for "p": pick the second with ArrowDown.
    fireEvent.change(box, { target: { value: 'pulse' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });

    // Only one match ("Pulse" route), so ArrowDown wraps back to it.
    expect(window.location.hash).toBe('#/pulse');
  });
});
