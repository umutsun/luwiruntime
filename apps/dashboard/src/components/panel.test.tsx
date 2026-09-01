// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AttributionConfidenceChip, Panel, PanelBody, ResourcePanel } from './panel.js';

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

describe('PanelBody', () => {
  it('keeps the shared inset class while accepting a route-specific class', () => {
    render(
      <PanelBody className="route-controls">
        <span>Controls</span>
      </PanelBody>,
    );

    expect(screen.getByText('Controls').parentElement?.className).toBe(
      'panel__body route-controls',
    );
  });
});

describe('AttributionConfidenceChip', () => {
  /**
   * Attribution grades its own way — `exact | correlated | estimated | unknown`
   * — so it cannot borrow `ConfidenceChip`, whose type is the intelligence
   * scale. It must still obey the same rule: the grade is always readable as
   * text, never carried by colour alone.
   */
  it('names every attribution grade as text', () => {
    const grades = [
      ['exact', 'Exact'],
      ['correlated', 'Correlated'],
      ['estimated', 'Estimated'],
      ['unknown', 'Unknown'],
    ] as const;

    for (const [value, label] of grades) {
      const { unmount } = render(<AttributionConfidenceChip confidence={value} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('separates a graded attribution from an ungraded one by tone as well', () => {
    const { unmount } = render(<AttributionConfidenceChip confidence="exact" />);
    const exact = screen.getByText('Exact').className;
    unmount();

    render(<AttributionConfidenceChip confidence="unknown" />);

    expect(screen.getByText('Unknown').className).not.toBe(exact);
  });
});

/**
 * Long routes stack many panels, and the owner's read of the running product
 * was that a page of full-height cards is hard to work with: you scroll past
 * evidence you are not looking at to reach the one you are. A panel can now be
 * folded, and the fold is a real control rather than a CSS-only affordance, so
 * assistive technology reports the same state the eye sees.
 */
describe('collapsible Panel', () => {
  it('renders its content expanded by default', () => {
    render(
      <Panel title="Nodes by kind" collapsible>
        <p>rows</p>
      </Panel>,
    );

    expect(screen.getByText('rows')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /nodes by kind/i }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('folds and unfolds when the header control is used', () => {
    render(
      <Panel title="Nodes by kind" collapsible>
        <p>rows</p>
      </Panel>,
    );
    const toggle = screen.getByRole('button', { name: /nodes by kind/i });

    fireEvent.click(toggle);
    expect(screen.queryByText('rows')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(screen.getByText('rows')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('can start folded for panels that are secondary evidence', () => {
    render(
      <Panel title="Nodes by kind" collapsible defaultCollapsed>
        <p>rows</p>
      </Panel>,
    );

    expect(screen.queryByText('rows')).toBeNull();
    expect(
      screen.getByRole('button', { name: /nodes by kind/i }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('stays a plain section when it is not collapsible', () => {
    // The default must not grow a control: most panels carry one short block
    // and a fold would be noise.
    render(
      <Panel title="Projection">
        <p>rows</p>
      </Panel>,
    );

    expect(screen.getByText('rows')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /projection/i })).toBeNull();
  });
});

describe('PanelBody', () => {
  it('provides the shared inset and vertical rhythm hook for non-table panel content', () => {
    render(
      <Panel title="New plan">
        <PanelBody>
          <label htmlFor="agent">Agent</label>
          <select id="agent" />
        </PanelBody>
      </Panel>,
    );

    expect(screen.getByLabelText('Agent').parentElement?.className).toBe('panel__body');
  });
});
