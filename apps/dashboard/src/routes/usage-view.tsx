import { ResourcePanel, TableWrap, Unavailable } from '../components/panel.js';
import type { PulseSnapshot } from '../pulse/model.js';

type UsageRow = PulseSnapshot['usage'][number];

/**
 * Usage by observation source.
 *
 * Sources are never summed. Exact, reported, adapter-extracted, and estimated
 * records carry different provenance, and `unavailable` records have no token
 * value at all; a combined figure would be a number the runtime never observed.
 * An absent `totalTokens` renders as "Not reported" rather than zero, per ADR
 * 0010. It is worded differently from the `unavailable` source label so the two
 * distinct meanings are not confused: one is a source that reported nothing,
 * the other is a token value that was never observed.
 */
export function UsageView({ snapshot }: { snapshot: PulseSnapshot }) {
  const resource =
    snapshot.usageState === 'ready'
      ? ({ state: 'ready', data: snapshot.usage } as const)
      : ({ state: 'unavailable' } as const);

  return (
    <div className="route-stack">
      <ResourcePanel<UsageRow[]>
        title="Usage by source"
        resource={resource}
        emptyMessage="No usage observations"
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <>
            <TableWrap caption="Usage records by observation source" tall>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Records</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.source}>
                    <td>{row.label}</td>
                    <td>{row.records}</td>
                    <td>
                      {row.totalTokens === undefined ? (
                        <Unavailable label="Not reported" />
                      ) : (
                        row.totalTokens
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <p className="bounded-note">
              Sources are reported separately and never combined. Records with an unavailable token
              value are excluded from every total rather than counted as zero.
            </p>
          </>
        )}
      </ResourcePanel>
    </div>
  );
}
