import type { CSSProperties } from 'react';

import type { GraphRoot, Subgraph, SubgraphBounds } from '../api/graph-explorer.js';
import type { GraphSummary, KindCount } from '../api/intelligence-scope.js';
import { ResourcePanel, TableWrap, Unavailable, type ResourceState } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import { GraphExplorerView, type GraphSeed } from './graph-explorer-view.js';

/**
 * The operational graph, read-only and bounded by ADR 0013.
 *
 * Three states are kept apart deliberately. A failed read is `Unavailable`; a
 * graph that has never been built reports `Never built` and withholds its
 * totals; a generation that exists and holds nothing shows a real zero. The
 * middle case is why this route stayed disabled until the summary contract
 * existed — rendering it as zero would be a claim the daemon cannot prove.
 *
 * This route only reads the summary. Provoking a projection from a read surface
 * is exactly what AGENTS.md section 12 forbids, and the product-independence
 * test enforces it by rejecting the endpoint's path anywhere in the sources —
 * including inside a comment, which is why it is not written out here.
 */
export function GraphView({
  summary,
  seeds = [],
  loading = false,
  loadSubgraph,
}: {
  summary: ResourceState<GraphSummary> | undefined;
  /** Roots the Pulse snapshot already holds; see ADR 0016. */
  seeds?: readonly GraphSeed[];
  /** The intelligence scope has not returned yet; see `ResourcePanel`. */
  loading?: boolean;
  loadSubgraph?: (
    root: GraphRoot,
    bounds: SubgraphBounds,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<Subgraph>>;
}) {
  const perKind = (data: GraphSummary, counts: KindCount[]): ResourceState<KindCount[]> =>
    data.observed ? { state: 'ready', data: counts } : { state: 'not-observed' };
  const generation = summary?.state === 'ready' ? summary.data.generation : undefined;

  return (
    <div className="route-stack">
      {loadSubgraph === undefined ? null : (
        <GraphExplorerView seeds={seeds} loadSubgraph={loadSubgraph} />
      )}
      <ResourcePanel<GraphSummary>
        title="Projection"
        resource={summary}
        loading={loading}
        emptyMessage="No projection state recorded"
        isEmpty={() => false}
      >
        {(data) => (
          <>
            <TableWrap caption="Operational graph projection state">
              <tbody>
                <tr>
                  <th scope="row">Active generation</th>
                  <td>
                    {data.generation === undefined ? (
                      <Unavailable label="Never built" />
                    ) : (
                      data.generation
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Retained generations</th>
                  <td>{data.retainedGenerationCount}</td>
                </tr>
                <tr>
                  <th scope="row">Projection health</th>
                  <td>
                    <StatusChip tone={data.projectionHealth === 'healthy' ? 'success' : 'danger'}>
                      {data.projectionHealth}
                    </StatusChip>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Nodes</th>
                  <td>
                    {data.nodeCount === undefined ? (
                      <Unavailable label="Not observed" />
                    ) : (
                      data.nodeCount
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Edges</th>
                  <td>
                    {data.edgeCount === undefined ? (
                      <Unavailable label="Not observed" />
                    ) : (
                      data.edgeCount
                    )}
                  </td>
                </tr>
              </tbody>
            </TableWrap>
            <p className="bounded-note">
              Counts are exact set cardinality on the active generation, not a sampled or bounded
              read. Projection health reports whether a failure was recorded, which is not proof
              that the projection is correct.
            </p>
          </>
        )}
      </ResourcePanel>

      <ResourcePanel<KindCount[]>
        title="Nodes by kind"
        {...(generation === undefined ? {} : { meta: generation })}
        resource={
          summary?.state === 'ready'
            ? perKind(summary.data, summary.data.nodeCountsByKind)
            : summary
        }
        loading={loading}
        notObservedMessage="The graph has not been built"
        emptyMessage="No nodes in the active generation"
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <KindTable caption="Graph node counts by kind" heading="Node kind" rows={rows} />
        )}
      </ResourcePanel>

      <ResourcePanel<KindCount[]>
        title="Edges by kind"
        resource={
          summary?.state === 'ready'
            ? perKind(summary.data, summary.data.edgeCountsByKind)
            : summary
        }
        loading={loading}
        notObservedMessage="The graph has not been built"
        emptyMessage="No edges in the active generation"
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <KindTable caption="Graph edge counts by kind" heading="Edge kind" rows={rows} />
        )}
      </ResourcePanel>
    </div>
  );
}

/**
 * Kinds are rendered verbatim; the dashboard owns no label map for them.
 *
 * Rows are ordered by magnitude and carry a bar scaled against the largest
 * count, because "which kinds dominate this generation" is the question a list
 * of up to 55 kinds cannot answer by reading. The bar is a second encoding of
 * the number already in the row, never a replacement: the exact count stays,
 * and the bar is `aria-hidden` so a screen reader hears the count once.
 */
function KindTable({
  caption,
  heading,
  rows,
}: {
  caption: string;
  heading: string;
  rows: KindCount[];
}) {
  const ordered = [...rows].sort(
    (left, right) => right.count - left.count || left.kind.localeCompare(right.kind),
  );
  const largest = Math.max(...ordered.map((row) => row.count), 0);

  return (
    <TableWrap caption={caption}>
      <thead>
        <tr>
          <th scope="col">{heading}</th>
          <th scope="col">Count</th>
          <th scope="col">
            <span className="sr-only">Share of the largest kind</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {ordered.map((row) => (
          <tr key={row.kind}>
            <td>{row.kind}</td>
            <td>{row.count}</td>
            <td className="magnitude-cell">
              <span
                className="magnitude-bar"
                data-testid="magnitude-bar"
                aria-hidden="true"
                style={
                  {
                    // Scaled against the largest kind, so the column compares
                    // kinds to each other rather than to an invented ceiling.
                    '--magnitude': `${String(largest === 0 ? 0 : Math.round((row.count / largest) * 100))}%`,
                  } as CSSProperties
                }
              />
            </td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
