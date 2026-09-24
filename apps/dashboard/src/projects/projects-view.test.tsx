// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapabilityMutations } from '../api/capability-mutations.js';
import type { ProjectMutations } from '../api/project-mutations.js';
import type { ProjectGit, ProjectScopeResources } from '../api/project-scope.js';
import { buildPulseSnapshot, type PulseInput } from '../pulse/model.js';
import { ProjectsView, commitUrl } from './projects-view.js';

afterEach(cleanup);

describe('commitUrl', () => {
  const sha = 'a'.repeat(40);
  it('builds a GitHub commit URL from an https remote, stripping .git', () => {
    expect(commitUrl('https://github.com/umutsun/luwi.git', sha)).toBe(
      `https://github.com/umutsun/luwi/commit/${sha}`,
    );
  });
  it('normalizes an scp-style remote to https', () => {
    expect(commitUrl('git@github.com:umutsun/luwi.git', sha)).toBe(
      `https://github.com/umutsun/luwi/commit/${sha}`,
    );
  });
  it('is undefined for a missing or non-http remote (the sha stays plain text)', () => {
    expect(commitUrl(undefined, sha)).toBeUndefined();
    expect(commitUrl('', sha)).toBeUndefined();
    expect(commitUrl('/local/only/path', sha)).toBeUndefined();
  });
});

/**
 * Evidence cards other than the repository start folded, so a test that reads
 * a card's contents opens it first — the way a reader would.
 */
function expand(panel: HTMLElement): HTMLElement {
  fireEvent.click(within(panel).getByRole('button', { expanded: false }));
  return panel;
}

const LONG_PATH = 'C:/xampp/htdocs/very/deep/nested/workspace/luwiruntime';

function snapshotOf(overrides: Partial<PulseInput> = {}) {
  const input: PulseInput = {
    measuredLatencyMs: 12,
    snapshotAt: '2026-08-08T00:00:00.000Z',
    health: { state: 'unavailable' },
    projects: {
      state: 'ready',
      data: [
        {
          id: 'proj-1',
          name: 'LUWI Runtime',
          localPath: LONG_PATH,
          repositoryUrl: 'https://github.com/umutsun/registered-luwi.git',
          defaultBranch: 'registered-main',
        },
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

const gitData: ProjectGit = {
  repositoryRoot: LONG_PATH,
  branch: 'master',
  headSha: 'b'.repeat(40),
  defaultBranch: 'main',
  remoteUrl: 'https://github.com/umutsun/luwiruntime.git',
  clean: false,
  stagedCount: 2,
  unstagedCount: 3,
  untrackedCount: 4,
  ahead: 1,
  behind: 0,
  branches: ['master', 'main'],
  tags: ['v1'],
  worktrees: [
    { path: 'C:/work/demo', headSha: 'd'.repeat(40), branch: 'master' },
    { path: 'C:/work/demo-wt', headSha: 'e'.repeat(40), detached: true, locked: true },
  ],
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
};

const readyScope: Partial<ProjectScopeResources> = {
  git: { state: 'ready', data: gitData },
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
  attributions: {
    state: 'ready',
    data: {
      truncated: true,
      items: [
        {
          id: 'attr-1',
          commitSha: 'c'.repeat(40),
          sessionId: 'sess-1',
          agentId: 'agent-1',
          confidence: 'correlated',
          reasons: ['session-window-overlap'],
          observedAt: '2026-08-08T00:00:00.000Z',
        },
        {
          id: 'attr-2',
          commitSha: 'f'.repeat(40),
          confidence: 'unknown',
          reasons: ['insufficient-session-correlation'],
          observedAt: '2026-08-08T00:00:00.000Z',
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
    // Scoped to the summary: `master` now also appears in the branch list and
    // in the worktree table, which are separate assertions below.
    expect(within(panel).getByText('master', { selector: 'dd' })).toBeTruthy();
    expect(within(panel).getByText('Observed default')).toBeTruthy();
    expect(within(panel).getByText('Observed remote')).toBeTruthy();
    expect(within(panel).getByText('Registered default')).toBeTruthy();
    expect(within(panel).getByText('Registered remote')).toBeTruthy();
    expect(within(panel).getByText('main', { selector: 'dd' })).toBeTruthy();
    expect(within(panel).getByText('https://github.com/umutsun/luwiruntime.git')).toBeTruthy();
    expect(within(panel).getByTitle('b'.repeat(40))).toBeTruthy();
    expect(within(panel).getByText('1 ahead / 0 behind')).toBeTruthy();
    expect(within(panel).getByText(/2 staged/i)).toBeTruthy();
    expect(within(panel).getByText(/3 unstaged/i)).toBeTruthy();
    expect(within(panel).getByText(/4 untracked/i)).toBeTruthy();
  });

  it('labels registered repository metadata separately when Git does not report it', () => {
    const gitWithoutRegistryFacts = { ...gitData };
    delete gitWithoutRegistryFacts.defaultBranch;
    delete gitWithoutRegistryFacts.remoteUrl;

    renderView({
      selectedProjectId: 'proj-1',
      resources: { ...readyScope, git: { state: 'ready', data: gitWithoutRegistryFacts } },
    });

    const panel = screen.getByRole('region', { name: /repository/i });
    const observedDefault = within(panel).getByText('Observed default').closest('div');
    const observedRemote = within(panel).getByText('Observed remote').closest('div');
    const registeredDefault = within(panel).getByText('Registered default').closest('div');
    const registeredRemote = within(panel).getByText('Registered remote').closest('div');
    expect(within(observedDefault as HTMLElement).getByText('Not reported')).toBeTruthy();
    expect(within(observedRemote as HTMLElement).getByText('Not reported')).toBeTruthy();
    expect(within(registeredDefault as HTMLElement).getByText('registered-main')).toBeTruthy();
    expect(
      within(registeredRemote as HTMLElement).getByText(
        'https://github.com/umutsun/registered-luwi.git',
      ),
    ).toBeTruthy();
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

  it('labels each observed collection so two adjacent lists cannot be confused', () => {
    // Rendered unlabelled, the branch and tag lists are two identical rows of
    // pills and a reader cannot tell which is which. The count travels with the
    // label rather than sitting in a separate summary grid.
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /repository/i });
    for (const [label, count] of [
      ['Branches', '2'],
      ['Tags', '1'],
      ['Worktrees', '2'],
    ] as const) {
      const group = within(panel).getByText(label).closest('.group-label');
      expect(group, `${label} has no labelled group`).toBeTruthy();
      expect(within(group as HTMLElement).getByText(count)).toBeTruthy();
    }
    expect(within(panel).getByText('master', { selector: 'li' })).toBeTruthy();
    expect(within(panel).getByText('v1', { selector: 'li' })).toBeTruthy();
  });

  it('renders an observed empty collection as empty rather than hiding it', () => {
    renderView({
      selectedProjectId: 'proj-1',
      resources: {
        ...readyScope,
        git: { state: 'ready', data: { ...gitData, tags: [], worktrees: [] } },
      },
    });

    const panel = screen.getByRole('region', { name: /repository/i });
    const tags = within(panel).getByText('Tags').closest('.group-label');
    expect(within(tags as HTMLElement).getByText('0')).toBeTruthy();
    expect(within(panel).getByText(/no tags recorded/i)).toBeTruthy();
    expect(within(panel).getByText(/no worktrees recorded/i)).toBeTruthy();
  });

  it('names each worktree with its head and its detached and locked state', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /repository/i });
    const worktrees = within(panel).getByRole('table', { name: /worktrees/i });
    expect(within(worktrees).getByTitle('C:/work/demo-wt')).toBeTruthy();
    expect(within(worktrees).getByTitle('e'.repeat(40))).toBeTruthy();
    expect(within(worktrees).getByText('Detached')).toBeTruthy();
    expect(within(worktrees).getByText('Locked')).toBeTruthy();
  });

  it('bounds a long branch list and says so as a display bound, not a read bound', () => {
    const branches = Array.from({ length: 40 }, (_, index) => `feature/${String(index)}`);
    renderView({
      selectedProjectId: 'proj-1',
      resources: {
        ...readyScope,
        git: { state: 'ready', data: { ...gitData, branches } },
      },
    });

    const panel = screen.getByRole('region', { name: /repository/i });
    expect(within(panel).getByText('feature/24', { selector: 'li' })).toBeTruthy();
    expect(within(panel).queryByText('feature/25', { selector: 'li' })).toBeNull();
    expect(within(panel).getByText(/showing the first 25 of 40 branches/i)).toBeTruthy();
  });

  it('does not claim a display bound when every branch is shown', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = screen.getByRole('region', { name: /repository/i });
    expect(within(panel).queryByText(/showing the first/i)).toBeNull();
  });

  it('renders commit attribution with the agent and session it was tied to', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = expand(screen.getByRole('region', { name: /commit attribution/i }));
    expect(within(panel).getByTitle('c'.repeat(40))).toBeTruthy();
    expect(within(panel).getByText(/agent-1/)).toBeTruthy();
    expect(within(panel).getByText('Correlated')).toBeTruthy();
    expect(within(panel).getByText('session-window-overlap')).toBeTruthy();
  });

  it('says a commit is unattributed rather than leaving the cell blank', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = expand(screen.getByRole('region', { name: /commit attribution/i }));
    expect(within(panel).getByText('Unattributed')).toBeTruthy();
    expect(within(panel).getByText('Unknown')).toBeTruthy();
    expect(within(panel).getByText('insufficient-session-correlation')).toBeTruthy();
  });

  it('discloses that a bounded attribution list is truncated', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = expand(screen.getByRole('region', { name: /commit attribution/i }));
    expect(within(panel).getByText(/more attributions exist/i)).toBeTruthy();
  });

  it('separates no attribution recorded from an unavailable attribution read', () => {
    renderView({
      selectedProjectId: 'proj-1',
      resources: {
        ...readyScope,
        attributions: { state: 'ready', data: { items: [], truncated: false } },
      },
    });
    const empty = expand(screen.getByRole('region', { name: /commit attribution/i }));
    expect(within(empty).getByText(/no commit attribution recorded/i)).toBeTruthy();
    expect(within(empty).queryByText('Unavailable')).toBeNull();

    cleanup();
    renderView({
      selectedProjectId: 'proj-1',
      resources: { ...readyScope, attributions: { state: 'unavailable' } },
    });
    const failed = expand(screen.getByRole('region', { name: /commit attribution/i }));
    expect(within(failed).getByText('Unavailable')).toBeTruthy();
    expect(within(failed).queryByText(/no commit attribution recorded/i)).toBeNull();
  });

  it('discloses that a bounded package list is truncated', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = expand(screen.getByRole('region', { name: /packages/i }));
    expect(within(panel).getByText(/bounded|truncated|more/i)).toBeTruthy();
  });

  it('does not claim truncation when the list is complete', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = expand(screen.getByRole('region', { name: /technologies/i }));
    expect(within(panel).queryByText(/truncated/i)).toBeNull();
  });

  it('labels every confidence tier as text, including unknown', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    const panel = expand(screen.getByRole('region', { name: /technologies/i }));
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

    // Sessions sit high in the drawer and open by default now (the owner's ask),
    // so the panel is read directly rather than expanded.
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

describe('ProjectsView agent pair', () => {
  const pair = {
    effectiveConfig: {
      state: 'ready' as const,
      data: {
        agentKind: 'codex',
        valid: false,
        capabilities: [
          {
            id: 'cap-review',
            name: 'Code review',
            kind: 'skill',
            scope: 'global' as const,
            enabled: true,
          },
          {
            id: 'cap-migrate',
            name: 'Schema migration',
            kind: 'plugin',
            scope: 'project' as const,
            enabled: true,
          },
        ],
        profileIds: ['profile-reviewer'],
        conflicts: [
          {
            code: 'CAPABILITY_INCOMPATIBLE',
            message: 'Not supported by this adapter.',
            capabilityId: 'cap-migrate',
          },
        ],
        missingDependencies: [],
        unsupportedCapabilities: ['cap-migrate'],
        nativeCapabilitySupport: [
          { capabilityId: 'cap-review', capabilityKind: 'skill', supportLevel: 'full' as const },
        ],
        provenanceCount: 3,
        estimatedTokens: 602,
      },
    },
    contextSummary: {
      state: 'ready' as const,
      data: {
        contributionCount: 6,
        assignedCount: 4,
        effectiveCount: 3,
        observedLoadedCount: 2,
        observedInvokedCount: 1,
        unknownLoadedCount: 2,
        measuredAt: '2026-08-10T00:00:00.000Z',
      },
    },
    contextFootprint: {
      state: 'ready' as const,
      data: {
        totalBytes: 4200,
        totalLines: 120,
        estimatedTokens: 602,
        categories: [
          { name: 'skill', bytes: 3000, lines: 90, estimatedTokens: 480, sourceCount: 2 },
        ],
        exactDuplicateGroups: [['context:a', 'context:b']],
        measuredAt: '2026-08-10T00:00:00.000Z',
      },
    },
  };

  function pairView(extra: Record<string, unknown> = {}) {
    return renderView({
      selectedProjectId: 'proj-1',
      selectedAgentId: 'agent-1',
      resources: readyScope,
      agentPairResources: pair,
      ...extra,
    });
  }

  it('renders no pair panel until an agent is selected', () => {
    renderView({ selectedProjectId: 'proj-1', resources: readyScope });

    expect(screen.queryByRole('region', { name: /effective configuration/i })).toBeNull();
  });

  it('selects the agent through its identifier', () => {
    const onSelectAgent = vi.fn();
    renderView({ selectedProjectId: 'proj-1', resources: readyScope, onSelectAgent });

    fireEvent.click(screen.getByRole('button', { name: 'agent-1' }));

    expect(onSelectAgent).toHaveBeenCalledWith('agent-1');
  });

  it('reports an unresolved configuration rather than hiding it', () => {
    pairView();

    const panel = screen.getByRole('region', { name: /effective configuration/i });
    expect(within(panel).getByText('Unresolved')).toBeTruthy();
    expect(within(panel).getByText('Not supported by this adapter.')).toBeTruthy();
    expect(within(panel).getByText('Not usable by this agent')).toBeTruthy();
  });

  it('says a capability has no reported native support instead of implying none', () => {
    pairView();

    const panel = screen.getByRole('region', { name: /effective configuration/i });
    expect(within(panel).getByText('Not reported')).toBeTruthy();
  });

  it('renders the pair context counts as six independent observations', () => {
    pairView();

    const panel = expand(screen.getByRole('region', { name: /context for this pair/i }));
    for (const label of [
      'Contributions',
      'Assigned',
      'Effective',
      'Loaded',
      'Invoked',
      'Unknown',
    ]) {
      expect(within(panel).getByText(label)).toBeTruthy();
    }
    expect(within(panel).getByText(/not stages of one pipeline/i)).toBeTruthy();
  });

  it('labels footprint tokens as estimates and lists byte-identical groups', () => {
    pairView();

    const panel = expand(screen.getByRole('region', { name: /context footprint/i }));
    expect(within(panel).getByText(/generic character estimates/i)).toBeTruthy();
    expect(within(panel).getByText('context:a = context:b')).toBeTruthy();
  });

  it('reports an unavailable pair read as unavailable, not as an empty configuration', () => {
    pairView({
      agentPairResources: { ...pair, effectiveConfig: { state: 'unavailable' as const } },
    });

    const panel = screen.getByRole('region', { name: /effective configuration/i });
    expect(within(panel).getByText('Unavailable')).toBeTruthy();
  });

  it('shows the pair reads as loading rather than as faults while in flight', () => {
    pairView({ agentPairResources: {}, agentPairLoading: true });

    const panel = screen.getByRole('region', { name: /effective configuration/i });
    expect(within(panel).getByText(/loading/i)).toBeTruthy();
    expect(within(panel).queryByText('Unavailable')).toBeNull();
  });
});

describe('ProjectDetail skills and optimization', () => {
  const finding = (id: string, projectId: string, title: string) => ({
    id,
    projectId,
    kind: 'context-bloat',
    title,
    summary: `${title} — summary`,
    state: 'open' as const,
    confidence: 'high' as const,
    sessionCount: 3,
    observationCount: 12,
    updatedAt: '2026-09-11T00:00:00.000Z',
  });

  it('lists the project-scoped capabilities with where each file lives, and only this project’s findings', () => {
    renderView({
      selectedProjectId: 'proj-1',
      snapshot: snapshotOf({
        findings: {
          state: 'ready',
          data: [
            finding('f-1', 'proj-1', 'Unused skill loaded'),
            finding('f-2', 'proj-2', 'Elsewhere'),
          ],
        },
      }),
      resources: {
        ...readyScope,
        capabilities: {
          state: 'ready',
          data: {
            truncated: false,
            items: [
              {
                id: 'cap-1',
                kind: 'skill',
                name: 'release-notes',
                scope: 'project' as const,
                source: 'luwi-project',
                path: 'C:/work/demo/.claude/skills/release-notes/SKILL.md',
                enabled: true,
                observed: true,
                updatedAt: '2026-09-11T00:00:00.000Z',
              },
            ],
          },
        },
      },
    });

    const skills = screen.getByRole('region', { name: /^skills/i });
    expect(within(skills).getByText('release-notes')).toBeTruthy();
    expect(
      within(skills).getByTitle('C:/work/demo/.claude/skills/release-notes/SKILL.md'),
    ).toBeTruthy();
    expect(within(skills).getByText('luwi-project · observed')).toBeTruthy();

    const optimization = screen.getByRole('region', { name: /^optimization/i });
    expect(within(optimization).getByText('Unused skill loaded')).toBeTruthy();
    expect(within(optimization).queryByText('Elsewhere')).toBeNull();
    expect(
      within(optimization)
        .getByRole('link', { name: 'All findings and proposals ›' })
        .getAttribute('href'),
    ).toBe('#/optimization');
    expect(
      within(optimization)
        .getByRole('link', { name: 'Configuration plans ›' })
        .getAttribute('href'),
    ).toBe('#/config');
  });

  it('says when no capability was registered for the project rather than showing nothing', () => {
    renderView({
      selectedProjectId: 'proj-1',
      resources: {
        ...readyScope,
        capabilities: { state: 'ready', data: { truncated: false, items: [] } },
      },
    });
    const skills = screen.getByRole('region', { name: /^skills/i });
    expect(within(skills).getByText(/no capabilities recorded/i)).toBeTruthy();
  });
});

describe('ProjectDetail writes (ADR 0036)', () => {
  const ok = <T,>(data: T) => ({ state: 'ok' as const, httpStatus: 200, data });
  const skill = (id: string, name: string, observed: boolean, enabled: boolean) => ({
    id,
    kind: 'skill',
    name,
    scope: 'project' as const,
    source: 'luwi-project',
    enabled,
    observed,
    updatedAt: '2026-09-17T00:00:00.000Z',
  });
  const binding = {
    id: 'bind-1',
    agentId: 'agent-1',
    enabled: true,
    role: 'backend/infra',
    flowRoles: ['verifier' as const],
    profileCount: 0,
    capabilityCount: 0,
    updatedAt: '2026-09-17T00:00:00.000Z',
  };

  it('shows the free-text role and the flow-role chips, and toggles a flow role through the project module', async () => {
    const updateAgentBinding = vi.fn().mockResolvedValue(ok({}));
    const onMutated = vi.fn();
    renderView({
      selectedProjectId: 'proj-1',
      resources: { ...readyScope, bindings: { state: 'ready', data: [binding] } },
      projectMutations: { updateAgentBinding } as unknown as ProjectMutations,
      onMutated,
    });

    const agents = screen.getByRole('region', { name: /^bound agents/i });
    expect(within(agents).getByTitle('backend/infra')).toBeTruthy();
    expect(within(agents).getByText('verifier')).toBeTruthy();

    fireEvent.click(
      within(agents).getByRole('button', { name: 'Set implementer role for agent-1' }),
    );
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    expect(updateAgentBinding).toHaveBeenCalledWith('proj-1', 'bind-1', {
      flowRoles: ['verifier', 'implementer'],
    });
    expect(screen.getByText('agent-1: verifier + implementer.')).toBeTruthy();

    fireEvent.click(
      within(agents).getByRole('button', { name: 'Unset verifier role for agent-1' }),
    );
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(2));
    expect(updateAgentBinding).toHaveBeenLastCalledWith('proj-1', 'bind-1', { flowRoles: [] });
  });

  it('stays read-only without mutations: the roles are shown, no toggle or skill control is offered', () => {
    renderView({
      selectedProjectId: 'proj-1',
      resources: {
        ...readyScope,
        bindings: { state: 'ready', data: [binding] },
        capabilities: {
          state: 'ready',
          data: { truncated: false, items: [skill('cap-1', 'release-notes', false, true)] },
        },
      },
    });

    const agents = screen.getByRole('region', { name: /^bound agents/i });
    expect(within(agents).getByText('verifier')).toBeTruthy();
    expect(within(agents).queryByRole('button', { name: /role for agent-1$/ })).toBeNull();
    const skills = screen.getByRole('region', { name: /^skills/i });
    // The panel is foldable now, so its header carries a collapse toggle; what
    // must be absent without capabilityMutations is any mutation control.
    expect(
      within(skills).queryByRole('button', { name: /rescan|enable|disable|assign|unassign/i }),
    ).toBeNull();
  });

  it('offers enable, assign and unassign on a skill row for the selected agent, hides enable for an observed package, and shows a refusal in the daemon’s words', async () => {
    const capabilityMutations = {
      setEnabled: vi.fn().mockResolvedValue({
        state: 'failed',
        reason: 'http',
        httpStatus: 409,
        code: 'CAPABILITY_CONFLICT',
        message: 'The daemon said no.',
      }),
      assign: vi.fn().mockResolvedValue(ok({})),
      unassign: vi.fn().mockResolvedValue(ok({})),
      rescan: vi.fn().mockResolvedValue(ok({})),
    };
    const onMutated = vi.fn();
    renderView({
      selectedProjectId: 'proj-1',
      selectedAgentId: 'agent-1',
      resources: {
        ...readyScope,
        capabilities: {
          state: 'ready',
          data: {
            truncated: false,
            items: [
              skill('cap-1', 'release-notes', true, true),
              skill('cap-2', 'db-migrate', false, false),
            ],
          },
        },
      },
      capabilityMutations: capabilityMutations as unknown as CapabilityMutations,
      onMutated,
    });

    const skills = screen.getByRole('region', { name: /^skills/i });
    expect(within(skills).queryByRole('button', { name: 'Disable release-notes' })).toBeNull();
    expect(within(skills).getByRole('button', { name: 'Enable db-migrate' })).toBeTruthy();

    fireEvent.click(
      within(skills).getByRole('button', { name: 'Assign release-notes to agent-1' }),
    );
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    expect(capabilityMutations.assign).toHaveBeenCalledWith('cap-1', {
      projectId: 'proj-1',
      agentId: 'agent-1',
    });
    expect(screen.getByText('Assigned to agent-1.')).toBeTruthy();

    fireEvent.click(
      within(skills).getByRole('button', { name: 'Unassign db-migrate from agent-1' }),
    );
    await waitFor(() => expect(capabilityMutations.unassign).toHaveBeenCalledTimes(1));

    fireEvent.click(within(skills).getByRole('button', { name: 'Enable db-migrate' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The daemon said no.'));
    expect(capabilityMutations.setEnabled).toHaveBeenCalledWith('cap-2', true);

    fireEvent.click(within(skills).getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(capabilityMutations.rescan).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Capabilities rescanned.')).toBeTruthy();
  });

  it('targets the whole project when no agent is selected', async () => {
    const capabilityMutations = {
      setEnabled: vi.fn(),
      assign: vi.fn().mockResolvedValue(ok({})),
      unassign: vi.fn(),
      rescan: vi.fn(),
    };
    renderView({
      selectedProjectId: 'proj-1',
      resources: {
        ...readyScope,
        capabilities: {
          state: 'ready',
          data: { truncated: false, items: [skill('cap-1', 'release-notes', false, true)] },
        },
      },
      capabilityMutations: capabilityMutations as unknown as CapabilityMutations,
    });

    const skills = screen.getByRole('region', { name: /^skills/i });
    fireEvent.click(
      within(skills).getByRole('button', { name: 'Assign release-notes to project' }),
    );
    await waitFor(() => expect(capabilityMutations.assign).toHaveBeenCalledTimes(1));
    expect(capabilityMutations.assign).toHaveBeenCalledWith('cap-1', { projectId: 'proj-1' });
    expect(screen.getByText('Assigned to project.')).toBeTruthy();
  });
});
