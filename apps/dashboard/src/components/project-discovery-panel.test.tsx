// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectDiscoveryResult } from '../api/project-discovery.js';
import type { ProjectMutationResult, ProjectMutations } from '../api/project-mutations.js';
import { ProjectDiscoveryPanel } from './project-discovery-panel.js';

afterEach(cleanup);

const candidate = (directoryName: string, extra: Record<string, unknown> = {}) => ({
  directoryName,
  displayName: directoryName,
  localPath: `C:/w/${directoryName}`,
  canonicalPath: `C:/w/${directoryName}`,
  ...extra,
});

const found: ProjectDiscoveryResult = {
  state: 'ready',
  data: {
    root: 'C:/w',
    candidates: [
      candidate('new-app'),
      candidate('luwi', { existingProjectId: 'project-1' }),
      candidate('link', { reason: 'outside_root' }),
    ],
    truncated: false,
  },
};

const registered: ProjectMutationResult = {
  state: 'ok',
  httpStatus: 201,
  data: {
    id: 'project-9',
    name: 'new-app',
    localPath: 'C:/w/new-app',
    canonicalPath: 'C:/w/new-app',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
  },
};

function subject(load = vi.fn(async () => found), register = vi.fn(async () => registered)) {
  const onRegistered = vi.fn();
  render(
    <ProjectDiscoveryPanel
      load={load}
      mutations={{ register, update: vi.fn() } as unknown as ProjectMutations}
      onRegistered={onRegistered}
      onCancel={vi.fn()}
    />,
  );
  return { load, register, onRegistered };
}

async function scan(root = 'C:/w'): Promise<void> {
  fireEvent.change(screen.getByLabelText('Root folder'), { target: { value: root } });
  fireEvent.submit(screen.getByRole('form', { name: 'Scan a folder' }));
  await screen.findByRole('table');
}

describe('ProjectDiscoveryPanel', () => {
  it('lists what the daemon found and ticks only what can be registered', async () => {
    const { load } = subject();
    await scan();
    expect(load).toHaveBeenCalledWith(
      'C:/w',
      expect.objectContaining({ signal: expect.anything() }),
    );
    const pick = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` });
    expect(pick('new-app')).toMatchObject({ checked: true, disabled: false });
    expect(pick('luwi')).toMatchObject({ checked: false, disabled: true });
    expect(pick('link')).toMatchObject({ checked: false, disabled: true });
    expect(screen.getByText('already registered')).toBeTruthy();
    expect(screen.getByText('resolves outside the root')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Register 1 selected' })).toBeTruthy();
  });

  it('registers the ticked folders one by one and reports each row', async () => {
    const { register, onRegistered } = subject();
    await scan();
    fireEvent.click(screen.getByRole('button', { name: 'Register 1 selected' }));
    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalledWith(['project-9']);
    });
    expect(register).toHaveBeenCalledWith({ name: 'new-app', localPath: 'C:/w/new-app' });
    expect(screen.getByText('registered')).toBeTruthy();
    // A registered row cannot be ticked again.
    expect(screen.getByRole('checkbox', { name: 'Select new-app' })).toMatchObject({
      disabled: true,
    });
  });

  it("shows the daemon's refusal of the root in its words", async () => {
    subject(
      vi.fn(async () => ({
        state: 'failed' as const,
        message: 'The project discovery root must be absolute.',
      })),
    );
    fireEvent.change(screen.getByLabelText('Root folder'), { target: { value: 'relative' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Scan a folder' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The project discovery root must be absolute.',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
});
