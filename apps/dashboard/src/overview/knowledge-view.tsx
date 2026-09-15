import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

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
import { RUNTIME_FOCUS, type Focus } from './model.js';

/**
 * The Knowledge lens: one project's graphify graph, drawn the comp's way.
 *
 * The overview owns the read and the selection, because the docked aside
 * shows the same graph; this file draws it. With no project focused the
 * canvas holds the projects themselves, in the centre, and a click focuses
 * one — that is the picker, not a control beside the canvas. Focused, the
 * project sits at the centre as an ink disc and its communities orbit it:
 * the comp's 3D-orbit force layout over the endpoint's bounded backbone.
 * React renders the nodes, edges and community marks once per graph or
 * selection, and a `requestAnimationFrame` loop steps the simulation and
 * writes positions into those elements through refs, so no frame goes
 * through React. Nodes carry no label; a hover shows one. The loop stops when
 * the lens unmounts, and `prefers-reduced-motion` settles the layout once and
 * never orbits.
 *
 * Read-only, like everything the lens shows: the comp's Optimize / Delete /
 * Rebuild controls are not here. LUWI reads graphify's output; it never runs
 * it. Only the provenance line remains, naming the commit and observation.
 */
export type KnowledgeState = { state: 'loading' } | ResourceState<KnowledgeGraph>;

type LensProject = { id: string; name: string; initials: string };

const CX = KNOWLEDGE_WIDTH / 2;
const CY = KNOWLEDGE_HEIGHT / 2;
const R = { god: 15, hub: 10, symbol: 5.5 } as const;
const PROJECT_RADIUS = 30;
const CORE_RADIUS = 34;
/** Enough steps that the layout is cool before the first paint; only the orbit moves after. */
const SETTLE_STEPS = 400;
const STILL_STEPS = 200;
const MARK_GAP = 16;
const FRAME_MS = 1000 / 60;
const TIP_OFFSET = 14;

const activate =
  (run: () => void) =>
  (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    run();
  };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Depth from a community's projected scale: 0 far → 1 near, as the comp reads it. */
const depthOf = (s: number): number => Math.max(0.45, Math.min(1, (s - 0.78) / (1.3 - 0.78)));

/**
 * A connection as a quadratic curve bowed outward from the centre, so the
 * edges read as petals radiating from the core rather than a straight-line
 * mesh — the Radial and Flow lenses' curved, flowing language.
 */
const ORBIT_RADIUS = 250;
function curvePath(ax: number, ay: number, bx: number, by: number): string {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = mx - CX;
  const dy = my - CY;
  const dl = Math.hypot(dx, dy) || 1;
  const len = Math.hypot(bx - ax, by - ay);
  const off = Math.min(len * 0.16, 70);
  const cx = mx + (dx / dl) * off;
  const cy = my + (dy / dl) * off;
  return `M${ax.toFixed(2)} ${ay.toFixed(2)} Q${cx.toFixed(2)} ${cy.toFixed(2)} ${bx.toFixed(2)} ${by.toFixed(2)}`;
}

/** Where the projects sit while none is focused: one at the centre, else a ring. */
function projectRing(count: number): { x: number; y: number }[] {
  if (count <= 1) return [{ x: CX, y: CY }];
  const radius = count <= 6 ? 150 : 205;
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
  });
}

function ProjectPicker({
  projects,
  onFocus,
}: {
  projects: readonly LensProject[];
  onFocus: (focus: Focus) => void;
}) {
  const ring = projectRing(projects.length);
  const [tip, setTip] = useState<{ name: string; x: number; y: number }>();
  return (
    <>
      <svg
        className="knowledge__svg"
        viewBox={`0 0 ${String(KNOWLEDGE_WIDTH)} ${String(KNOWLEDGE_HEIGHT)}`}
        preserveAspectRatio="xMidYMid meet"
        aria-label="Projects"
      >
        <circle className="knowledge__orbit" cx={CX} cy={CY} r={ORBIT_RADIUS} />
        {projects.map((project, index) => {
          const spot = ring[index] ?? { x: CX, y: CY };
          const focus = () => onFocus({ kind: 'project', id: project.id });
          return (
            <g
              key={project.id}
              className="knowledge__project"
              role="button"
              tabIndex={0}
              aria-label={`Focus project ${project.name}`}
              transform={`translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)})`}
              style={{ animationDelay: `${String(0.1 + index * 0.05)}s` }}
              onClick={focus}
              onKeyDown={activate(focus)}
              onMouseEnter={(event) => {
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                setTip({
                  name: project.name,
                  x: event.clientX - (box?.left ?? 0),
                  y: event.clientY - (box?.top ?? 0),
                });
              }}
              onMouseMove={(event) => {
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                setTip({
                  name: project.name,
                  x: event.clientX - (box?.left ?? 0),
                  y: event.clientY - (box?.top ?? 0),
                });
              }}
              onMouseLeave={() => setTip(undefined)}
            >
              <circle className="knowledge__project-disc" r={PROJECT_RADIUS} />
              <text className="knowledge__project-initials" textAnchor="middle" dy="0.35em">
                {project.initials}
              </text>
            </g>
          );
        })}
      </svg>
      {tip === undefined ? null : (
        <div
          className="knowledge__tip"
          role="tooltip"
          style={{
            left: `${String(tip.x + TIP_OFFSET)}px`,
            top: `${String(tip.y + TIP_OFFSET)}px`,
          }}
        >
          <span className="knowledge__tip-title">{tip.name}</span>
          <span className="knowledge__tip-meta">open knowledge graph</span>
        </div>
      )}
    </>
  );
}

/** The focused project at the centre; a click returns to all projects. */
function CoreDisc({ project, onFocus }: { project: LensProject; onFocus: (focus: Focus) => void }) {
  const back = () => onFocus(RUNTIME_FOCUS);
  return (
    <g
      className="knowledge__core"
      role="button"
      tabIndex={0}
      aria-label="Back to all projects"
      transform={`translate(${String(CX)} ${String(CY)})`}
      onClick={(event) => {
        event.stopPropagation();
        back();
      }}
      onKeyDown={activate(back)}
    >
      <circle className="knowledge__core-ring" r={CORE_RADIUS + 9} />
      <circle className="knowledge__core-disc" r={CORE_RADIUS} />
      <text className="knowledge__core-initials" textAnchor="middle" dy="0.35em">
        {project.initials}
      </text>
      <text className="knowledge__core-name" y={CORE_RADIUS + 20} textAnchor="middle">
        {project.name}
      </text>
    </g>
  );
}

type Tip = { id: string; x: number; y: number };

function KnowledgeCanvas({
  project,
  graph,
  selectedId,
  onSelectNode,
  onFocus,
}: {
  project: LensProject;
  graph: KnowledgeGraph;
  selectedId?: string;
  onSelectNode: (id?: string) => void;
  onFocus: (focus: Focus) => void;
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
  const [tip, setTip] = useState<Tip>();

  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef<(SVGPathElement | null)[]>([]);
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
        `translate(${node.x.toFixed(2)} ${node.y.toFixed(2)}) scale(${s.toFixed(3)})`,
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
      el.setAttribute('d', curvePath(edge.a.x, edge.a.y, edge.b.x, edge.b.y));
    });
    for (const community of state.communities) {
      const el = markEls.current.get(community.id);
      if (el === null || el === undefined) continue;
      const members = state.nodes.filter((node) => node.community === community.id);
      if (members.length === 0) continue;
      const x = members.reduce((sum, node) => sum + node.x, 0) / members.length;
      const y = Math.min(...members.map((node) => node.y)) - MARK_GAP;
      el.setAttribute('x', x.toFixed(2));
      el.setAttribute('y', y.toFixed(2));
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
    let last: number | undefined;
    // The orbit advances by wall time, so the ring turns at one speed on
    // every refresh rate; a long pause (a hidden tab) is clamped, not replayed.
    const tick = (now: number) => {
      const dt = last === undefined ? FRAME_MS : Math.min(50, now - last);
      last = now;
      sim.step(true, dt);
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
  // uppercase marks over forty nodes is a wall, not a map.
  const namedIds = new Set(graph.communities.map((c) => c.id));
  const named = (community: { id: number }) => namedIds.has(community.id);
  const tipNode = tip === undefined ? undefined : graph.nodes.find((n) => n.id === tip.id);

  return (
    <>
      <svg
        className="knowledge__svg"
        viewBox={`0 0 ${String(KNOWLEDGE_WIDTH)} ${String(KNOWLEDGE_HEIGHT)}`}
        preserveAspectRatio="xMidYMid meet"
        aria-label="Project knowledge graph"
        onClick={() => onSelectNode(undefined)}
      >
        <circle className="knowledge__orbit" cx={CX} cy={CY} r={ORBIT_RADIUS} />
        <g>
          {sim.edges.map((edge, index) => {
            const active =
              selectedId !== undefined && (edge.a.id === selectedId || edge.b.id === selectedId);
            const dim = selectedId !== undefined && !active;
            return (
              <path
                key={`${edge.a.id}->${edge.b.id}:${String(index)}`}
                ref={(el) => {
                  edgeEls.current[index] = el;
                }}
                className={`knowledge__edge knowledge__edge--${edge.kind}${active ? ' knowledge__edge--active' : ''}${dim ? ' knowledge__edge--dim' : ''}`}
                d={curvePath(edge.a.x, edge.a.y, edge.b.x, edge.b.y)}
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
          const r = R[node.kind] + (selected ? 2 : 0);
          const position = sim.byId.get(node.id);
          const s = node.community === undefined ? 1 : (communityById.get(node.community)?.s ?? 1);
          const toggle = () => onSelectNode(selected ? undefined : node.id);
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
              tabIndex={0}
              aria-label={`Select ${node.label}`}
              aria-pressed={selected}
              onClick={(event) => {
                event.stopPropagation();
                toggle();
              }}
              onKeyDown={activate(toggle)}
              onMouseEnter={(event) => {
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                setTip({
                  id: node.id,
                  x: event.clientX - (box?.left ?? 0),
                  y: event.clientY - (box?.top ?? 0),
                });
              }}
              onMouseLeave={() => setTip(undefined)}
            >
              <circle className="knowledge__node-hit" r={r + 9} />
              <circle className="knowledge__node-dot" r={r} />
            </g>
          );
        })}
        <CoreDisc project={project} onFocus={onFocus} />
      </svg>
      {tip === undefined || tipNode === undefined ? null : (
        <div
          className="knowledge__tip"
          role="tooltip"
          style={{
            left: `${String(tip.x + TIP_OFFSET)}px`,
            top: `${String(tip.y + TIP_OFFSET)}px`,
          }}
        >
          <span className="knowledge__tip-title">{tipNode.label}</span>
          <span className="knowledge__tip-sub">{tipNode.sourceFile}</span>
          <span className="knowledge__tip-meta">
            {tipNode.kind} · {tipNode.degree} deg
            {tipNode.communityName === undefined ? '' : ` · ${tipNode.communityName}`}
          </span>
        </div>
      )}
    </>
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

/** A state screen for a focused project: the message, and the disc that leads back. */
function StateStage({
  project,
  onFocus,
  children,
}: {
  project: LensProject;
  onFocus: (focus: Focus) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="knowledge">
      <div className="knowledge__stage">
        <svg
          className="knowledge__svg"
          viewBox={`0 0 ${String(KNOWLEDGE_WIDTH)} ${String(KNOWLEDGE_HEIGHT)}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label={`${project.name} knowledge graph`}
        >
          <CoreDisc project={project} onFocus={onFocus} />
        </svg>
        {children}
      </div>
    </div>
  );
}

/**
 * Six states, kept apart: no project on the overview (the filter, or an empty
 * registry); no project focused, so the projects themselves are the canvas;
 * a read in flight; a failed read — including an unknown project's 404, which
 * is a fault, not "no graph"; a successful read with `nodeCount` 0, the honest
 * report that `graphify build` has never run here; and the graph.
 */
export function KnowledgeView({
  projects,
  project,
  graph,
  emptyLabel,
  selectedId,
  onSelectNode,
  onFocus,
}: {
  projects: readonly LensProject[];
  /** The focused project, when the focus resolves to one. */
  project?: LensProject;
  graph?: KnowledgeState;
  /** What to say when there is no project to draw: `emptyProjectsLabel(overview)`. */
  emptyLabel: string;
  selectedId?: string;
  onSelectNode: (id?: string) => void;
  onFocus: (focus: Focus) => void;
}) {
  if (projects.length === 0) {
    return (
      <div className="knowledge">
        <p className="knowledge__empty">{emptyLabel}</p>
      </div>
    );
  }
  if (project === undefined) {
    return (
      <div className="knowledge">
        <div className="knowledge__stage">
          <ProjectPicker projects={projects} onFocus={onFocus} />
        </div>
      </div>
    );
  }
  if (graph === undefined || graph.state === 'loading') {
    return (
      <StateStage project={project} onFocus={onFocus}>
        <p className="knowledge__empty" aria-busy="true">
          Loading
        </p>
      </StateStage>
    );
  }
  if (graph.state !== 'ready') {
    return (
      <StateStage project={project} onFocus={onFocus}>
        <p className="knowledge__empty">Unavailable</p>
      </StateStage>
    );
  }
  const data = graph.data;
  if (data.summary.nodeCount === 0) {
    return (
      <StateStage project={project} onFocus={onFocus}>
        <div className="knowledge__empty">
          <p>This project has no graphify output yet.</p>
          <p>
            Run <code className="knowledge__code">graphify build</code> in this project. LUWI reads
            the result; it does not run it for you.
          </p>
        </div>
      </StateStage>
    );
  }
  return (
    <div className="knowledge">
      <Legend summary={data.summary} />
      <div className="knowledge__stage">
        <KnowledgeCanvas
          project={project}
          graph={data}
          onSelectNode={onSelectNode}
          onFocus={onFocus}
          {...(selectedId === undefined ? {} : { selectedId })}
        />
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
        {head('Project graph', title, 'NO PROJECT', 'Pick a project on the canvas')}
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
