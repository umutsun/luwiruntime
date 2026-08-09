// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ResourcePanel } from './panel.js';

afterEach(cleanup);

/**
 * The precedence chain in `ResourcePanel` is the mechanism that keeps
 * "not observed", "unavailable", "still loading" and "genuinely empty" from
 * collapsing into one another. It was previously exercised only incidentally,
 * end to end, through two routes.
 */
function panel(props: Partial<Parameters<typeof ResourcePanel<string[]>>[0]> = {}) {
  return (
    <ResourcePanel<string[]>
      title="Sources"
      emptyMessage="No sources detected"
      isEmpty={(rows) => rows.length === 0}
      resource={undefined}
      {...props}
    >
      {(rows) => <p>{rows.join(', ')}</p>}
    </ResourcePanel>
  );
}

describe('ResourcePanel', () => {
  it('renders data when the read succeeded', () => {
    render(panel({ resource: { state: 'ready', data: ['a', 'b'] } }));
    expect(screen.getByText('a, b')).toBeTruthy();
  });

  it('separates a genuinely empty result from a failed one', () => {
    const { unmount } = render(panel({ resource: { state: 'ready', data: [] } }));
    expect(screen.getByText('No sources detected')).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
    unmount();

    render(panel({ resource: { state: 'unavailable' } }));
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText('No sources detected')).toBeNull();
  });

  it('separates not-observed from unavailable, because a 404 is a complete answer', () => {
    render(
      panel({
        resource: { state: 'not-observed' },
        notObservedMessage: 'Not observed — no scan recorded',
      }),
    );

    expect(screen.getByText('Not observed — no scan recorded')).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('treats an absent resource as unavailable when nothing is in flight', () => {
    render(panel({ resource: undefined }));
    expect(screen.getByText('Unavailable')).toBeTruthy();
  });

  it('reports an in-flight read as loading, not as a fault', () => {
    render(panel({ resource: undefined, loading: true }));

    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('prefers a settled result over the loading flag', () => {
    render(panel({ resource: { state: 'unavailable' }, loading: true }));

    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('marks the loading state busy so assistive technology can announce it', () => {
    render(panel({ resource: undefined, loading: true }));

    expect(screen.getByText(/loading/i).getAttribute('aria-busy')).toBe('true');
  });
});
