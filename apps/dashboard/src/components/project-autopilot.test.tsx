// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotMode } from '@luwi/protocol/browser';

import { ProjectAutopilot } from './project-autopilot.js';

afterEach(cleanup);

const readsMode = (mode: AutopilotMode, coordinatorOnline = true) =>
  vi.fn(
    async () => ({ state: 'ready', data: { mode, configured: true, coordinatorOnline } }) as const,
  );

describe('ProjectAutopilot', () => {
  it('renders every mode as a segment and presses the current one', async () => {
    render(
      <ProjectAutopilot
        projectId="p1"
        loadAutopilot={readsMode('off')}
        autopilotMutations={{ setMode: vi.fn() }}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Off', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Supervised', pressed: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Autopilot', pressed: false })).toBeTruthy();
  });

  it('warns when a non-off mode has no live coordinator', async () => {
    render(
      <ProjectAutopilot
        projectId="p1"
        loadAutopilot={readsMode('supervised', false)}
        autopilotMutations={{ setMode: vi.fn() }}
      />,
    );

    expect(await screen.findByText(/live coordinator/)).toBeTruthy();
  });

  it('sets a mode from its segment and shows the outcome', async () => {
    const setMode = vi.fn().mockResolvedValue({
      state: 'ok',
      httpStatus: 200,
      data: {
        record: { mode: 'supervised', policy: {} },
        changed: true,
        coordinatorNotified: false,
      },
    });
    render(
      <ProjectAutopilot
        projectId="p1"
        loadAutopilot={readsMode('off')}
        autopilotMutations={{ setMode }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Supervised' }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith('p1', 'supervised'));
    expect(await screen.findByText('Autopilot set to supervised.')).toBeTruthy();
  });

  it('does not re-request the mode already selected', async () => {
    const setMode = vi.fn();
    render(
      <ProjectAutopilot
        projectId="p1"
        loadAutopilot={readsMode('supervised')}
        autopilotMutations={{ setMode }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Supervised', pressed: true }));
    expect(setMode).not.toHaveBeenCalled();
  });

  it('reports an unavailable read', async () => {
    render(
      <ProjectAutopilot
        projectId="p1"
        loadAutopilot={vi.fn(async () => ({ state: 'unavailable' }) as const)}
        autopilotMutations={{ setMode: vi.fn() }}
      />,
    );

    expect(await screen.findByText('Autopilot status is unavailable.')).toBeTruthy();
  });
});
