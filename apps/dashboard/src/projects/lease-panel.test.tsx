// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectLease } from '../api/lease-scope.js';
import { LeasePanel } from './lease-panel.js';

afterEach(cleanup);

const nowMs = Date.parse('2026-08-10T00:02:00.000Z');

function lease(overrides: Partial<ProjectLease> = {}): ProjectLease {
  return {
    id: 'lease-1',
    sessionId: 'session-a',
    agentId: 'codex-main',
    path: 'apps/daemon/src',
    reason: 'rewriting the capability route',
    state: 'held',
    acquiredAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:05:00.000Z',
    ...overrides,
  };
}

function view(items: ProjectLease[], truncated = false) {
  return <LeasePanel leases={{ state: 'ready', data: { items, truncated } }} nowMs={nowMs} />;
}

describe('LeasePanel', () => {
  it('names the path, the holder and what is left of the hold', () => {
    render(view([lease()]));

    const row = screen.getByRole('row', { name: /apps\/daemon\/src/ });
    expect(within(row).getByText('rewriting the capability route')).toBeTruthy();
    expect(within(row).getByText('3m')).toBeTruthy();
  });

  /**
   * Released and expired leases are history. Listing them would make a free
   * path look taken, which is the one mistake this panel must not make.
   */
  it('shows held leases only', () => {
    render(
      view([
        lease(),
        lease({ id: 'lease-2', path: 'packages/redis', state: 'released' }),
        lease({ id: 'lease-3', path: 'apps/cli', state: 'expired' }),
      ]),
    );

    expect(screen.getByRole('row', { name: /apps\/daemon\/src/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /packages\/redis/ })).toBeNull();
    expect(screen.queryByRole('row', { name: /apps\/cli/ })).toBeNull();
    expect(screen.getByText('1 held')).toBeTruthy();
  });

  it('treats a project whose only leases have ended as having none', () => {
    render(view([lease({ state: 'released' })]));

    expect(screen.getByText('No paths are claimed in this project')).toBeTruthy();
  });

  it('marks a lease held past its expiry as expiring rather than as zero seconds', () => {
    render(view([lease({ expiresAt: '2026-08-10T00:01:00.000Z' })]));

    expect(screen.getByText('Expiring')).toBeTruthy();
    expect(screen.queryByText('0s')).toBeNull();
  });

  it('says an unreadable expiry was not recorded instead of computing from it', () => {
    render(view([lease({ expiresAt: '2026-08-10T00:05:00.000Z', acquiredAt: 'nonsense' })]));

    expect(screen.getByText('3m')).toBeTruthy();
  });

  it('distinguishes an empty project from a failed read', () => {
    const { unmount } = render(view([]));
    expect(screen.getByText('No paths are claimed in this project')).toBeTruthy();
    unmount();

    render(<LeasePanel leases={{ state: 'unavailable' }} nowMs={nowMs} />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });

  it('reports a first paint as loading rather than as a fault', () => {
    render(<LeasePanel leases={undefined} loading nowMs={nowMs} />);

    expect(screen.getByText('Loading')).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('discloses truncation rather than presenting a cut list as the whole project', () => {
    render(view([lease()], true));

    expect(screen.getByText(/Bounded list/)).toBeTruthy();
  });

  it('names the holding session under the agent that a reader recognises', () => {
    render(view([lease()]));

    const row = screen.getByRole('row', { name: /apps\/daemon\/src/ });
    expect(within(row).getByText('codex-main')).toBeTruthy();
    expect(within(row).getByText('session-a')).toBeTruthy();
  });

  /** A dashboard that could break a lease would be enforcing an advisory hold. */
  it('offers no lease control, because breaking a lease is not the reader’s to do', () => {
    render(view([lease()]));

    // The panel folds now, so its header carries a collapse toggle (named for the
    // panel); what it must never offer is a control that breaks or releases a lease.
    expect(screen.queryByRole('button', { name: /break|release|revoke|delete/i })).toBeNull();
  });
});
