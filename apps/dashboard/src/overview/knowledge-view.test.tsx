// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import { KnowledgeInspector, KnowledgeView } from './knowledge-view.js';

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
  { id: 'p1', name: 'Alpha', initials: 'AL' },
  { id: 'p2', name: 'Beta', initials: 'BE' },
];
const alpha = projects[0]!;

function lens(
  overrides: Partial<{
    project: (typeof projects)[number] | undefined;
    graph: Parameters<typeof KnowledgeView>[0]['graph'];
    selectedId: string;
  }> = {},
) {
  const onSelectNode = vi.fn();
  const onFocus = vi.fn();
  const project = 'project' in overrides ? overrides.project : alpha;
  const utils = render(
    <KnowledgeView
      projects={projects}
      {...(project === undefined ? {} : { project })}
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
    const { container } = lens({ project: undefined });
    render(
      <KnowledgeView
        projects={[]}
        emptyLabel="No registered projects"
        onSelectNode={vi.fn()}
        onFocus={vi.fn()}
      />,
    );
    expect(screen.getByText('No registered projects')).toBeTruthy();
    // With projects but none focused, the picker draws the projects themselves.
    expect(container.querySelectorAll('.knowledge__project')).toHaveLength(2);
  });

  it('focuses a project when its disc on the picker is clicked', () => {
    const { onFocus } = lens({ project: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Focus project Beta' }));
    expect(onFocus).toHaveBeenCalledWith({ kind: 'project', id: 'p2' });
  });

  it('shows a busy loading state while the read is in flight', () => {
    lens({ graph: { state: 'loading' } });
    expect(screen.getByText('Loading').getAttribute('aria-busy')).toBe('true');
    // The focused project sits at the centre and leads back to all projects.
    expect(screen.getByRole('button', { name: 'Back to all projects' })).toBeTruthy();
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

  it('draws a node per record and the legend figures, and carries no label on the node', () => {
    const { container } = lens({ graph: { state: 'ready', data: graph } });
    expect(container.querySelectorAll('.knowledge__node')).toHaveLength(2);
    expect(container.querySelectorAll('.knowledge__edge--import')).toHaveLength(1);
    const legend = container.querySelector('.knowledge__legend') as HTMLElement;
    expect(within(legend).getByText('communities')).toBeTruthy();
    expect(screen.getByText('abc123def456')).toBeTruthy();
    // Labels are gone from the canvas: a node shows its name only on hover.
    expect(container.querySelector('.knowledge__node-label')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows a hover tooltip with the node label and drops it on leave', () => {
    lens({ graph: { state: 'ready', data: graph } });
    const node = screen.getByRole('button', { name: 'Select god' });
    fireEvent.mouseEnter(node);
    const tip = screen.getByRole('tooltip');
    expect(within(tip).getByText('god')).toBeTruthy();
    expect(within(tip).getByText('src/g.ts')).toBeTruthy();
    fireEvent.mouseLeave(node);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('reports a node click as a selection and a background click as clearing it', () => {
    const { container, onSelectNode } = lens({ graph: { state: 'ready', data: graph } });
    fireEvent.click(screen.getByRole('button', { name: 'Select god' }));
    expect(onSelectNode).toHaveBeenLastCalledWith('g::god');
    fireEvent.click(container.querySelector('.knowledge__svg') as Element);
    expect(onSelectNode).toHaveBeenLastCalledWith(undefined);
  });

  it('marks a selection edge active and clears the selection on a re-click', () => {
    const { container, onSelectNode } = lens({
      graph: { state: 'ready', data: graph },
      selectedId: 'g::god',
    });
    expect(container.querySelector('.knowledge__edge--active')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select god' }));
    expect(onSelectNode).toHaveBeenLastCalledWith(undefined);
  });

  it('marks only the communities the endpoint named', () => {
    const wide: KnowledgeGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 'x::hub',
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
  });

  it('returns to all projects when the centre disc is clicked', () => {
    const { onFocus } = lens({ graph: { state: 'ready', data: graph } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to all projects' }));
    expect(onFocus).toHaveBeenCalledWith({ kind: 'runtime' });
  });
});

describe('KnowledgeInspector', () => {
  it('lists project cards in the no-project state and focuses one on click', () => {
    const onFocus = vi.fn();
    render(
      <KnowledgeInspector
        projects={[
          { id: 'p1', name: 'Alpha', initials: 'AL' },
          { id: 'p2', name: 'Beta', initials: 'BE' },
        ]}
        onSelectNode={vi.fn()}
        onFocus={onFocus}
      />,
    );
    expect(screen.getByText('NO PROJECT')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Beta knowledge graph' }));
    expect(onFocus).toHaveBeenCalledWith({ kind: 'project', id: 'p2' });
  });

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
