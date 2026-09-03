import { useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_NODE_LIMIT,
  type GraphConfidence,
  type GraphOrigin,
  type GraphRoot,
  originLabels,
  originOf,
  type Subgraph,
  type SubgraphBounds,
} from '../api/graph-explorer.js';
import { Panel, TableWrap, type ResourceState } from '../components/panel.js';
import { familyLabel, GraphDiagram, nodeColor, nodeFamily, nodeShape } from './graph-diagram.js';

/**
 * Rooted, bounded graph exploration (ADR 0016).
 *
 * Every traversal read the daemon offers is rooted, so this view is too: pick a
 * root the snapshot already knows, fetch one bounded subgraph, and re-root by
 * selecting a node. There is no global graph read, and none is faked here.
 *
 * The diagram is a second presentation of the tables beneath it. Interaction
 * lives in the tables — they are keyboard-navigable and screen-reader-legible,
 * where an SVG scatter of shapes is neither.
 */

export type GraphSeed = { kind: string; id: string; label: string };

const DEPTH_CHOICES = [1, 2, 3, 4, 5, 6];
const NODE_LIMIT_CHOICES = [50, 100, 250, 500, 1000];

const confidenceLabels: Record<GraphConfidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown',
};

function LegendMark({ kind }: { kind: string }) {
  const shape = nodeShape(kind);
  const fill = nodeColor(kind);
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="legend-mark">
      {shape === 'square' ? (
        <rect x="1" y="1" width="12" height="12" rx="2" fill={fill} />
      ) : shape === 'diamond' ? (
        <path d="M 7 0 L 14 7 L 7 14 L 0 7 Z" fill={fill} />
      ) : shape === 'triangle' ? (
        <path d="M 7 0 L 14 13 L 0 13 Z" fill={fill} />
      ) : shape === 'hexagon' ? (
        <polygon points="7,0 13,3.5 13,10.5 7,14 1,10.5 1,3.5" fill={fill} />
      ) : (
        <circle cx="7" cy="7" r="6" fill={fill} />
      )}
    </svg>
  );
}

function Legend({
  kinds,
  origins,
}: {
  kinds: readonly string[];
  origins: ReadonlySet<GraphOrigin>;
}) {
  return (
    <section className="graph-legend" aria-label="Legend">
      <div>
        <p className="eyebrow">Node kind</p>
        <ul>
          {kinds.map((kind) => (
            <li key={kind}>
              <LegendMark kind={kind} />
              {kind}
              <small>{familyLabel(nodeFamily(kind))}</small>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="eyebrow">Edge certainty</p>
        <ul>
          <li>
            <span className="legend-line" data-confidence="high" aria-hidden="true" />
            High — statically resolved
          </li>
          <li>
            <span className="legend-line" data-confidence="medium" aria-hidden="true" />
            Medium — one candidate
          </li>
          <li>
            <span className="legend-line" data-confidence="low" aria-hidden="true" />
            Low — heuristic
          </li>
          <li>
            <span className="legend-line" data-confidence="unknown" aria-hidden="true" />
            Unknown — unresolved
          </li>
        </ul>
      </div>
      <div>
        <p className="eyebrow">Origin</p>
        <ul>
          <li>
            <span className="legend-line" data-origin="operational" aria-hidden="true" />
            Observed from runtime events
          </li>
          {origins.has('code-structure') ? (
            <li>
              <span className="legend-line" data-origin="structural" aria-hidden="true" />
              Code structure — parsed, never executed
            </li>
          ) : null}
          {origins.has('graphify') ? (
            <li>
              <span className="legend-line" data-origin="structural" aria-hidden="true" />
              Graphify output — read, never run
            </li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}

export function GraphExplorerView({
  seeds,
  loadSubgraph,
}: {
  seeds: readonly GraphSeed[];
  loadSubgraph: (
    root: GraphRoot,
    bounds: SubgraphBounds,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<Subgraph>>;
}) {
  const [root, setRoot] = useState<GraphRoot | undefined>(() => seeds[0]);
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  const [nodeLimit, setNodeLimit] = useState(DEFAULT_NODE_LIMIT);
  const [result, setResult] = useState<ResourceState<Subgraph>>();
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();

  /**
   * Adopts a root once seeds exist.
   *
   * The explorer mounts as soon as `loadSubgraph` is bound, which is the first
   * render, while the Pulse snapshot is still empty — so reloading the page on
   * `#/graph` gave the lazy initialiser nothing to take. Without this, `root`
   * stayed undefined after the snapshot arrived, the load effect below returned
   * immediately, and the panel sat on its busy state permanently.
   *
   * The guard is what keeps it cheap. `graphSeedsOf` rebuilds `seeds` on every
   * snapshot refresh, so an unconditional sync — or deriving the root from
   * `seeds[0]` — would change the load effect's dependency on each refresh and
   * cost a redundant subgraph request every time.
   */
  useEffect(() => {
    if (root === undefined && seeds.length > 0) setRoot(seeds[0]);
  }, [root, seeds]);

  useEffect(() => {
    if (root === undefined) return undefined;
    const controller = new AbortController();
    setLoading(true);
    void loadSubgraph(root, { maxDepth, nodeLimit }, { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted) return;
      setResult(next);
      setLoading(false);
    });
    return () => controller.abort();
  }, [root, maxDepth, nodeLimit, loadSubgraph]);

  const data = result?.state === 'ready' ? result.data : undefined;
  const kindsPresent = useMemo(
    () => [...new Set(data?.nodes.map((node) => node.kind) ?? [])].sort(),
    [data],
  );
  const origins = useMemo(
    () =>
      new Set<GraphOrigin>(
        [...(data?.nodes ?? []), ...(data?.edges ?? [])].map((value) => originOf(value.provenance)),
      ),
    [data],
  );

  if (seeds.length === 0) {
    return (
      <div className="route-stack">
        <Panel title="Explore">
          <p className="empty-state">
            No project, session, or agent is available to start from. Every graph traversal is
            rooted, so exploration needs one of those before it can begin.
          </p>
        </Panel>
      </div>
    );
  }

  return (
    <div className="route-stack">
      <Panel
        title="Explore"
        meta={data === undefined ? undefined : `${String(data.nodes.length)} nodes in view`}
      >
        <div className="table-filters" aria-label="Graph exploration bounds">
          <label>
            Root
            <select
              value={root === undefined ? '' : `${root.kind}\u0000${root.id}`}
              onChange={(event) => {
                const [kind, id] = event.target.value.split('\u0000');
                const seed = seeds.find(
                  (candidate) => candidate.kind === kind && candidate.id === id,
                );
                if (seed !== undefined) {
                  setSelectedId(undefined);
                  setRoot(seed);
                }
              }}
            >
              {seeds.map((seed) => (
                <option key={`${seed.kind}\u0000${seed.id}`} value={`${seed.kind}\u0000${seed.id}`}>
                  {seed.kind} · {seed.label}
                </option>
              ))}
            </select>
          </label>
          {/* Bounds you can read without opening anything: every choice is
              visible and the pressed one is the current bound. The
              reached-limit note below stays exactly as the daemon reports
              it — the control never claims a subgraph is complete. */}
          <div className="table-filters__field">
            <span className="table-filters__name" id="graph-depth-label">
              Depth
            </span>
            <div className="segmented" role="group" aria-labelledby="graph-depth-label">
              {DEPTH_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="segmented__option"
                  aria-pressed={maxDepth === choice}
                  onClick={() => setMaxDepth(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
          <div className="table-filters__field">
            <span className="table-filters__name" id="graph-node-limit-label">
              Node limit
            </span>
            <div className="segmented" role="group" aria-labelledby="graph-node-limit-label">
              {NODE_LIMIT_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="segmented__option"
                  aria-pressed={nodeLimit === choice}
                  onClick={() => setNodeLimit(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          </div>
        </div>

        {result === undefined || loading ? (
          <p className="empty-state" aria-busy="true">
            Reading the bounded subgraph
          </p>
        ) : result.state !== 'ready' ? (
          <p className="empty-state">Unavailable</p>
        ) : result.data.nodes.length === 0 ? (
          <p className="empty-state">No relationships recorded for this root</p>
        ) : (
          <>
            {result.data.truncated ? (
              <p className="bounded-note" role="status">
                This subgraph reached the {nodeLimit}-node limit at depth {maxDepth} and is
                incomplete. Raise the bounds above to see more, or choose a narrower root.
              </p>
            ) : null}
            <GraphDiagram
              nodes={result.data.nodes}
              edges={result.data.edges}
              rootId={root?.id ?? ''}
              {...(selectedId === undefined ? {} : { selectedId })}
              onSelect={setSelectedId}
            />
            <Legend kinds={kindsPresent} origins={origins} />
          </>
        )}
      </Panel>

      {data === undefined ? null : (
        <div className="graph-two-up">
          <Panel title="Nodes in view" meta={`${String(data.nodes.length)} nodes`}>
            <TableWrap caption="Nodes in the current bounded subgraph">
              <thead>
                <tr>
                  <th scope="col">Node</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Origin</th>
                  <th scope="col">
                    <span className="sr-only">Explore</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.nodes.map((node) => (
                  <tr key={node.id} data-selected={node.id === selectedId ? 'true' : undefined}>
                    <td>
                      <LegendMark kind={node.kind} />
                      {node.label}
                    </td>
                    <td>{node.kind}</td>
                    <td>{originLabels[originOf(node.provenance)]}</td>
                    <td>
                      {node.id === root?.id ? (
                        <span className="graph-root-tag">Root</span>
                      ) : (
                        <button
                          className="inspect-button"
                          type="button"
                          onClick={() => {
                            setSelectedId(undefined);
                            setRoot({ kind: node.kind, id: node.id, label: node.label });
                          }}
                          aria-label={`Explore from ${node.label}`}
                        >
                          Explore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Panel>

          <Panel title="Edges in view" meta={`${String(data.edges.length)} edges`}>
            {data.edges.length === 0 ? (
              <p className="empty-state">No edges within these bounds</p>
            ) : (
              <TableWrap caption="Edges in the current bounded subgraph">
                <thead>
                  <tr>
                    <th scope="col">Relationship</th>
                    <th scope="col">From</th>
                    <th scope="col">To</th>
                    <th scope="col">Certainty</th>
                    <th scope="col">Origin</th>
                  </tr>
                </thead>
                <tbody>
                  {data.edges.map((edge) => (
                    <tr key={edge.id}>
                      <td>{edge.kind}</td>
                      <td>
                        <code>{edge.source}</code>
                      </td>
                      <td>
                        <code>{edge.target}</code>
                      </td>
                      <td>{confidenceLabels[edge.confidence]}</td>
                      <td>{originLabels[originOf(edge.provenance)]}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
