// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectScopeResources } from '../api/project-scope.js';
import { buildPulseSnapshot, type PulseInput } from '../pulse/model.js';
import { ProjectsView } from './projects-view.js';

afterEach(cleanup);

const LONG_PATH = 'C:/xampp/htdocs/very/deep/nested/workspace/luwiruntime';

function snapshotOf(overrides: Partial<PulseInput> = {}) {
  const input: PulseInput = {
    measuredLatencyMs: 12,
    snapshotAt: '2026-08-08T00:00:00.000Z',
    health: { state: 'unavailable' },
    projects: {
      state: 'ready',
      data: [
        { id: 'proj-1', name: 'LUWI Runtime', localPath: LONG_PATH },
        { id: 'proj-2', name: 'Second', localPath: 'C:/work/second' },
      ],
    },
    sessions: {
      state: 'ready',
      data: [
        {
          id: 'sess-1',
          agentId: 'agent-1',
          projectId: 'proj-1',
          status: 'thinking',
          presence: 'online',
          startedAt: '2026-08-08T00:00:00.000Z',
          lastHeartbeatAt: '2026-08-08T00:00:00.000Z',
        },
        {
          id: 'sess-2',
          agentId: 'agent-2',
          projectId: 'proj-2',
          status: 'completed',
          presence: 'offline',
          startedAt: '2026-08-08T00:00:00.000Z',
          lastHeartbeatAt: '2026-08-08T00:00:00.000Z',
        },
      ],
    },
    agents: { state: 'ready', data: [] },
    usage: { state: 'unavailable' },
    context: { state: 'unavailable' },
    activity: { state: 'unavailable' },
    findings: { state: 'unavailable' },
    ...overrides,
  };
  return buildPulseSnapshot(input);
}

const readyScope: Partial<ProjectScopeResources> = {
  git: {
    state: 'ready',
    data: {
      repositoryRoot: LONG_PATH,
      branch: 'master',
      headSha: 'b'.repeat(40),
      defaultBranch: 'main',
      clean: false,
      stagedCount: 2,
      unstagedCount: 3,
      untrackedCount: 4,
      ahead: 1,
      behind: 0,
      worktreeCount: 1,
      branchCount: 2,
      tagCount: 1,
      recentCommits: [
        {
          sha: 'c'.repeat(40),
          committedAt: '2026-08-08T00:00:00.000Z',
          subject: 'first commit',
          authorIdentity: 'dev',
          changedPathCount: 3,
          merge: false,
        },
      ],
      observedAt: '2026-08-08T00:00:00.000Z',
    },
  },
  packages: {
    state: 'ready',
    data: {
      truncated: true,
      items: [
        {
          id: 'pkg-1',
          ecosystem: 'node',
          packageName: 'fastify',
          declaredVersion: '^5.10.0',
          dependencyType: 'production',
          direct: true,
          workspaceLocation: 'apps/daemon',
        },
      ],
    },
  },
  technologies: {
    state: 'ready',
    data: {
      truncated: false,
      items: [
        {
          id: 't1',
          name: 'TypeScript',
          category: 'language',
          confidence: 'high',
          evidenceCount: 2,
        },
        { id: 't2', name: 'Vite', category: 'build-tool', confidence: 'medium', evidenceCount: 1 },
        { id: 't3', name: 'Guess', category: 'framework', confidence: 'low', evidenceCount: 1 },
        {
          id: 't4',
          name: 'Mystery',
          category: 'database',
          confidence: 'unknown',
          evidenceCount: 1,
        },
      ],
    },
  },
  bindings: {
    state: 'ready',
    data: [
      {
        id: 'bind-1',
        agentId: 'agent-1',
        enabled: true,
        role: 'primary',
        profileCount: 1,
        capabilityCount: 3,
        updatedAt: '2026-08-08T00:00:00.000Z',
      },
    ],
  },
};

function renderView(props: Partial<React.ComponentProps<typeof ProjectsView>> = {}) {
  return render(
    <ProjectsView
      snapshot={snapshotOf()}
      scopeLoading={false}
      resources={{}}
      onSelectProject={vi.fn()}
      {...props}
    />,
  );
}

describe('ProjectsView list', () => {
  it('lists registered projects with an abbreviated path and a full accessible title', () => {
    renderView();

    const row = screen.getByRole('row', { name: /LUWI Runtime/ });
    expect(within(row).getByTitle(LONG_PATH)).toBeTruthy();
    expect(within(row).getByTitle(LONG_PATH).textContent).toContain('…');
  });

  it('shows active session counts derived from the snapshot', () => {
    renderView();

    const first = screen.getByRole('row', { name: /LUWI Runtime/ });
    const second = screen.getByRole('row', { name: /Second/ });
    expect(within(first).getByText('1')).toBeTruthy();
    expect(within(second).getByText('0')).toBeTruthy();
  });

  it('never renders lifecycle stage or release readiness', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    expect(screen.queryByText(/release/i)).toBeNull();
    expect(screen.queryByText(/^stage$/i)).toBeNull();
    expect(screen.queryByText(/readiness/i)).toBeNull();
  });

  it('reports unavailable project data instead of an empty list', () => {
    renderView({ snapshot: snapshotOf({ projects: { state: 'unavailable' } }) });

    expect(screen.getByText(/project data unavailable/i)).toBeTruthy();
  });

  it('reports an empty registry distinctly from unavailable', () => {
    renderView({ snapshot: snapshotOf({ projects: { state: 'ready', data: [] } }) });

    expect(screen.getByText(/no registered projects/i)).toBeTruthy();
    expect(screen.queryByText(/unavailable/i)).toBeNull();
  });

  it('selects a project when its row control is activated', () => {
    const onSelectProject = vi.fn();
    renderView({ onSelectProject });

    fireEvent.click(screen.getByRole('button', { name: /LUWI Runtime/ }));

    expect(onSelectProject).toHaveBeenCalledWith('proj-1');
  });

  it('marks the selected row for assistive technology', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const row = screen.getByRole('row', { name: /LUWI Runtime/ });
    expect(row.getAttribute('aria-selected')).toBe('true');
  });
});

describe('ProjectsView detail', () => {
  it('prompts for a selection when none is made', () => {
    renderView();

    expect(screen.getByText(/select a project/i)).toBeTruthy();
  });

  it('reports an unknown project id without rendering detail panels', () => {
    renderView({ selectedProjectId: 'missing', resources: readyScope });

    expect(screen.getByText(/not found/i)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /repository/i })).toBeNull();
  });

  it('renders repository state from the Git observation', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /repository/i });
    expect(within(panel).getByText('master')).toBeTruthy();
    expect(within(panel).getByTitle('b'.repeat(40))).toBeTruthy();
    expect(within(panel).getByText(/2 staged/i)).toBeTruthy();
    expect(within(panel).getByText(/3 unstaged/i)).toBeTruthy();
    expect(within(panel).getByText(/4 untracked/i)).toBeTruthy();
  });

  it('distinguishes a never-scanned repository from an unavailable one', () => {
    renderView({
      selectedProjectId: 'proj-1',
      resources: { ...readyScope, git: { state: 'not-observed' } },
    });

    const panel = screen.getByRole('region', { name: /repository/i });
    expect(within(panel).getByText(/not observed/i)).toBeTruthy();
    expect(within(panel).queryByText(/unavailable/i)).toBeNull();
  });

  it('reports an unavailable repository read as unavailable, not as unscanned', () => {
    renderView({
      selectedProjectId: 'proj-1',
      resources: { ...readyScope, git: { state: 'unavailable' } },
    });

    const panel = screen.getByRole('region', { name: /repository/i });
    expect(within(panel).getByText(/unavailable/i)).toBeTruthy();
    expect(within(panel).queryByText(/not observed/i)).toBeNull();
  });

  it('discloses that a bounded package list is truncated', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /packages/i });
    expect(within(panel).getByText(/bounded|truncated|more/i)).toBeTruthy();
  });

  it('does not claim truncation when the list is complete', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /technologies/i });
    expect(within(panel).queryByText(/truncated/i)).toBeNull();
  });

  it('labels every confidence tier as text, including unknown', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /technologies/i });
    for (const label of ['High', 'Medium', 'Low', 'Unknown']) {
      expect(within(panel).getByText(label)).toBeTruthy();
    }
  });

  it('renders bound agents with their enabled state', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /bound agents/i });
    expect(within(panel).getByText('agent-1')).toBeTruthy();
    expect(within(panel).getByText(/enabled/i)).toBeTruthy();
  });

  it('lists only the selected project sessions', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /sessions/i });
    expect(within(panel).getByText('sess-1')).toBeTruthy();
    expect(within(panel).queryByText('sess-2')).toBeNull();
  });

  it('shows a loading state while scoped resources are in flight', () => {
    renderView({ selectedProjectId: 'proj-1', scopeLoading: true, resources: {} });

    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('renders no mutation control anywhere', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/scan|apply|rebuild|delete|accept|reject/i);
    }
  });
});
