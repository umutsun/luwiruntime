// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardErrorBoundary } from './error-boundary.js';

afterEach(cleanup);

function Explode({ message }: { message: string }): never {
  throw new Error(message);
}

/**
 * The boundary is the difference between a rendering fault and a white screen,
 * and it had no test: removing `getDerivedStateFromError` left the whole suite
 * green while the app died on any render error.
 */
describe('DashboardErrorBoundary', () => {
  it('renders its children when nothing fails', () => {
    render(
      <DashboardErrorBoundary>
        <p>Pulse</p>
      </DashboardErrorBoundary>,
    );

    expect(screen.getByText('Pulse')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('replaces a failed subtree with a recoverable message instead of a blank page', () => {
    // React logs the caught error; silencing it keeps the run readable without
    // suppressing a real failure, because the assertions below still hold.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <DashboardErrorBoundary>
        <Explode message="projection exploded" />
      </DashboardErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Dashboard rendering unavailable');
    expect(alert.textContent).toContain('Reload the local page');
    errorLog.mockRestore();
  });

  it('never puts the error text or a stack trace on screen', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <DashboardErrorBoundary>
        <Explode message="redis://user:secret@127.0.0.1:6379" />
      </DashboardErrorBoundary>,
    );

    // AGENTS.md section 4: safe errors, no stack traces, no connection details.
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('redis://');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('at Explode');
    errorLog.mockRestore();
  });
});
