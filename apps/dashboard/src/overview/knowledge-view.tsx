import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import type { ResourceState } from '../components/panel.js';
import {
  createKnowledgeSim,
  KNOWLEDGE_HEIGHT,
  KNOWLEDGE_WIDTH,
  knowledgePanel,
  settleKnowledgeSim,
  type KnowledgeSim,
} from './knowledge-model.js';
import type { Focus } from './model.js';

/**
 * The Knowledge lens: one project's graphify graph, drawn the comp's way.
 *
 * The overview owns the read and the selection, because the docked aside
 * shows the same graph; this file draws it. The canvas is the comp's 3D-orbit
 * force layout over the endpoint's bounded backbone: React renders the nodes,
 * edges and community marks once per graph or selection, and a
 * `requestAnimationFrame` loop steps the simulation and writes positions into
 * those elements through refs, so no frame goes through React. The loop stops
 * when the lens unmounts, and `prefers-reduced-motion` settles the layout once
 * and never orbits.
 *
 * Read-only, like everything the lens shows: the comp's Optimize / Delete /
 * Rebuild controls are not here, and the `$ graphify query` line is a hint,
 * not a field. LUWI reads graphify's output; it never runs it.
 */
export type KnowledgeState = { state: 'loading' } | ResourceState<KnowledgeGraph>;

type LensProject = { id: string; name: string };

const R = { god: 15, hub: 10, symbol: 5.5 } as const;
const SETTLE_STEPS = 120;
const STILL_STEPS = 400;
const LABEL_GAP = 6;
const MARK_GAP = 16;

function ProjectSwitcher({
  projects,
  projectId,
  onFocus,
}: {
  projects: readonly LensProject[];
  projectId?: string;
  onFocus: (focus: Focus) => void;
}) {
  return (
    <label className="knowledge__switcher">
      <span className="knowledge__switcher-label">PROJECT</span>
      <select
        className="knowledge__switcher-select"
        aria-label="Knowledge graph project"
        value={projectId ?? ''}
        onChange={(event) => onFocus({ kind: 'project', id: event.target.value })}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Graphify labels are path-derived ids (`apps_dashboard_src_overview_model`),
 * so the canvas keeps the tail, which is the distinctive end; the inspector
 * shows the whole label and the source file.
 */
const LABEL_MAX = 24;
export function shortLabel(label: string): string {
  return label.length <= LABEL_MAX ? label : `…${label.slice(label.length - LABEL_MAX + 1)}`;
}

/** Depth from a community's projected scale: 0 far → 1 near, as the comp reads it. */
const depthOf = (s: number): number => Math.max(0.45, Math.min(1, (s - 0.78) / (1.3 - 0.78)));

function KnowledgeCanvas({
  graph,
  selectedId,
  onSelectNode,
}: {
  graph: KnowledgeGraph;
  selectedId?: string;
  onSelectNode: (id?: string) => void;
}) {
  const sim = useMemo(() => {
    const next = createKnowledgeSim(graph);
    settleKnowledgeSim(next, SETTLE_STEPS);
    return next;
  }, [graph]);
  const neighbours = useMemo(() => {
    const set = new Set<string>();
    if (selectedId === undefined) return set;
    for (const edge of graph.edges) {
      if (edge.source === selectedId) set.add(edge.target);
      if (edge.target === selectedId) set.add(edge.source);
    }
    return set;
  }, [graph, selectedId]);

  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef<(SVGLineElement | null)[]>([]);
  const markEls = useRef(new Map<number, SVGTextElement>());
  const selection = useRef({ selectedId, neighbours });
  selection.current = { selectedId, neighbours };

  const paint = useCallback((state: KnowledgeSim) => {
    const { selectedId: picked, neighbours: near } = selection.current;
    const byCommunity = new Map(state.communities.map((c) => [c.id, c]));
    for (const node of state.nodes) {
      const el = nodeEls.current.get(node.id);
      if (el === null || el === undefined) continue;
      const community = node.community === undefined ? undefined : byCommunity.get(node.community);
      const s = community?.s ?? 1;
      el.setAttribute(
        'transform',
        `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)}) scale(${s.toFixed(3)})`,
      );
      const opacity =
        picked === undefined
          ? 0.55 + 0.45 * depthOf(s)
          : picked === node.id || near.has(node.id)
            ? 1
            : 0.22;
      el.style.opacity = opacity.toFixed(2);
    }
    state.edges.forEach((edge, index) => {
      const el = edgeEls.current[index];
      if (el === null || el === undefined) return;
      el.setAttribute('x1', edge.a.x.toFixed(1));
      el.setAttribute('y1', edge.a.y.toFixed(1));
      el.setAttribute('x2', edge.b.x.toFixed(1));
      el.setAttribute('y2', edge.b.y.toFixed(1));
    });
    for (const community of state.communities) {
      const el = markEls.current.get(community.id);
      if (el === null || el === undefined) continue;
      const members = state.nodes.filter((node) => node.community === community.id);
      if (members.length === 0) continue;
      const x = members.reduce((sum, node) => sum + node.x, 0) / members.length;
      const y = Math.min(...members.map((node) => node.y)) - MARK_GAP;
      el.setAttribute('x', x.toFixed(1));
      el.setAttribute('y', y.toFixed(1));
      el.style.opacity = picked === undefined ? '0.55' : '0.25';
    }
  }, []);

  // Selection changes repaint at once rather than waiting for the next tick,
  // which matters when the loop is not running (reduced motion, no rAF).
  useEffect(() => paint(sim), [paint, sim, selectedId]);

  useEffect(() => {
    const animate = typeof requestAnimationFrame === 'function' && !prefersReducedMotion();
    if (!animate) {
      settleKnowledgeSim(sim, STILL_STEPS);
      paint(sim);
      return undefined;
    }
    let frame = 0;
    const tick = () => {
      sim.step(true);
      paint(sim);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paint, sim]);

  const communityById = new Map(sim.communities.map((c) => [c.id, c]));
  // Every community present anchors a ring position, but only the ones the
  // endpoint named (its largest, the same list the inspector bars show) get a
  // mark: a backbone of forty nodes can span forty communities, and forty
  // uppercase marks over forty labels is a wall, not a map.
  const namedIds = new Set(graph.communities.map((c) => c.id));
  const named = (community: { id: number }) => namedIds.has(community.id);
  return (
    <svg
      className="knowledge__svg"
      viewBox={`0 0 ${String(KNOWLEDGE_WIDTH)} ${String(KNOWLEDGE_HEIGHT)}`}
      preserveAspectRatio="xMidYMid meet"
      aria-label="Project knowledge graph"
      onClick={() => onSelectNode(undefined)}
    >
      <g>
        {sim.edges.map((edge, index) => {
          const active =
            selectedId !== undefined && (edge.a.id === selectedId || edge.b.id === selectedId);
          const dim = selectedId !== undefined && !active;
          return (
            <line
              key={`${edge.a.id}->${edge.b.id}:${String(index)}`}
              ref={(el) => {
                edgeEls.current[index] = el;
              }}
              className={`knowledge__edge knowledge__edge--${edge.kind}${active ? ' knowledge__edge--active' : ''}${dim ? ' knowledge__edge--dim' : ''}`}
              x1={edge.a.x}
              y1={edge.a.y}
              x2={edge.b.x}
              y2={edge.b.y}
            />
          );
        })}
      </g>
      {sim.communities.filter(named).map((community) => (
        <text
          key={community.id}
          ref={(el) => {
            if (el === null) markEls.current.delete(community.id);
            else markEls.current.set(community.id, el);
          }}
          className="knowledge__community-mark"
          x={community.x}
          y={community.y}
          textAnchor="middle"
        >
          {community.label}
        </text>
      ))}
      {graph.nodes.map((node) => {
        const selected = node.id === selectedId;
        const showLabel = node.kind !== 'symbol' || selected || neighbours.has(node.id);
        const r = R[node.kind] + (selected ? 2 : 0);
        const position = sim.byId.get(node.id);
        const s = node.community === undefined ? 1 : (communityById.get(node.community)?.s ?? 1);
        return (
          <g
            key={node.id}
            ref={(el) => {
              if (el === null) nodeEls.current.delete(node.id);
              else nodeEls.current.set(node.id, el);
            }}
            className={`knowledge__node knowledge__node--${node.kind}${selected ? ' knowledge__node--selected' : ''}`}
            transform={`translate(${String(position?.x ?? 0)} ${String(position?.y ?? 0)}) scale(${String(s)})`}
            role="button"
            aria-label={`Select ${node.label}`}
            aria-pressed={selected}
            onClick={(event) => {
              event.stopPropagation();
              onSelectNode(selected ? undefined : node.id);
            }}
          >
            <circle className="knowledge__node-hit" r={r + 9} />
            <circle className="knowledge__node-dot" r={r} />
            {showLabel ? (
              <text className="knowledge__node-label" y={-(r + LABEL_GAP)} textAnchor="middle">
                {shortLabel(node.label)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function Legend({ summary }: { summary: KnowledgeGraph['summary'] }) {
  const figures: { label: string; value: number }[] = [
    { label: 'nodes', value: summary.nodeCount },
    { label: 'edges', value: summary.edgeCount },
    { label: 'communities', value: summary.communityCount },
    { label: 'hubs', value: summary.hubCount },
    { label: 'embeddings', value: summary.embeddings },
  ];
  return (
    <div className="knowledge__legend" aria-hidden="true">
      {figures.map((figure) => (
        <span key={figure.label} className="knowledge__figure">
          <span className="knowledge__figure-value">{figure.value}</span>
          {figure.label}
        </span>
      ))}
      <span className="knowledge__legend-spacer" />
      <span className="knowledge__legend-item">
        <span className="knowledge__legend-dot knowledge__legend-dot--god" />
        god node
      </span>
      <span className="knowledge__legend-item">
        <span className="knowledge__legend-dot knowledge__legend-dot--hub" />
        module hub
      </span>
      <span className="knowledge__legend-item">
        <span className="knowledge__legend-dot knowledge__legend-dot--symbol" />
        symbol
      </span>
    </div>
  );
}

/**
 * Five states, kept apart: no project on the overview (the filter, or an empty
 * registry); a read in flight; a failed read — including an unknown project's
 * 404, which is a fault, not "no graph"; a successful read with `nodeCount` 0,
 * the honest report that `graphify build` has never run here; and the graph.
 */
export function KnowledgeView({
  projects,
  projectId,
  graph,
  emptyLabel,
  selectedId,
  onSelectNode,
  onFocus,
}: {
  projects: readonly LensProject[];
  projectId?: string;
  graph?: KnowledgeState;
  /** What to say when there is no project to draw: `emptyProjectsLabel(overview)`. */
  emptyLabel: string;
  selectedId?: string;
  onSelectNode: (id?: string) => void;
  onFocus: (focus: Focus) => void;
}) {
  if (projectId === undefined) {
    return (
      <div className="knowledge">
        <p className="knowledge__empty">{emptyLabel}</p>
      </div>
    );
  }
  const switcher = <ProjectSwitcher projects={projects} projectId={projectId} onFocus={onFocus} />;
  if (graph === undefined || graph.state === 'loading') {
    return (
      <div className="knowledge">
        <div className="knowledge__stage">
          {switcher}
          <p className="knowledge__empty" aria-busy="true">
            Loading
          </p>
        </div>
      </div>
    );
  }
  if (graph.state !== 'ready') {
    return (
      <div className="knowledge">
        <div className="knowledge__stage">
          {switcher}
          <p className="knowledge__empty">Unavailable</p>
        </div>
      </div>
    );
  }
  const data = graph.data;
  if (data.summary.nodeCount === 0) {
    return (
      <div className="knowledge">
        <div className="knowledge__stage">
          {switcher}
          <div className="knowledge__empty">
            <p>This project has no graphify output yet.</p>
            <p>
              Run <code className="knowledge__code">graphify build</code> in this project. LUWI
              reads the result; it does not run it for you.
            </p>
          </div>
        </div>
      </div>
    );
  }
  const selected =
    selectedId === undefined ? undefined : data.nodes.find((n) => n.id === selectedId);
  const god = data.nodes.find((node) => node.kind === 'god') ?? data.nodes[0];
  const query =
    selected === undefined
      ? god === undefined
        ? undefined
        : `what breaks if I change ${god.label}`
      : `path ${selected.label} → *`;

  return (
    <div className="knowledge">
      <Legend summary={data.summary} />
      <div className="knowledge__stage">
        {switcher}
        <KnowledgeCanvas
          graph={data}
          onSelectNode={onSelectNode}
          {...(selectedId === undefined ? {} : { selectedId })}
        />
        {query === undefined ? null : (
          <p className="knowledge__hint">
            <span className="knowledge__hint-prompt">$</span> graphify query{' '}
            <span className="knowledge__hint-query">&quot;{query}&quot;</span>
            <span className="knowledge__hint-caret" aria-hidden="true" />
          </p>
        )}
        <p className="knowledge__provenance">
          built{' '}
          <code className="knowledge__code">
            {data.summary.builtAtCommit?.slice(0, 12) ?? 'unknown commit'}
          </code>
          {' · observed '}
          {data.summary.observedAt === undefined ? (
            'unknown time'
          ) : (
            <time dateTime={data.summary.observedAt}>{data.summary.observedAt}</time>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The docked aside while the Knowledge lens is open: the drill-down's anatomy
 * (it is the same third region of the layout), with the project summary or
 * the selected node. Before the graph is ready it says which state the read is
 * in, in the same words the lens uses, and offers nothing else.
 */
export function KnowledgeInspector({
  projectName,
  graph,
  selectedId,
  onSelectNode,
}: {
  projectName?: string;
  graph?: KnowledgeState;
  selectedId?: string;
  onSelectNode: (id?: string) => void;
}) {
  const head = (eyebrow: string, title: string, badge: string, sub: string, ink = false) => (
    <div className="drill__head">
      <p className="drill__eyebrow">{eyebrow}</p>
      <div className="drill__title-row">
        <h2 className="drill__title">{title}</h2>
        <span className={`drill__badge${ink ? ' drill__badge--ink' : ''}`}>{badge}</span>
      </div>
      <p className="drill__sub">{sub}</p>
    </div>
  );
  const title = projectName ?? 'Knowledge graph';
  if (projectName === undefined) {
    return (
      <aside className="drill" aria-label="Knowledge inspector">
        {head('Project graph', title, 'NO PROJECT', 'Nothing on the overview to draw')}
      </aside>
    );
  }
  if (graph === undefined || graph.state === 'loading') {
    return (
      <aside className="drill" aria-label="Knowledge inspector">
        {head('Project graph', title, 'LOADING', 'Reading graphify output')}
      </aside>
    );
  }
  if (graph.state !== 'ready') {
    return (
      <aside className="drill" aria-label="Knowledge inspector">
        {head('Project graph', title, 'UNAVAILABLE', 'The knowledge graph read failed')}
      </aside>
    );
  }
  if (graph.data.summary.nodeCount === 0) {
    return (
      <aside className="drill" aria-label="Knowledge inspector">
        {head('Project graph', title, 'NO OUTPUT', 'graphify build has not run here')}
      </aside>
    );
  }
  const panel = knowledgePanel(graph.data, selectedId);
  return (
    <aside className="drill" aria-label="Knowledge inspector">
      {panel.kind === 'node'
        ? head(panel.eyebrow, panel.title, panel.badge, panel.sub, panel.badge === 'GOD')
        : head('Project graph', title, panel.badge, panel.sub)}

      <div className="drill__facts">
        {panel.facts.map((fact, index) => (
          <div
            key={fact.k}
            className="drill__fact"
            style={{ animationDelay: `${String(0.05 + index * 0.05)}s` }}
          >
            <span className="drill__fact-k">{fact.k}</span>
            <span className="drill__fact-v" title={fact.v}>
              {fact.v}
            </span>
          </div>
        ))}
      </div>

      {panel.kind === 'summary' && panel.communities.length > 0 ? (
        <div className="knowledge__communities">
          <p className="drill__section-label">Communities</p>
          {panel.communities.map((community) => (
            <div key={community.label} className="knowledge__community-row">
              <span className="knowledge__community-label">{community.label}</span>
              <span className="knowledge__community-track">
                <span className="knowledge__community-fill" style={{ width: community.pct }} />
              </span>
              <span className="knowledge__community-n">{community.n}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="drill__list">
        <p className="drill__section-label">
          {panel.kind === 'summary'
            ? 'God & hub nodes'
            : `Edges · ${String(panel.rows.length)} connected`}
        </p>
        {panel.rows.length === 0 ? (
          <p className="drill__empty">No connections observed</p>
        ) : (
          panel.rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              className={`drill__row${row.id === selectedId ? ' drill__row--selected' : ''}`}
              aria-label={`Select ${row.title}`}
              style={{ animationDelay: `${String(0.08 + index * 0.06)}s` }}
              onClick={() => onSelectNode(row.id)}
            >
              <span className="drill__glyph" aria-hidden="true">
                {row.rel}
              </span>
              <span className="drill__row-text">
                <span className="drill__row-title">{row.title}</span>
                <span className="drill__row-sub">{row.sub}</span>
              </span>
              <span className="knowledge__row-meta">{row.meta}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
