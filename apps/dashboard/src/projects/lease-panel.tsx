import type { Bounded, ProjectLease } from '../api/lease-scope.js';
import { remainingMs } from '../api/lease-scope.js';
import { ResourcePanel, type ResourceState } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';

/**
 * The work leases held in this project right now.
 *
 * This is the only surface that answers "is anyone already working there".
 * It renders held leases only — released and expired ones are history, and a
 * list mixing them would make a free path look taken.
 *
 * Nothing here takes, extends, or breaks a lease. Leases are held by sessions
 * through MCP, and a dashboard that could break one would be enforcing a hold
 * the runtime deliberately keeps advisory.
 */

function Remaining({ lease, nowMs }: { lease: ProjectLease; nowMs: number }) {
  const left = remainingMs(lease, nowMs);
  if (left === undefined) {
    // An unreadable expiry is not "no time left"; it is no measurement.
    return <span className="unavailable">Not recorded</span>;
  }
  if (left === 0) {
    // Held past its expiry: the sweep has not reached it yet. Saying "0s" would
    // suggest it is still holding for a moment longer.
    return <StatusChip tone="warning">Expiring</StatusChip>;
  }
  const seconds = Math.round(left / 1000);
  return <>{seconds < 60 ? `${String(seconds)}s` : `${String(Math.round(seconds / 60))}m`}</>;
}

export function LeasePanel({
  leases,
  loading = false,
  nowMs,
}: {
  leases: ResourceState<Bounded<ProjectLease>> | undefined;
  loading?: boolean;
  /** Passed in rather than read from the clock so the rendered time is testable. */
  nowMs: number;
}) {
  const held = leases?.state === 'ready' ? leases.data.items.filter((l) => l.state === 'held') : [];

  return (
    <ResourcePanel<Bounded<ProjectLease>>
      title="Work leases"
      meta={leases?.state === 'ready' ? `${String(held.length)} held` : undefined}
      collapsible
      resource={leases}
      loading={loading}
      emptyMessage="No paths are claimed in this project"
      isEmpty={(value) => value.items.filter((lease) => lease.state === 'held').length === 0}
    >
      {(value) => (
        <>
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Held work leases</caption>
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  {/* The holder is a session, but the agent is what a reader
                      recognises, so the session id rides underneath it rather
                      than taking a column of its own in a half-width panel. */}
                  <th scope="col">Held by</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Expires in</th>
                </tr>
              </thead>
              <tbody>
                {held.map((lease) => (
                  <tr key={lease.id}>
                    <td>
                      <code title={lease.path}>{lease.path}</code>
                    </td>
                    <td>
                      {lease.agentId}
                      <small title={lease.sessionId}>{lease.sessionId}</small>
                    </td>
                    <td>{lease.reason}</td>
                    <td>
                      <Remaining lease={lease} nowMs={nowMs} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="bounded-note">
            A lease is advisory. It records that a session claimed a path and lets the runtime
            refuse an overlapping claim; it cannot stop an agent that never asked. Releasing one is
            the holder&apos;s to do.
          </p>
          {value.truncated ? (
            <p className="bounded-note">
              Bounded list — more leases exist in this project than are shown.
            </p>
          ) : null}
        </>
      )}
    </ResourcePanel>
  );
}
