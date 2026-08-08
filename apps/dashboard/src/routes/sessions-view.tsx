import { ResourcePanel, TableWrap, Unavailable } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';

type SessionRow = PulseSnapshot['sessions'][number];

/**
 * Every session, not only the active subset Pulse shows.
 *
 * A session whose project cannot be resolved renders `Unavailable` for the
 * project rather than being hidden: the session was still observed, and
 * dropping it would under-report what the runtime saw.
 */
export function SessionsView({ snapshot }: { snapshot: PulseSnapshot }) {
  const resource =
    snapshot.sessionsState === 'ready'
      ? ({ state: 'ready', data: snapshot.sessions } as const)
      : ({ state: 'unavailable' } as const);

  return (
    <div className="route-stack">
      <ResourcePanel<SessionRow[]>
        title="Sessions"
        meta={
          snapshot.sessionsState === 'ready' ? `${snapshot.sessions.length} observed` : undefined
        }
        resource={resource}
        emptyMessage="No sessions observed"
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <TableWrap caption="Observed sessions">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Agent</th>
                <th scope="col">Project</th>
                <th scope="col">Status</th>
                <th scope="col">Presence</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.id}</code>
                  </td>
                  <td>
                    <code>{row.agentId}</code>
                  </td>
                  <td>{row.projectName === 'Unavailable' ? <Unavailable /> : row.projectName}</td>
                  <td>{row.statusLabel}</td>
                  <td>
                    <StatusChip tone={row.presence === 'online' ? 'success' : 'unknown'}>
                      {row.presence === 'online' ? 'Online' : 'Offline'}
                    </StatusChip>
                  </td>
                  <td>{row.startedAt}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>
    </div>
  );
}
