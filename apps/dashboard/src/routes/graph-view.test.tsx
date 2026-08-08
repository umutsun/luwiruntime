// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { GraphSummary } from '../api/intelligence-scope.js';
import { GraphView } from './graph-view.js';

afterEach(cleanup);

const observed: GraphSummary = {
  observed: true,
  generation: 'generation-1',
  retainedGenerationCount: 2,
  projectionHealth: 'healthy',
  nodeCount: 7,
  edgeCount: 4,
  nodeCountsByKind: [
    { kind: 'project', count: 2 },
    { kind: 'session', count: 5 },
  ],
  edgeCountsByKind: [{ kind: 'PROJECT_BOUND_AGENT', count: 4 }],
  observedAt: '2026-08-08T00:00:00.000Z',
};

/**
 * Anchored on a word boundary because the row labels overlap: `project` is a
 * prefix of both `Projection health` and `PROJECT_BOUND_AGENT`.
 */
function rowOf(label: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(`^${label}\\b`, 'i') });
}

describe('GraphView', () => {
  it('renders the active generation, totals, and per-kind counts', () => {
    render(<GraphView summary={{ state: 'ready', data: observed }} />);

    expect(within(rowOf('Active generation')).getByText('generation-1')).toBeTruthy();
    expect(within(rowOf('Nodes')).getByText('7')).toBeTruthy();
    expect(within(rowOf('Edges')).getByText('4')).toBeTruthy();

    expect(within(rowOf('project')).getByText('2')).toBeTruthy();
    expect(within(rowOf('PROJECT_BOUND_AGENT')).getByText('4')).toBeTruthy();
  });

  it('states that counts are exact rather than bounded', () => {
    render(<GraphView summary={{ state: 'ready', data: observed }} />);

    // Every other collection route carries a truncation note. This one must
    // not, and must say why, or a reader will assume the same bound applies.
    expect(screen.getByText(/exact/i)).toBeTruthy();
    expect(screen.queryByText(/truncated/i)).toBeNull();
  });

  it('reports an unbuilt graph as not observed instead of zero', () => {
    render(
      <GraphView
        summary={{
          state: 'ready',
          data: {
            observed: false,
            retainedGenerationCount: 0,
            projectionHealth: 'healthy',
            nodeCountsByKind: [],
            edgeCountsByKind: [],
            observedAt: '2026-08-08T00:00:00.000Z',
          },
        }}
      />,
    );

    expect(within(rowOf('Active generation')).getByText('Never built')).toBeTruthy();
    expect(within(rowOf('Nodes')).getByText('Not observed')).toBeTruthy();
    expect(within(rowOf('Edges')).getByText('Not observed')).toBeTruthy();
    // The one thing this route must never do.
    expect(within(rowOf('Nodes')).queryByText('0')).toBeNull();
    expect(within(rowOf('Edges')).queryByText('0')).toBeNull();
  });

  it('separates an empty generation from an unbuilt one', () => {
    render(
      <GraphView
        summary={{
          state: 'ready',
          data: {
            observed: true,
            generation: 'generation-2',
            retainedGenerationCount: 1,
            projectionHealth: 'healthy',
            nodeCount: 0,
            edgeCount: 0,
            nodeCountsByKind: [],
            edgeCountsByKind: [],
            observedAt: '2026-08-08T00:00:00.000Z',
          },
        }}
      />,
    );

    // A generation that exists and holds nothing is an observed zero.
    expect(within(rowOf('Nodes')).getByText('0')).toBeTruthy();
    expect(within(rowOf('Nodes')).queryByText('Not observed')).toBeNull();
    expect(screen.getByText('No nodes in the active generation')).toBeTruthy();
  });

  it('surfaces degraded projection health', () => {
    render(
      <GraphView
        summary={{ state: 'ready', data: { ...observed, projectionHealth: 'degraded' } }}
      />,
    );

    expect(within(rowOf('Projection health')).getByText('degraded')).toBeTruthy();
  });

  it('sorts kinds by magnitude and scales each bar against the largest', () => {
    render(<GraphView summary={{ state: 'ready', data: observed }} />);

    const kinds = within(screen.getByRole('region', { name: /nodes by kind/i }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent);
    expect(kinds).toEqual(['session', 'project']);

    const bar = (kind: string) =>
      within(rowOf(kind)).getByTestId('magnitude-bar').style.getPropertyValue('--magnitude');
    expect(bar('session')).toBe('100%');
    expect(bar('project')).toBe('40%');
  });

  it('scales against the largest count even when it is zero', () => {
    render(
      <GraphView
        summary={{
          state: 'ready',
          data: { ...observed, nodeCountsByKind: [{ kind: 'project', count: 0 }] },
        }}
      />,
    );

    expect(
      within(rowOf('project')).getByTestId('magnitude-bar').style.getPropertyValue('--magnitude'),
    ).toBe('0%');
  });

  it('renders unavailable when the summary could not be read', () => {
    render(<GraphView summary={{ state: 'unavailable' }} />);

    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('generation-1')).toBeNull();
  });
});
