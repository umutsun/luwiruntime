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
  it('reads the mode and offers only the other modes', async () => {
    render(
      <ProjectAutopilot
        projectId="p1"
        loadAutopilot={readsMode('off')}
        autopilotMutations={{ setMode: vi.fn() }}
      />,
    );

    expect(await screen.findByText('Off')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable supervised for project p1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enable autopilot for project p1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn off for project p1' })).toBeNull();
  });

  it('warns when a non-off mode has no live coordinator', async () => {
    render(
      <ProjectAutopilot
        projectId="p1"
        loadAutopilot={readsMode('supervised', false)}
        autopilotMutations={{ setMode: vi.fn() }}
      />,
    );

    expect(await screen.findByText(/no live coordinator/)).toBeTruthy();
  });

  it('sets a mode and shows the outcome', async () => {
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'Enable supervised for project p1' }),
    );
    await waitFor(() => expect(setMode).toHaveBeenCalledWith('p1', 'supervised'));
    expect(await screen.findByText('Autopilot set to supervised.')).toBeTruthy();
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
