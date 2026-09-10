import { useEffect, useMemo, useState } from 'react';

import type { AgentMessage, Bounded, MessageState } from '../api/messages-scope.js';
import type { RetainedWakeCollection, WakeIntent } from '../api/wake-scope.js';
import { DetailDrawer } from '../components/detail-drawer.js';
import { IdBadge } from '../components/id-badge.js';
import { PanelBody, ResourcePanel, TableWrap, type ResourceState } from '../components/panel.js';
import { StatusChip, type StatusTone } from '../components/status-chip.js';
import type { Availability, PulseSnapshot } from '../pulse/model.js';

/**
 * Inter-agent messaging, read-only.
 *
 * Eight `message.*` event types have been reaching Activity since Phase 2, so a
 * user could always see that a request happened and never what it was. This
 * route answers the questions the event row cannot: who asked whom, what was
 * asked, what came back, and why the runtime chose that recipient.
 *
 * No control here sends, cancels, retries, or answers anything. The daemon
 * serves those endpoints and AGENTS.md section 21 keeps them off every read
 * surface.
 */

const stateLabels: Record<MessageState, string> = {
  queued: 'Queued',
  delivered: 'Delivered',
  acknowledged: 'Acknowledged',
  processing: 'Processing',
  responded: 'Responded',
  rejected: 'Rejected',
  timed_out: 'Timed out',
  failed: 'Failed',
};

/**
 * Tone follows outcome, not severity.
 *
 * `rejected` is a legitimate answer — an agent declining a request it should
 * decline — so it is not painted as a fault. `timed_out` and `failed` are, and
 * `queued` through `processing` are simply in flight. Every state also renders
 * its label as text, so none of this is carried by colour alone.
 */
const stateTones: Record<MessageState, StatusTone> = {
  queued: 'unknown',
  delivered: 'info',
  acknowledged: 'info',
  processing: 'info',
  responded: 'success',
  rejected: 'warning',
  timed_out: 'danger',
  failed: 'danger',
};

const TERMINAL: readonly MessageState[] = ['responded', 'rejected', 'timed_out', 'failed'];

const wakeStateLabels: Record<WakeIntent['state'], string> = {
  pending: 'Pending',
  claimed: 'Claimed',
  dispatching: 'Dispatching',
  dispatched: 'Dispatched',
  fallback_only: 'Fallback only',
  indeterminate: 'Indeterminate',
};

function StateChip({ state }: { state: MessageState }) {
  return <StatusChip tone={stateTones[state]}>{stateLabels[state]}</StatusChip>;
}

/**
 * How long the exchange took, when the runtime observed both ends.
 *
 * Only computed for a message that reached a terminal state and recorded when.
 * An in-flight message has no duration yet, and a terminal one with no
 * `respondedAt` was ended by something that never wrote a timestamp — a timeout
 * sweep, for instance — so both render as unavailable rather than as zero.
 */
function turnaround(message: AgentMessage): string | undefined {
  if (message.respondedAt === undefined) return undefined;
  const started = Date.parse(message.createdAt);
  const ended = Date.parse(message.respondedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  const seconds = Math.round((ended - started) / 1000);
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.round(seconds / 60))}m`;
}

export function MessagesView({
  messages,
  loading = false,
  selectedCorrelationId,
  onCloseRoutedDetail,
  wakeIntents,
  sessions = [],
}: {
  messages: ResourceState<Bounded<AgentMessage>> | undefined;
  loading?: boolean;
  selectedCorrelationId?: string;
  onCloseRoutedDetail?: () => void;
  wakeIntents?: Availability<RetainedWakeCollection<WakeIntent>>;
  sessions?: PulseSnapshot['sessions'];
}) {
  const [stateFilter, setStateFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string>();

  const all = messages?.state === 'ready' ? messages.data.items : [];

  useEffect(() => {
    if (selectedCorrelationId === undefined) return;
    const matched = all.find((message) => message.correlationId === selectedCorrelationId);
    setSelectedId(matched?.id);
  }, [all, selectedCorrelationId]);
  const statesPresent = useMemo(
    () => [...new Set(all.map((message) => message.state))].sort(),
    [all],
  );
  const selected = all.find((message) => message.id === selectedId);
  const selectedWake =
    selected === undefined || wakeIntents?.state !== 'ready'
      ? undefined
      : wakeIntents.data.items.find((intent) => intent.messageId === selected.id);
  const targetSession =
    selected === undefined
      ? undefined
      : sessions.find((session) => session.id === selected.targetSessionId);

  const filtered = useMemo(
    () => (stateFilter === '' ? all : all.filter((message) => message.state === stateFilter)),
    [all, stateFilter],
  );

  const inFlight = all.filter((message) => !TERMINAL.includes(message.state)).length;

  return (
    <div className="route-stack">
      <ResourcePanel<Bounded<AgentMessage>>
        title="Messages"
        meta={
          messages?.state === 'ready'
            ? `${String(all.length)} retained · ${String(inFlight)} in flight`
            : undefined
        }
        resource={messages}
        loading={loading}
        emptyMessage="No messages recorded between agents"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <PanelBody>
              <div className="table-filters">
                <label>
                  State
                  <select
                    value={stateFilter}
                    onChange={(event) => setStateFilter(event.target.value)}
                  >
                    <option value="">All states</option>
                    {statesPresent.map((state) => (
                      <option key={state} value={state}>
                        {stateLabels[state]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </PanelBody>

            {filtered.length === 0 ? (
              <PanelBody>
                <p className="empty-state">No messages match this filter</p>
              </PanelBody>
            ) : (
              <TableWrap caption="Inter-agent messages" tall>
                <thead>
                  <tr>
                    <th scope="col">From</th>
                    <th scope="col">To</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Kind</th>
                    <th scope="col">State</th>
                    <th scope="col">Turnaround</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((message) => {
                    const took = turnaround(message);
                    return (
                      <tr key={message.id} aria-selected={message.id === selectedId}>
                        <td>
                          <IdBadge id={message.sourceAgentId} label="source agent" />
                        </td>
                        <td>
                          <IdBadge id={message.targetAgentId} label="target agent" />
                        </td>
                        <td>
                          {message.subject ?? <span className="unavailable">No subject</span>}
                        </td>
                        <td>{message.kind}</td>
                        <td>
                          <StateChip state={message.state} />
                        </td>
                        <td>{took ?? <span className="unavailable">Not recorded</span>}</td>
                        <td>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedId(message.id === selectedId ? undefined : message.id);
                            }}
                          >
                            {message.id === selectedId ? 'Hide' : 'Open'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableWrap>
            )}

            <PanelBody>
              <p className="bounded-note">
                Message kinds and states are rendered exactly as the runtime records them. A
                rejected message is an answer, not a fault: it means the recipient declined, and the
                reason is in its response.
              </p>
              {value.truncated ? (
                <p className="bounded-note">
                  Bounded list — more messages exist than are shown. Truncation is disclosed rather
                  than hidden.
                </p>
              ) : null}
            </PanelBody>
          </>
        )}
      </ResourcePanel>

      {selected === undefined ? null : (
        <DetailDrawer
          eyebrow="Read-only evidence"
          title="Message detail"
          meta={selected.correlationId}
          onClose={() => {
            setSelectedId(undefined);
            onCloseRoutedDetail?.();
          }}
        >
          <dl className="key-values">
            <div>
              <dt>Correlation</dt>
              <dd>
                <code title={selected.correlationId}>{selected.correlationId}</code>
              </dd>
            </div>
            <div>
              <dt>From session</dt>
              <dd>
                <code title={selected.sourceSessionId}>{selected.sourceSessionId}</code>
              </dd>
            </div>
            <div>
              <dt>To session</dt>
              <dd>
                <code title={selected.targetSessionId}>{selected.targetSessionId}</code>
              </dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>{selected.createdAt}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{selected.deadlineAt}</dd>
            </div>
            <div>
              <dt>Acknowledged</dt>
              <dd>
                {selected.acknowledgedAt ?? <span className="unavailable">Not acknowledged</span>}
              </dd>
            </div>
          </dl>

          {wakeIntents === undefined ? null : (
            <>
              <p className="group-label">
                <span>Delivery</span>
              </p>
              <dl className="key-values">
                <div>
                  <dt>Target session</dt>
                  <dd>
                    {targetSession === undefined ? (
                      <span className="unavailable">Not in the retained session read</span>
                    ) : (
                      `${targetSession.statusLabel} · ${targetSession.presence}`
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Target bridge</dt>
                  <dd>
                    {targetSession === undefined || targetSession.bridge.state === 'unavailable' ? (
                      <span className="unavailable">Unavailable</span>
                    ) : targetSession.bridge.state === 'unknown' ? (
                      <span className="unavailable">Bridge evidence incomplete</span>
                    ) : targetSession.bridge.state === 'not-observed' ? (
                      <span className="unavailable">No bridge observed</span>
                    ) : (
                      <span>
                        {`${targetSession.bridge.provider} · Declared profile: ${targetSession.bridge.executionProfile}`}{' '}
                        <StatusChip
                          tone={targetSession.bridge.health === 'active' ? 'success' : 'warning'}
                        >
                          {targetSession.bridge.health.charAt(0).toUpperCase() +
                            targetSession.bridge.health.slice(1)}
                        </StatusChip>
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Wake state</dt>
                  <dd>
                    {wakeIntents.state === 'unavailable' ? (
                      <span className="unavailable">Wake evidence unavailable</span>
                    ) : selectedWake === undefined ? (
                      wakeIntents.data.truncated ? (
                        <span className="unavailable">Wake evidence incomplete</span>
                      ) : (
                        <span className="unavailable">No automatic coordinator wake recorded</span>
                      )
                    ) : (
                      wakeStateLabels[selectedWake.state]
                    )}
                  </dd>
                </div>
                {selectedWake === undefined ? null : (
                  <>
                    <div>
                      <dt>Wake requested</dt>
                      <dd>{selectedWake.createdAt}</dd>
                    </div>
                    <div>
                      <dt>Wake updated</dt>
                      <dd>{selectedWake.updatedAt}</dd>
                    </div>
                    <div>
                      <dt>Workflow</dt>
                      <dd>{selectedWake.workflowId}</dd>
                    </div>
                    <div>
                      <dt>Wake reason</dt>
                      <dd>
                        {selectedWake.reasonCode ?? (
                          <span className="unavailable">Not recorded</span>
                        )}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              <p className="bounded-note">
                {wakeIntents.state === 'unavailable'
                  ? 'Automatic wake evidence is unavailable; the durable inbox remains authoritative.'
                  : selectedWake === undefined
                    ? wakeIntents.data.truncated
                      ? 'The retained wake sample is truncated, so this message’s wake path is unknown.'
                      : 'No automatic coordinator wake was recorded; the durable inbox is authoritative.'
                    : selectedWake.state === 'fallback_only'
                      ? 'Automatic wake was unavailable; the durable inbox is the only delivery path.'
                      : selectedWake.state === 'indeterminate'
                        ? 'Wake delivery is indeterminate; the durable inbox remains authoritative.'
                        : 'The durable inbox remains authoritative while automatic wake is observed.'}
              </p>
            </>
          )}

          {/* The runtime records why it picked this recipient. Without it a
              reader cannot tell a deliberate route from an arbitrary one. */}
          <p className="group-label">
            <span>Routing</span>
          </p>
          <p className="bounded-note">{selected.selectionReason}</p>

          <p className="group-label">
            <span>Request</span>
          </p>
          <pre className="message-body">{selected.content}</pre>

          {selected.evidenceRequirements.length === 0 ? null : (
            <>
              <p className="group-label">
                <span>Evidence required</span>
                <span className="group-label__count">{selected.evidenceRequirements.length}</span>
              </p>
              <ul className="name-list">
                {selected.evidenceRequirements.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>
            </>
          )}

          <p className="group-label">
            <span>Response</span>
          </p>
          {selected.response === undefined ? (
            <p className="empty-state">
              {TERMINAL.includes(selected.state)
                ? 'This exchange ended without a recorded response.'
                : 'Still in flight — no response has been recorded yet.'}
            </p>
          ) : (
            <>
              <dl className="key-values">
                <div>
                  <dt>Status</dt>
                  <dd>{selected.response.status}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>
                    {selected.response.confidence === undefined ? (
                      <span className="unavailable">Not reported</span>
                    ) : (
                      selected.response.confidence.toFixed(2)
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Evidence items</dt>
                  <dd>{selected.response.evidenceCount}</dd>
                </div>
                <div>
                  <dt>Verified</dt>
                  <dd>{selected.response.verifiedAt}</dd>
                </div>
              </dl>
              <pre className="message-body">{selected.response.answer}</pre>
            </>
          )}
        </DetailDrawer>
      )}
    </div>
  );
}
