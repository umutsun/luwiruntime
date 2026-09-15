// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import { KnowledgeView } from './knowledge-view.js';

afterEach(cleanup);

const graph: KnowledgeGraph = {
  summary: {
    nodeCount: 2,
    edgeCount: 1,
    communityCount: 1,
    hubCount: 1,
    embeddings: 0,
    builtAtCommit: 'abc123',
    observedAt: '2026-09-15T00:00:00.000Z',
    truncated: false,
  },
  communities: [{ id: 0, name: 'graph', size: 2 }],
  nodes: [
    {
      id: 'g::god',
      label: 'god',
      sourceFile: 'src/g.ts',
      community: 0,
      communityName: 'graph',
      kind: 'god',
      degree: 1,
    },
    {
      id: 'g::leaf',
      label: 'leaf',
      sourceFile: 'src/l.ts',
      community: 0,
      communityName: 'graph',
      kind: 'symbol',
      degree: 1,
    },
  ],
  edges: [{ source: 'g::god', target: 'g::leaf', kind: 'import' }],
};

const empty: KnowledgeGraph = {
  summary: {
    nodeCount: 0,
    edgeCount: 0,
    communityCount: 0,
    hubCount: 0,
    embeddings: 0,
    truncated: false,
  },
  communities: [],
  nodes: [],
  edges: [],
};

describe('KnowledgeView', () => {
  it('renders the stat strip from the summary', () => {
    const { container } = render(
      <KnowledgeView graph={{ state: 'ready', data: graph }} projectId="p1" projects={[]} />,
    );
    const stats = container.querySelector('.knowledge__stats');
    expect(stats).not.toBeNull();
    expect(within(stats as HTMLElement).getByText('2')).toBeTruthy();
    expect(within(stats as HTMLElement).getByText('nodes')).toBeTruthy();
    expect(screen.queryByText(/graphify build/i)).toBeNull();
  });

  it('shows the empty state when the project has no graphify output', () => {
    render(<KnowledgeView graph={{ state: 'ready', data: empty }} projectId="p1" projects={[]} />);
    expect(screen.getByText(/graphify build/i)).toBeTruthy();
  });

  it('asks the reader to pick a project when the route carries none', () => {
    render(<KnowledgeView projects={[{ id: 'p1', name: 'Alpha' }]} />);
    expect(screen.getByText(/pick a project/i)).toBeTruthy();
  });

  it('reports a failed read as unavailable, never as the empty state', () => {
    render(<KnowledgeView graph={{ state: 'unavailable' }} projectId="p1" projects={[]} />);
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText(/graphify build/i)).toBeNull();
  });

  it('shows a busy loading state while the read is still in flight', () => {
    render(<KnowledgeView loading projectId="p1" projects={[]} />);
    expect(screen.getByText('Loading')).toBeTruthy();
  });

  it('selects a node on click and shows its detail in the docked inspector', () => {
    const { container } = render(
      <KnowledgeView graph={{ state: 'ready', data: graph }} projectId="p1" projects={[]} />,
    );
    const svg = container.querySelector('.knowledge__svg') as HTMLElement;
    fireEvent.click(within(svg).getByText('god'));

    expect(screen.getByText('GOD')).toBeTruthy();
    expect(screen.getByText('Degree')).toBeTruthy();
  });

  it('calls onSelectProject when the switcher is changed', () => {
    const onSelectProject = vi.fn();
    render(
      <KnowledgeView
        graph={{ state: 'ready', data: graph }}
        projectId="p1"
        projects={[
          { id: 'p1', name: 'Alpha' },
          { id: 'p2', name: 'Beta' },
        ]}
        onSelectProject={onSelectProject}
      />,
    );
    fireEvent.change(screen.getByDisplayValue('Alpha'), { target: { value: 'p2' } });
    expect(onSelectProject).toHaveBeenCalledWith('p2');
  });
});
