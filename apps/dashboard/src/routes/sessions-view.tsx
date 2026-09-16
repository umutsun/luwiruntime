import { useState } from 'react';

import type { CoordinatorMutations } from '../api/coordinator-mutations.js';
import type { MessageMutations } from '../api/message-mutations.js';
import { formatRelativeTime } from '../components/format.js';
import { IdBadge } from '../components/id-badge.js';
import { ResourcePanel, TableWrap, Unavailable } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';
import { AskSessionDialog } from './ask-session-dialog.js';

type SessionRow = PulseSnapshot['sessions'][number];

type SortKey = 'agent' | 'status' | 'started';
type SortDirection = 'ascending' | 'descending';

const systemNow = (): Date => new Date();

function compareRows(left: SessionRow, right: SessionRow, key: SortKey): number {
  if (key === 'agent') return left.agentId.localeCompare(right.agentId);
  if (key === 'status') return left.statusLabel.localeCompare(right.statusLabel);
  const leftMs = Date.parse(left.startedAt);
  const rightMs = Date.parse(right.startedAt);
  // Unparseable timestamps sort as oldest so they never displace real evidence.
  return (Number.isFinite(leftMs) ? leftMs : 0) - (Number.isFinite(rightMs) ? rightMs : 0);
}

function SortHeader({
  label,
  sortKey,
  active,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: { key: SortKey; direction: SortDirection } | undefined;
  onSort: (key: SortKey) => void;
}) {
  return (
    <th scope="col" aria-sort={active?.key === sortKey ? active.direction : undefined}>
      <button
        className="sort-header"
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {active?.key === sortKey ? (
          <span aria-hidden="true">{active.direction === 'ascending' ? '↑' : '↓'}</span>
        ) : null}
      </button>
    </th>
  );
}

/**
 * Every session, not only the active subset Pulse shows.
 *
 * A session whose project cannot be resolved renders `Unavailable` for the
 * project rather than being hidden: the session was still observed, and
 * dropping it would under-report what the runtime saw. Filtering follows the
 * same rule — the meta line keeps the total, and a filter that matches nothing
 * says so instead of impersonating an empty runtime.
 */
export function SessionsView({
  snapshot,
  onOpenSession,
  messageMutations,
  onMessageCreated,
  coordinatorMutations,
  onCoordinatorMutated,
  now = systemNow,
}: {
  snapshot: PulseSnapshot;
  onOpenSession?: (session: SessionRow, opener: HTMLElement) => void;
  messageMutations?: MessageMutations;
  onMessageCreated?: (correlationId: string) => void;
  /** Absent keeps the sessions route free of coordinator assignment (ADR 0035). */
  coordinatorMutations?: CoordinatorMutations;
  /** Called after a claim/release so the snapshot (and its badge) can be re-read. */
  onCoordinatorMutated?: () => void;
  now?: () => Date;
}) {
  const [statusFilter, setStatusFilter] = useState('');
  const [presenceFilter, setPresenceFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'started',
    direction: 'descending',
  });
  const [askTarget, setAskTarget] = useState<SessionRow>();
  const [coordinatorBusy, setCoordinatorBusy] = useState<string>();
  const [coordinatorNote, setCoordinatorNote] = useState<{
    tone: 'ok' | 'danger';
    message: string;
  }>();
  const coordinatorEnabled =
    coordinatorMutations !== undefined && onCoordinatorMutated !== undefined;
  const isCoordinator = (row: SessionRow): boolean => {
    const held = snapshot.coordinatorByProject[row.projectId];
    return held !== undefined && held.live && held.sessionId === row.id;
  };
  const runCoordinator = async (row: SessionRow, action: 'claim' | 'release'): Promise<void> => {
    if (coordinatorMutations === undefined || onCoordinatorMutated === undefined) return;
    setCoordinatorBusy(row.id);
    setCoordinatorNote(undefined);
    const result =
      action === 'claim'
        ? await coordinatorMutations.claim(row.projectId, row.id)
        : await coordinatorMutations.release(row.projectId, row.id);
    setCoordinatorBusy(undefined);
    if (result.state === 'ok') {
      setCoordinatorNote({
        tone: 'ok',
        message: action === 'claim' ? 'Coordinator assigned.' : 'Coordinator released.',
      });
      onCoordinatorMutated();
      return;
    }
    setCoordinatorNote({
      tone: 'danger',
      message:
        result.state === 'failed' && result.reason === 'http'
          ? result.message
          : 'The coordinator update could not be completed.',
    });
  };
  const resource =
    snapshot.sessionsState === 'ready'
      ? ({ state: 'ready', data: snapshot.sessions } as const)
      : ({ state: 'unavailable' } as const);
  const nowMs = now().getTime();

  const statusLabels = [...new Set(snapshot.sessions.map((row) => row.statusLabel))].sort();
  const toggleSort = (key: SortKey) =>
    setSort((previous) => ({
      key,
      direction:
        previous.key === key && previous.direction === 'descending'
          ? 'ascending'
          : key === 'started' && previous.key !== key
            ? 'descending'
            : previous.key === key
              ? 'descending'
              : 'ascending',
    }));

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
        {(rows) => {
          const filtered = rows.filter(
            (row) =>
              (statusFilter === '' || row.statusLabel === statusFilter) &&
              (presenceFilter === '' || row.presence === presenceFilter),
          );
          const sorted = [...filtered].sort((left, right) => {
            const order = compareRows(left, right, sort.key);
            return sort.direction === 'ascending' ? order : -order;
          });
          return (
            <>
              <div className="table-filters" aria-label="Session filters">
                <label>
                  Status
                  <select
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="">All</option>
                    {statusLabels.map((label) => (
                      <option key={label} value={label}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Presence
                  <select
                    value={presenceFilter}
                    onChange={(event) => setPresenceFilter(event.target.value)}
                  >
                    <option value="">All</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                  </select>
                </label>
                {filtered.length === rows.length ? null : (
                  <span className="table-filters__count" role="status">
                    {filtered.length} of {rows.length} shown
                  </span>
                )}
              </div>
              {sorted.length === 0 ? (
                <p className="empty-state">No sessions match the current filters</p>
              ) : (
                <div className="session-registry">
                  <TableWrap caption="Observed sessions" tall>
                    <thead>
                      <tr>
                        <th scope="col">Session</th>
                        <SortHeader
                          label="Agent"
                          sortKey="agent"
                          active={sort}
                          onSort={toggleSort}
                        />
                        <th scope="col">Project</th>
                        <SortHeader
                          label="Status"
                          sortKey="status"
                          active={sort}
                          onSort={toggleSort}
                        />
                        <th scope="col">Presence</th>
                        <SortHeader
                          label="Started"
                          sortKey="started"
                          active={sort}
                          onSort={toggleSort}
                        />
                        <th scope="col">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <IdBadge id={row.id} label="session" />
                            {isCoordinator(row) ? (
                              <StatusChip tone="success">Coordinator</StatusChip>
                            ) : null}
                          </td>
                          <td>
                            <IdBadge id={row.agentId} label="agent" />
                          </td>
                          <td>
                            {row.projectName === 'Unavailable' ? <Unavailable /> : row.projectName}
                          </td>
                          <td>{row.statusLabel}</td>
                          <td>
                            <StatusChip tone={row.presence === 'online' ? 'success' : 'unknown'}>
                              {row.presence === 'online' ? 'Online' : 'Offline'}
                            </StatusChip>
                          </td>
                          <td>
                            <time dateTime={row.startedAt} title={row.startedAt}>
                              {formatRelativeTime(row.startedAt, nowMs)}
                            </time>
                          </td>
                          <td>
                            <div className="row-actions">
                              {coordinatorEnabled && isCoordinator(row) ? (
                                <button
                                  className="coordinator-button"
                                  type="button"
                                  disabled={coordinatorBusy === row.id}
                                  onClick={() => void runCoordinator(row, 'release')}
                                  aria-label={`Release the coordinator role from session ${row.id}`}
                                >
                                  Release role
                                </button>
                              ) : null}
                              {coordinatorEnabled &&
                              !isCoordinator(row) &&
                              row.presence === 'online' ? (
                                <button
                                  className="coordinator-button"
                                  type="button"
                                  disabled={coordinatorBusy === row.id}
                                  onClick={() => void runCoordinator(row, 'claim')}
                                  aria-label={`Make session ${row.id} the coordinator`}
                                >
                                  Make coordinator
                                </button>
                              ) : null}
                              {messageMutations === undefined ||
                              onMessageCreated === undefined ||
                              row.presence !== 'online' ||
                              !rows.some(
                                (source) =>
                                  source.id !== row.id &&
                                  source.projectId === row.projectId &&
                                  source.presence === 'online',
                              ) ? null : (
                                <button
                                  className="ask-button"
                                  type="button"
                                  onClick={() => setAskTarget(row)}
                                  aria-label={`Ask session ${row.id}`}
                                >
                                  Ask
                                </button>
                              )}
                              {onOpenSession === undefined ? null : (
                                <button
                                  className="inspect-button"
                                  type="button"
                                  onClick={(event) => onOpenSession(row, event.currentTarget)}
                                  aria-label={`Inspect session ${row.id}`}
                                >
                                  Inspect
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableWrap>
                </div>
              )}
              {coordinatorNote === undefined ? null : (
                <p
                  className={
                    coordinatorNote.tone === 'ok'
                      ? 'coordinator-note coordinator-note--ok'
                      : 'coordinator-note coordinator-note--danger'
                  }
                  role="status"
                >
                  {coordinatorNote.message}
                </p>
              )}
            </>
          );
        }}
      </ResourcePanel>
      {askTarget === undefined || messageMutations === undefined ? null : (
        <AskSessionDialog
          target={askTarget}
          sources={snapshot.sessions.filter(
            (source) =>
              source.id !== askTarget.id &&
              source.projectId === askTarget.projectId &&
              source.presence === 'online',
          )}
          mutations={messageMutations}
          onSuccess={(correlationId) => {
            setAskTarget(undefined);
            onMessageCreated?.(correlationId);
          }}
          onCancel={() => setAskTarget(undefined)}
        />
      )}
    </div>
  );
}
