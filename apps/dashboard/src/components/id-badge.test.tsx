// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdBadge } from './id-badge.js';

afterEach(cleanup);

const uuid = 'd01ed09b-0783-4ff4-b875-8cc61d39792b';

describe('IdBadge', () => {
  it('abbreviates the id and keeps the full value as an accessible title', () => {
    render(<IdBadge id={uuid} label="session" />);

    const code = screen.getByText('d01ed09b');
    expect(code.getAttribute('title')).toBe(uuid);
  });

  it('copies the full id, never the abbreviation', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<IdBadge id={uuid} label="session" />);

    fireEvent.click(screen.getByRole('button', { name: `Copy session id ${uuid}` }));

    expect(writeText).toHaveBeenCalledWith(uuid);
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('keeps the copy control usable when the clipboard is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<IdBadge id={uuid} label="session" />);

    fireEvent.click(screen.getByRole('button', { name: `Copy session id ${uuid}` }));

    expect(screen.queryByText('Copied')).toBeNull();
    expect(screen.getByText('Copy')).toBeTruthy();
  });
});
