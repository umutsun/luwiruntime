import type { GraphSummary, KindCount } from '../api/intelligence-scope.js';
import { ResourcePanel, TableWrap, Unavailable, type ResourceState } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';

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
export function GraphView({ summary }: { summary: ResourceState<GraphSummary> | undefined }) {
  const perKind = (data: GraphSummary, counts: KindCount[]): ResourceState<KindCount[]> =>
    data.observed ? { state: 'ready', data: counts } : { state: 'not-observed' };
  const generation = summary?.state === 'ready' ? summary.data.generation : undefined;

  return (
    <div className="route-stack">
      <ResourcePanel<GraphSummary>
        title="Projection"
        resource={summary}
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

/** Kinds are rendered verbatim; the dashboard owns no label map for them. */
function KindTable({
  caption,
  heading,
  rows,
}: {
  caption: string;
  heading: string;
  rows: KindCount[];
}) {
  return (
    <TableWrap caption={caption}>
      <thead>
        <tr>
          <th scope="col">{heading}</th>
          <th scope="col">Count</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.kind}>
            <td>{row.kind}</td>
            <td>{row.count}</td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
