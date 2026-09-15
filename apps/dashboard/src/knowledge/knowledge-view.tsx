import { useEffect, useState } from 'react';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import type { ResourceState } from '../components/panel.js';
import { KnowledgeCanvas } from './knowledge-canvas.js';
import { KnowledgeInspector } from './knowledge-inspector.js';
import { knowledgePanel, layoutKnowledge } from './model.js';

type SwitcherProject = { id: string; name: string };

function ProjectSwitcher({
  projects,
  projectId,
  onSelectProject,
}: {
  projects: readonly SwitcherProject[];
  projectId?: string;
  onSelectProject?: (id: string) => void;
}) {
  return (
    <div className="knowledge__toolbar">
      <label className="knowledge__switcher">
        <span className="knowledge__switcher-label">PROJECT</span>
        <select
          className="knowledge__switcher-select"
          value={projectId ?? ''}
          onChange={(event) => onSelectProject?.(event.target.value)}
        >
          <option value="" disabled>
            Select a project
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function StatStrip({ summary }: { summary: KnowledgeGraph['summary'] }) {
  const stats: { label: string; value: number }[] = [
    { label: 'nodes', value: summary.nodeCount },
    { label: 'edges', value: summary.edgeCount },
    { label: 'communities', value: summary.communityCount },
    { label: 'hubs', value: summary.hubCount },
    { label: 'embeddings', value: summary.embeddings },
  ];
  return (
    <div className="knowledge__stats">
      {stats.map((stat) => (
        <div key={stat.label} className="knowledge__stat">
          <span className="knowledge__stat-value">{stat.value}</span>
          <span className="knowledge__stat-label">{stat.label}</span>
        </div>
      ))}
      <span className="knowledge__stats-spacer" />
      <div className="knowledge__legend">
        <span className="knowledge__legend-item">
          <span className="knowledge__legend-dot knowledge__legend-dot--god" aria-hidden="true" />
          god node
        </span>
        <span className="knowledge__legend-item">
          <span className="knowledge__legend-dot knowledge__legend-dot--hub" aria-hidden="true" />
          module hub
        </span>
        <span className="knowledge__legend-item">
          <span
            className="knowledge__legend-dot knowledge__legend-dot--symbol"
            aria-hidden="true"
          />
          symbol
        </span>
      </div>
    </div>
  );
}

/**
 * The per-project graphify knowledge graph, read-only.
 *
 * Five states, kept apart rather than collapsed into one another: no
 * `projectId` (a bookmarked bare `#/knowledge`) asks the reader to pick one;
 * `graph` undefined is a read still in flight; `graph.state !== 'ready'`
 * is a failed read — including an unknown project's 404, which is a fault,
 * not "this project has no graph"; a real, successful read with
 * `summary.nodeCount === 0` is the honest report that `graphify build` has
 * never run here; anything else renders the graph.
 */
export function KnowledgeView({
  graph,
  loading = false,
  projectId,
  projects,
  onSelectProject,
}: {
  graph?: ResourceState<KnowledgeGraph> | undefined;
  /** The on-demand knowledge-graph read has not returned yet. */
  loading?: boolean;
  projectId?: string;
  /** The project switcher's options — the same list the overview scope menu uses. */
  projects: readonly SwitcherProject[];
  onSelectProject?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  // A different project's graph shares no node ids with the last one, so a
  // selection surviving the switch would either select nothing or, worse,
  // the wrong node that happens to reuse the id.
  useEffect(() => setSelectedId(undefined), [projectId]);
  const onSelectNode = (id: string) =>
    setSelectedId((current) => (current === id ? undefined : id));

  const switcher = (
    <ProjectSwitcher
      projects={projects}
      {...(projectId === undefined ? {} : { projectId })}
      {...(onSelectProject === undefined ? {} : { onSelectProject })}
    />
  );

  if (projectId === undefined) {
    return (
      <div className="knowledge">
        {switcher}
        <p className="knowledge__status">Pick a project to view its knowledge graph.</p>
      </div>
    );
  }

  if (graph === undefined) {
    return (
      <div className="knowledge">
        {switcher}
        <p className="knowledge__status" aria-busy={loading}>
          Loading
        </p>
      </div>
    );
  }

  if (graph.state !== 'ready') {
    return (
      <div className="knowledge">
        {switcher}
        <p className="knowledge__status">Unavailable</p>
      </div>
    );
  }

  const data = graph.data;
  if (data.summary.nodeCount === 0) {
    return (
      <div className="knowledge">
        {switcher}
        <div className="knowledge__status">
          <p>This project has no graphify output yet.</p>
          <p>
            Run <code className="knowledge__code">graphify build</code> in this project. LUWI reads
            the result; it does not run it for you.
          </p>
        </div>
      </div>
    );
  }

  const laid = layoutKnowledge(data, selectedId);
  const panel = knowledgePanel(data, selectedId);
  const godLabel = data.nodes.find((node) => node.kind === 'god')?.label ?? data.nodes[0]?.label;

  return (
    <div className="knowledge">
      {switcher}
      <StatStrip summary={data.summary} />
      <div className="knowledge__body">
        <div className="knowledge__canvas-col">
          <div className="knowledge__frame">
            <KnowledgeCanvas
              nodes={laid.nodes}
              edges={laid.edges}
              communityLabels={laid.communityLabels}
              onSelectNode={onSelectNode}
              onClearSelection={() => setSelectedId(undefined)}
            />
          </div>
          {godLabel === undefined ? null : (
            <p className="knowledge__hint">
              <span className="knowledge__hint-prompt">$</span> graphify query &quot;what breaks if
              I change {godLabel}&quot;
            </p>
          )}
        </div>
        <KnowledgeInspector panel={panel} onSelectNode={onSelectNode} />
      </div>
      <p className="knowledge__provenance">
        built{' '}
        <code className="knowledge__code">{data.summary.builtAtCommit ?? 'unknown commit'}</code>
        {' · observed '}
        {data.summary.observedAt === undefined ? (
          'unknown time'
        ) : (
          <time dateTime={data.summary.observedAt}>{data.summary.observedAt}</time>
        )}
      </p>
    </div>
  );
}
