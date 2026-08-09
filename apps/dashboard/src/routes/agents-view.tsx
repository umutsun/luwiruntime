import { IdBadge } from '../components/id-badge.js';
import { Count, ResourcePanel, TableWrap, Unavailable } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';

type AgentRow = PulseSnapshot['agents'][number];

/**
 * Agent definitions.
 *
 * `kind` and `adapterId` are printed exactly as the API returns them. There is
 * no label map and no per-vendor branch, so a new agent kind needs no dashboard
 * change and no existing one is privileged.
 */
export function AgentsView({ snapshot }: { snapshot: PulseSnapshot }) {
  const resource =
    snapshot.agentsState === 'ready'
      ? ({ state: 'ready', data: snapshot.agents } as const)
      : ({ state: 'unavailable' } as const);

  return (
    <div className="route-stack">
      <ResourcePanel<AgentRow[]>
        title="Agent definitions"
        meta={snapshot.agentsState === 'ready' ? `${snapshot.agents.length} registered` : undefined}
        resource={resource}
        emptyMessage="No agent definitions registered"
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <TableWrap caption="Registered agent definitions">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Kind</th>
                <th scope="col">Adapter</th>
                <th scope="col">Version</th>
                <th scope="col">State</th>
                <th scope="col">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.displayName}
                    <small>
                      <IdBadge id={row.id} label="agent" />
                    </small>
                  </td>
                  <td>{row.kind}</td>
                  <td>{row.adapterId}</td>
                  <td>{row.detectedVersion ?? <Unavailable label="Undetected" />}</td>
                  <td>
                    <StatusChip tone={row.enabled ? 'success' : 'unknown'}>
                      {row.enabled ? 'Enabled' : 'Disabled'}
                    </StatusChip>
                  </td>
                  <td>
                    <Count value={row.sessionCount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>
    </div>
  );
}
