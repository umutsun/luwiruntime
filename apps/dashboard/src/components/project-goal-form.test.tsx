// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GoalMutations } from '../api/goal-mutations.js';
import { ProjectGoalForm } from './project-goal-form.js';

afterEach(cleanup);

const withCreate = (create: ReturnType<typeof vi.fn>): GoalMutations =>
  ({ create }) as unknown as GoalMutations;

describe('ProjectGoalForm', () => {
  it('creates a goal from the trimmed title and objective, then clears and confirms', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ state: 'ok', httpStatus: 201, data: { title: 'Add dates' } });
    render(<ProjectGoalForm projectId="p1" goalMutations={withCreate(create)} />);

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  Add dates  ' } });
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Localize them' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('p1', { title: 'Add dates', objective: 'Localize them' }),
    );
    await waitFor(() => expect(screen.getByText(/Goal created/)).toBeTruthy());
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
  });

  it('will not submit an empty form and surfaces a daemon error', async () => {
    const create = vi.fn().mockResolvedValue({
      state: 'failed',
      reason: 'http',
      httpStatus: 400,
      code: 'REQUEST_VALIDATION_FAILED',
      message: 'objective is required.',
    });
    render(<ProjectGoalForm projectId="p1" goalMutations={withCreate(create)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(create).not.toHaveBeenCalled(); // disabled while empty

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } });
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'O' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(screen.getByText('objective is required.')).toBeTruthy());
  });
});
