// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectMutationResult, ProjectMutations } from '../api/project-mutations.js';
import { ProjectForm } from './project-form.js';

afterEach(cleanup);

const stored = {
  id: 'p1',
  name: 'Alpha',
  localPath: 'C:/work/alpha',
  canonicalPath: 'C:/work/alpha',
  repositoryUrl: 'https://example.test/alpha.git',
  defaultBranch: 'main',
  createdAt: '2026-09-11T10:00:00.000Z',
  updatedAt: '2026-09-11T10:00:00.000Z',
};

function mutations(result: ProjectMutationResult): ProjectMutations & {
  register: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  return {
    register: vi.fn().mockResolvedValue(result),
    update: vi.fn().mockResolvedValue(result),
    updateAgentBinding: vi.fn(),
    remove: vi.fn(),
  };
}

describe('ProjectForm', () => {
  it('registers a project from its fields and hands the record back', async () => {
    const api = mutations({ state: 'ok', httpStatus: 201, data: stored });
    const onSuccess = vi.fn();
    render(
      <ProjectForm
        mode={{ kind: 'register' }}
        mutations={api}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('form', { name: 'Register a project' })).toBeTruthy();
    // No dialog of its own: the drawer that holds it owns focus and Escape.
    expect(screen.queryByRole('dialog')).toBeNull();
    const submit = screen.getByRole('button', { name: 'Register project' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Alpha ' } });
    fireEvent.change(screen.getByLabelText('Local path'), { target: { value: 'C:/work/alpha' } });
    fireEvent.change(screen.getByLabelText('Default branch (optional)'), {
      target: { value: 'main' },
    });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(stored, 'register'));
    expect(api.register).toHaveBeenCalledWith({
      name: 'Alpha',
      localPath: 'C:/work/alpha',
      defaultBranch: 'main',
    });
  });

  it('edits only what changed, sending null for a cleared field, and never the path', async () => {
    const api = mutations({ state: 'ok', httpStatus: 200, data: { ...stored, name: 'Beta' } });
    const onSuccess = vi.fn();
    render(
      <ProjectForm
        mode={{ kind: 'edit', project: stored }}
        mutations={api}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('form', { name: 'Edit project' })).toBeTruthy();
    expect(screen.queryByLabelText('Local path')).toBeNull();
    expect(screen.getByText('C:/work/alpha')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save changes' });
    // Nothing changed yet, so there is nothing to save.
    expect(save.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta' } });
    fireEvent.change(screen.getByLabelText('Repository URL (optional)'), { target: { value: '' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith({ ...stored, name: 'Beta' }, 'edit'),
    );
    expect(api.update).toHaveBeenCalledWith('p1', { name: 'Beta', repositoryUrl: null });
    expect(api.register).not.toHaveBeenCalled();
  });

  it('shows the daemon message on failure and lets the draft be corrected', async () => {
    const api = mutations({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'PROJECT_ALREADY_REGISTERED',
      message: 'A project is already registered for this local path.',
    });
    render(
      <ProjectForm
        mode={{ kind: 'register' }}
        mutations={api}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha' } });
    fireEvent.change(screen.getByLabelText('Local path'), { target: { value: 'C:/work/alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'A project is already registered for this local path.',
    );
    fireEvent.change(screen.getByLabelText('Local path'), { target: { value: 'C:/work/other' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Register project' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('cancels from its own control and never while saving', async () => {
    const onCancel = vi.fn();
    let resolve: ((value: ProjectMutationResult) => void) | undefined;
    const api: ProjectMutations = {
      register: vi
        .fn()
        .mockReturnValue(new Promise<ProjectMutationResult>((done) => (resolve = done))),
      update: vi.fn(),
      remove: vi.fn(),
      updateAgentBinding: vi.fn(),
    };
    render(
      <ProjectForm
        mode={{ kind: 'register' }}
        mutations={api}
        onSuccess={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alpha' } });
    fireEvent.change(screen.getByLabelText('Local path'), { target: { value: 'C:/work/alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register project' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    resolve?.({ state: 'ok', httpStatus: 201, data: stored });
  });
});
