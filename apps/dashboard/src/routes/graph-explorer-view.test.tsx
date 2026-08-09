// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GraphRoot, Subgraph, SubgraphBounds } from '../api/graph-explorer.js';
import { GraphExplorerView, type GraphSeed } from './graph-explorer-view.js';

afterEach(cleanup);

const seeds: GraphSeed[] = [
  { kind: 'project', id: 'p1', label: 'Alpha' },
  { kind: 'project', id: 'p2', label: 'Beta' },
  { kind: 'session', id: 's1', label: 'codex · Alpha' },
];

const subgraph: Subgraph = {
  truncated: false,
  nodes: [
    {
      id: 'p1',
      kind: 'project',
      label: 'Alpha',
      confidence: 'high',
      provenance: 'project-projection',
      structural: false,
    },
    {
      id: 'module-abc',
      kind: 'module',
      label: 'packages/redis',
      confidence: 'high',
      provenance: 'code-structure-observer@1',
      structural: true,
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'p1',
      target: 'module-abc',
      kind: 'PROJECT_HAS_MODULE',
      confidence: 'medium',
      provenance: 'code-structure-observer@1',
      structural: true,
    },
  ],
};

function loaderFor(result: Subgraph) {
  return vi.fn(
    async (
      root: GraphRoot,
      bounds: SubgraphBounds,
      options?: { signal?: AbortSignal },
    ): Promise<{ state: 'ready'; data: Subgraph }> => {
      void root;
      void bounds;
      void options;
      return { state: 'ready', data: result };
    },
  );
}

describe('GraphExplorerView', () => {
  it('says what it needs when no root can be seeded', () => {
    render(<GraphExplorerView seeds={[]} loadSubgraph={loaderFor(subgraph)} />);

    expect(screen.getByText(/no project, session, or agent/i)).toBeTruthy();
  });

  it('loads the first seed as the root and renders its nodes and edges', async () => {
    const load = loaderFor(subgraph);
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);

    await waitFor(() => {
      expect(screen.getByRole('img', { name: /bounded subgraph/i })).toBeTruthy();
    });
    expect(load.mock.calls[0]?.[0]).toMatchObject({ kind: 'project', id: 'p1' });

    const nodeTable = screen.getByRole('region', { name: /nodes in view/i });
    expect(within(nodeTable).getByText('packages/redis')).toBeTruthy();
    const edgeTable = screen.getByRole('region', { name: /edges in view/i });
    expect(within(edgeTable).getByText('PROJECT_HAS_MODULE')).toBeTruthy();
  });

  it('re-roots on a node from the table and reloads at the new root', async () => {
    const load = loaderFor(subgraph);
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Explore from packages/redis' }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[0]).toMatchObject({ kind: 'module', id: 'module-abc' });
  });

  it('reloads when the depth bound changes', async () => {
    const load = loaderFor(subgraph);
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Depth'), { target: { value: '4' } });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[1]).toMatchObject({ maxDepth: 4 });
  });

  it('states truncation and names the bound that produced it', async () => {
    const load = loaderFor({ ...subgraph, truncated: true });
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);

    await waitFor(() => {
      expect(screen.getByText(/reached the 250-node limit/i)).toBeTruthy();
    });
  });

  it('does not claim truncation when the read was complete', async () => {
    render(<GraphExplorerView seeds={seeds} loadSubgraph={loaderFor(subgraph)} />);

    await waitFor(() => expect(screen.getByRole('img', { name: /bounded/i })).toBeTruthy());
    // Scoped to the notice: "Node limit" is a permanent control label.
    expect(screen.queryByText(/is incomplete/i)).toBeNull();
    expect(screen.queryByText(/reached the/i)).toBeNull();
  });

  it('reports a failed read as unavailable rather than as an empty graph', async () => {
    const load = vi.fn(async () => ({ state: 'unavailable' as const }));
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeTruthy());
    expect(screen.queryByRole('img', { name: /bounded subgraph/i })).toBeNull();
  });

  it('separates an empty result from a failed one', async () => {
    const load = loaderFor({ nodes: [], edges: [], truncated: false });
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);

    await waitFor(() => expect(screen.getByText(/no relationships/i)).toBeTruthy());
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('legends only the kinds actually present, and names the confidence styles', async () => {
    render(<GraphExplorerView seeds={seeds} loadSubgraph={loaderFor(subgraph)} />);
    await waitFor(() => expect(screen.getByRole('img', { name: /bounded/i })).toBeTruthy());

    const legend = screen.getByRole('region', { name: /legend/i });
    expect(within(legend).getByText('project')).toBeTruthy();
    expect(within(legend).getByText('module')).toBeTruthy();
    expect(within(legend).queryByText('commit')).toBeNull();
    expect(within(legend).getByText(/code structure/i)).toBeTruthy();
  });

  it('names each edge confidence in text, never by line style alone', async () => {
    render(<GraphExplorerView seeds={seeds} loadSubgraph={loaderFor(subgraph)} />);

    await waitFor(() => {
      const edgeTable = screen.getByRole('region', { name: /edges in view/i });
      expect(within(edgeTable).getByText('Medium')).toBeTruthy();
    });
  });

  it('never offers a rebuild control from a read surface', async () => {
    render(<GraphExplorerView seeds={seeds} loadSubgraph={loaderFor(subgraph)} />);
    await waitFor(() => expect(screen.getByRole('img', { name: /bounded/i })).toBeTruthy());

    expect(screen.queryByRole('button', { name: /rebuild/i })).toBeNull();
  });
});
