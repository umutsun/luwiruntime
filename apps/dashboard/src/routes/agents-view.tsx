import { IdBadge } from '../components/id-badge.js';
import { Count, Panel, ResourcePanel, TableWrap, Unavailable } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';

type AgentRow = PulseSnapshot['agents'][number];

/**
 * The models an agent's sessions reported about themselves. A session that
 * reported none leaves a muted dash rather than a name LUWI never observed, and
 * an unavailable session read says so instead of reading as "no models".
 */
function ModelsCell({
  models,
  sessions,
}: {
  models: string[];
  sessions: AgentRow['sessionCount'];
}) {
  if (sessions.state === 'unavailable') return <Unavailable />;
  if (models.length === 0) {
    return (
      <span className="work-dim" aria-label="No model reported">
        —
      </span>
    );
  }
  return <>{models.join(', ')}</>;
}

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
                <th scope="col">Models seen</th>
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
                    <ModelsCell models={row.models} sessions={row.sessionCount} />
                  </td>
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

      {/*
       * Sessions name their agent by an opaque id, and a launcher hook names the
       * vendor rather than a registered definition. Those ids are listed as what
       * they are — seen, unregistered — instead of being folded into a
       * definition the runtime never read, or dropped from the count entirely.
       */}
      {snapshot.unregisteredAgents.length === 0 ? null : (
        <Panel
          title="Seen in sessions without a definition"
          meta={`${String(snapshot.unregisteredAgents.length)} ${
            snapshot.unregisteredAgents.length === 1 ? 'id' : 'ids'
          }`}
        >
          <TableWrap caption="Agent ids observed in sessions that no registered definition covers">
            <thead>
              <tr>
                <th scope="col">Agent id</th>
                <th scope="col">Sessions</th>
                <th scope="col">Models seen</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.unregisteredAgents.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.id}</code>
                  </td>
                  <td>{row.sessionCount}</td>
                  <td>
                    <ModelsCell
                      models={row.models}
                      sessions={{ state: 'ready', value: row.sessionCount }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Panel>
      )}
    </div>
  );
}
