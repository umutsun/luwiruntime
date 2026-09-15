// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import { KnowledgeInspector, KnowledgeView, shortLabel } from './knowledge-view.js';

afterEach(cleanup);

const graph: KnowledgeGraph = {
  summary: {
    nodeCount: 2,
    edgeCount: 1,
    communityCount: 1,
    hubCount: 1,
    embeddings: 0,
    builtAtCommit: 'abc123def456789',
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

const projects = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: 'Beta' },
];

function lens(
  overrides: Partial<{
    projectId: string | undefined;
    graph: Parameters<typeof KnowledgeView>[0]['graph'];
    selectedId: string;
  }> = {},
) {
  const onSelectNode = vi.fn();
  const onFocus = vi.fn();
  const projectId = 'projectId' in overrides ? overrides.projectId : 'p1';
  const utils = render(
    <KnowledgeView
      projects={projects}
      {...(projectId === undefined ? {} : { projectId })}
      {...(overrides.graph === undefined ? {} : { graph: overrides.graph })}
      {...(overrides.selectedId === undefined ? {} : { selectedId: overrides.selectedId })}
      emptyLabel="No registered projects"
      onSelectNode={onSelectNode}
      onFocus={onFocus}
    />,
  );
  return { ...utils, onSelectNode, onFocus };
}

describe('KnowledgeView', () => {
  it('says why there is nothing to draw when the overview has no project', () => {
    lens({ projectId: undefined });
    expect(screen.getByText('No registered projects')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows a busy loading state while the read is in flight, with the switcher', () => {
    lens({ graph: { state: 'loading' } });
    expect(screen.getByText('Loading').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Knowledge graph project' })).toBeTruthy();
  });

  it('reports a failed read as unavailable, never as the empty state', () => {
    lens({ graph: { state: 'unavailable' } });
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText(/graphify build/i)).toBeNull();
  });

  it('tells the reader to run graphify build when the project has no output', () => {
    lens({ graph: { state: 'ready', data: empty } });
    expect(screen.getByText(/graphify build/i)).toBeTruthy();
  });

  it('draws a node per record, the legend figures and the provenance', () => {
    const { container } = lens({ graph: { state: 'ready', data: graph } });
    expect(container.querySelectorAll('.knowledge__node')).toHaveLength(2);
    expect(container.querySelectorAll('.knowledge__edge--import')).toHaveLength(1);
    const legend = container.querySelector('.knowledge__legend') as HTMLElement;
    expect(within(legend).getByText('communities')).toBeTruthy();
    expect(screen.getByText('abc123def456')).toBeTruthy();
    expect(screen.getByText(/what breaks if I change god/)).toBeTruthy();
    // A symbol is unlabelled until it is selected or a neighbour of the selection.
    expect(container.querySelectorAll('.knowledge__node-label')).toHaveLength(1);
  });

  it('marks only the communities the endpoint named and keeps the tail of a long label', () => {
    const wide: KnowledgeGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 'x::apps_dashboard_src_overview_knowledge_model',
          label: 'apps_dashboard_src_overview_knowledge_model',
          sourceFile: 'apps/dashboard/src/overview/knowledge-model.ts',
          community: 7,
          communityName: 'unnamed',
          kind: 'hub',
          degree: 2,
        },
      ],
    };
    const { container } = lens({ graph: { state: 'ready', data: wide } });
    // Community 7 anchors a ring position but is not in `communities`, so no mark.
    const marks = [...container.querySelectorAll('.knowledge__community-mark')];
    expect(marks.map((mark) => mark.textContent)).toEqual(['graph']);
    const short = shortLabel('apps_dashboard_src_overview_knowledge_model');
    expect(short).toBe('…verview_knowledge_model');
    expect(screen.getByText(short)).toBeTruthy();
    expect(shortLabel('short')).toBe('short');
  });

  it('reports a node click as a selection and a background click as clearing it', () => {
    const { container, onSelectNode } = lens({ graph: { state: 'ready', data: graph } });
    fireEvent.click(screen.getByRole('button', { name: 'Select god' }));
    expect(onSelectNode).toHaveBeenLastCalledWith('g::god');
    fireEvent.click(container.querySelector('.knowledge__svg') as Element);
    expect(onSelectNode).toHaveBeenLastCalledWith(undefined);
  });

  it('labels the neighbours of a selection and marks its edge active', () => {
    const { container, onSelectNode } = lens({
      graph: { state: 'ready', data: graph },
      selectedId: 'g::god',
    });
    expect(container.querySelectorAll('.knowledge__node-label')).toHaveLength(2);
    expect(container.querySelector('.knowledge__edge--active')).not.toBeNull();
    expect(screen.getByText(/path god/)).toBeTruthy();
    // Clicking the selected node again clears the selection.
    fireEvent.click(screen.getByRole('button', { name: 'Select god' }));
    expect(onSelectNode).toHaveBeenLastCalledWith(undefined);
  });

  it('reports the switcher as a project focus, so every lens follows it', () => {
    const { onFocus } = lens({ graph: { state: 'ready', data: graph } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Knowledge graph project' }), {
      target: { value: 'p2' },
    });
    expect(onFocus).toHaveBeenCalledWith({ kind: 'project', id: 'p2' });
  });
});

describe('KnowledgeInspector', () => {
  it('summarizes the project with its communities when nothing is selected', () => {
    render(
      <KnowledgeInspector
        projectName="Alpha"
        graph={{ state: 'ready', data: graph }}
        onSelectNode={vi.fn()}
      />,
    );
    const aside = screen.getByRole('complementary', { name: 'Knowledge inspector' });
    expect(within(aside).getByRole('heading', { name: 'Alpha' })).toBeTruthy();
    expect(within(aside).getByText('COMPLETE')).toBeTruthy();
    expect(within(aside).getByText('Communities')).toBeTruthy();
    expect(within(aside).getByText('God & hub nodes')).toBeTruthy();
  });

  it('describes the selected node and lets a connected row select the next', () => {
    const onSelectNode = vi.fn();
    render(
      <KnowledgeInspector
        projectName="Alpha"
        graph={{ state: 'ready', data: graph }}
        selectedId="g::god"
        onSelectNode={onSelectNode}
      />,
    );
    const aside = screen.getByRole('complementary', { name: 'Knowledge inspector' });
    expect(within(aside).getByText('GOD')).toBeTruthy();
    expect(within(aside).getByText('Degree')).toBeTruthy();
    fireEvent.click(within(aside).getByRole('button', { name: 'Select leaf' }));
    expect(onSelectNode).toHaveBeenCalledWith('g::leaf');
  });

  it('names the read state before the graph is ready, in the lens words', () => {
    const { rerender } = render(<KnowledgeInspector onSelectNode={vi.fn()} />);
    expect(screen.getByText('NO PROJECT')).toBeTruthy();
    rerender(
      <KnowledgeInspector
        projectName="Alpha"
        graph={{ state: 'loading' }}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText('LOADING')).toBeTruthy();
    rerender(
      <KnowledgeInspector
        projectName="Alpha"
        graph={{ state: 'unavailable' }}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText('UNAVAILABLE')).toBeTruthy();
    rerender(
      <KnowledgeInspector
        projectName="Alpha"
        graph={{ state: 'ready', data: empty }}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText('NO OUTPUT')).toBeTruthy();
  });
});
