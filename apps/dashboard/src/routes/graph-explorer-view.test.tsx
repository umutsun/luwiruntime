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

  it('adopts a root when seeds arrive after mount', async () => {
    // Reproduces the reload-on-#/graph path: the explorer mounts while the
    // Pulse snapshot is still empty, so the first render has no seed to take.
    // Seeding the root only once left it undefined forever, and the view sat
    // on its busy state with no way out but the Root select.
    const load = loaderFor(subgraph);
    const { rerender } = render(<GraphExplorerView seeds={[]} loadSubgraph={load} />);
    expect(load).not.toHaveBeenCalled();

    rerender(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load.mock.calls[0]?.[0]).toMatchObject({ kind: 'project', id: 'p1' });
    expect(screen.queryByText(/reading the bounded subgraph/i)).toBeNull();
  });

  it('does not reload when a new seed array carries the same first root', async () => {
    // `graphSeedsOf` rebuilds the array on every snapshot refresh. Re-syncing
    // unconditionally would turn each refresh into another subgraph request.
    const load = loaderFor(subgraph);
    const { rerender } = render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    rerender(<GraphExplorerView seeds={seeds.map((seed) => ({ ...seed }))} loadSubgraph={load} />);

    await waitFor(() => expect(screen.getByRole('img', { name: /bounded/i })).toBeTruthy());
    expect(load).toHaveBeenCalledTimes(1);
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

  it('re-roots from the Root select and reloads at the chosen seed', async () => {
    // The select packs kind and id into one option value separated by U+0000,
    // which cannot occur in an identifier. This is the only test that round-
    // trips that encoding, so a change to the separator fails here rather than
    // silently making every re-root a no-op.
    const load = loaderFor(subgraph);
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Root'), { target: { value: 'session\u0000s1' } });

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[0]).toMatchObject({ kind: 'session', id: 's1' });
  });

  it('ignores a Root value that names no seed', async () => {
    const load = loaderFor(subgraph);
    render(<GraphExplorerView seeds={seeds} loadSubgraph={load} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Root'), { target: { value: 'project\u0000ghost' } });

    await waitFor(() => expect(screen.getByRole('img', { name: /bounded/i })).toBeTruthy());
    expect(load).toHaveBeenCalledTimes(1);
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

    // A segmented group: every bound is visible and the pressed one is current.
    const depth = screen.getByRole('group', { name: 'Depth' });
    expect(within(depth).getByRole('button', { name: '2' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(depth).getByRole('button', { name: '4' }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load.mock.calls[1]?.[1]).toMatchObject({ maxDepth: 4 });
    expect(within(depth).getByRole('button', { name: '4' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    const limit = screen.getByRole('group', { name: 'Node limit' });
    fireEvent.click(within(limit).getByRole('button', { name: '1000' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(load.mock.calls[2]?.[1]).toMatchObject({ maxDepth: 4, nodeLimit: 1000 });
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

  it('names graphify output as its own origin, in the tables and the legend (ADR 0029)', async () => {
    const graphify: Subgraph = {
      truncated: false,
      nodes: [
        {
          id: 'file-1',
          kind: 'file',
          label: 'lib/legacy.php',
          confidence: 'high',
          provenance: 'graphify-graph-json@1',
          structural: true,
        },
        {
          id: 'file-2',
          kind: 'file',
          label: 'src/a.ts',
          confidence: 'high',
          provenance: 'graphify-graph-json@1',
          structural: true,
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'file-1',
          target: 'file-2',
          kind: 'FILE_IMPORTS_FILE',
          confidence: 'medium',
          provenance: 'graphify-graph-json@1',
          structural: true,
        },
      ],
    };
    render(<GraphExplorerView seeds={seeds} loadSubgraph={loaderFor(graphify)} />);
    await waitFor(() => expect(screen.getByRole('img', { name: /bounded/i })).toBeTruthy());

    const legend = screen.getByRole('region', { name: /legend/i });
    expect(within(legend).getByText(/graphify output/i)).toBeTruthy();
    // Only the sources actually present are explained.
    expect(within(legend).queryByText(/code structure/i)).toBeNull();
    const edgeTable = screen.getByRole('region', { name: /edges in view/i });
    expect(within(edgeTable).getByText('Graphify output')).toBeTruthy();
    const nodeTable = screen.getByRole('region', { name: /nodes in view/i });
    expect(within(nodeTable).getAllByText('Graphify output')).toHaveLength(2);
  });
});
