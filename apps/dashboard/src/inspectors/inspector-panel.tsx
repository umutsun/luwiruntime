import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Count } from '../components/panel.js';
import type { CountValue, PulseProject, PulseSession } from '../pulse/model.js';
import { compareStreamIds } from '../realtime/activity-store.js';
import type { DashboardEvent } from '../realtime/schema.js';

export type ProjectInspection = PulseProject & { activeSessions: CountValue };
export type SessionInspection = PulseSession & { projectName: string; statusLabel: string };

export type InspectorSelection =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'event'; streamId: string };

const MAX_JSON_CHARACTERS = 8192;
export const RELATED_ACTIVITY_LIMIT = 20;
const SESSION_DURATION_TICK_MS = 60_000;
const systemNow = (): Date => new Date();

export function formatSafeJson(value: unknown): string {
  let formatted: string;
  try {
    formatted = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    formatted = 'Payload unavailable';
  }
  return formatted.length <= MAX_JSON_CHARACTERS
    ? formatted
    : `${formatted.slice(0, MAX_JSON_CHARACTERS)}…`;
}

/**
 * A foldable block inside an inspector.
 *
 * The event inspector stacks an identity list, a payload and a navigation
 * block, and all of them were always open — so a real event became a column
 * you scroll past to reach what you wanted. The identity list stays open
 * because it is what names the record; everything below it folds, and the
 * payload starts folded because it is the tallest and the least often needed.
 */
function InspectorSection({
  title,
  className,
  defaultCollapsed = false,
  children,
}: {
  title: string;
  className?: string;
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const id = `inspector-section-${title.toLowerCase().replaceAll(' ', '-')}`;

  return (
    <section className={className} aria-labelledby={id}>
      <h3>
        <button
          type="button"
          className="inspector-section__toggle"
          aria-expanded={!collapsed}
          aria-controls={`${id}-body`}
          id={id}
          onClick={() => {
            setCollapsed((value) => !value);
          }}
        >
          <span className="panel__toggle-icon" aria-hidden="true" />
          {title}
        </button>
      </h3>
      <div id={`${id}-body`} hidden={collapsed}>
        {collapsed ? null : children}
      </div>
    </section>
  );
}

function DetailList({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="inspector-details">
      {rows.flatMap(([label, value]) =>
        value === undefined
          ? []
          : [
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>,
            ],
      )}
    </dl>
  );
}

function relatedActivity(
  activity: readonly DashboardEvent[],
  matches: (event: DashboardEvent) => boolean,
): DashboardEvent[] {
  const unique = new Map<string, DashboardEvent>();
  for (const event of activity) unique.set(event.streamId, event);
  return [...unique.values()]
    .filter(matches)
    .sort((left, right) => compareStreamIds(right.streamId, left.streamId))
    .slice(0, RELATED_ACTIVITY_LIMIT);
}

function RelatedActivity({ events }: { events: readonly DashboardEvent[] }) {
  return (
    <section className="inspector-related" aria-labelledby="related-activity-title">
      <h3 id="related-activity-title">Related activity</h3>
      <p>Most recent events in the local retained Activity window</p>
      {events.length === 0 ? (
        <p className="empty-state">No related activity in the retained window</p>
      ) : (
        <ol>
          {events.map((event) => (
            <li key={event.streamId}>
              <strong>{event.type}</strong>
              <span>{event.id}</span>
              <code>{event.streamId}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourLabel = `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
  const minuteLabel = `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return hours === 0 ? minuteLabel : `${hourLabel} ${minuteLabel}`;
}

export function sessionDuration(session: SessionInspection, nowMs: number): string {
  if (session.status === 'completed' || session.status === 'disconnected') return 'Unavailable';
  const startedAt = Date.parse(session.startedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs) || nowMs < startedAt) {
    return 'Unavailable';
  }
  return formatDuration(nowMs - startedAt);
}

export function InspectorPanel({
  selection,
  activity = [],
  projects = [],
  sessions = [],
  onNavigate,
  now = systemNow,
  onClose,
}: {
  selection: InspectorSelection;
  activity?: readonly DashboardEvent[];
  projects?: readonly ProjectInspection[];
  sessions?: readonly SessionInspection[];
  onNavigate?: (selection: InspectorSelection) => void;
  now?: () => Date;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const selectedProject =
    selection.kind === 'project'
      ? projects.find((candidate) => candidate.id === selection.projectId)
      : undefined;
  const selectedSession =
    selection.kind === 'session'
      ? sessions.find((candidate) => candidate.id === selection.sessionId)
      : undefined;
  const selectedEvent =
    selection.kind === 'event'
      ? activity.find((candidate) => candidate.streamId === selection.streamId)
      : undefined;
  const eligibilityNowMs = useMemo(
    () => (selection.kind === 'session' ? now().getTime() : 0),
    [now, selectedSession?.id, selectedSession?.startedAt, selectedSession?.status, selection.kind],
  );
  const selectedStartedAt =
    selectedSession === undefined ? Number.NaN : Date.parse(selectedSession.startedAt);
  const activeSessionKey =
    selectedSession !== undefined &&
    selectedSession.status !== 'completed' &&
    selectedSession.status !== 'disconnected' &&
    Number.isFinite(selectedStartedAt) &&
    Number.isFinite(eligibilityNowMs) &&
    eligibilityNowMs >= selectedStartedAt
      ? `${selectedSession.id}:${selectedSession.startedAt}`
      : undefined;
  const previousClockTarget = useRef(activeSessionKey);
  const [clockNowMs, setClockNowMs] = useState(eligibilityNowMs);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const close = useCallback(() => {
    const target = returnFocus.current;
    onClose();
    queueMicrotask(() => target?.focus());
  }, [onClose]);
  /*
   * Two effects, because they answer to different things.
   *
   * Focus belongs to the *subject*: it moves when the inspector opens on
   * something new, and never otherwise. It used to be keyed on `close`, which
   * is derived from an inline `onClose` the parent recreates every render — so
   * every accepted realtime event yanked focus back to the Close button, out
   * from under anyone who had moved it inside the dialog.
   */
  const selectionKey =
    selection.kind === 'project'
      ? selection.projectId
      : selection.kind === 'session'
        ? selection.sessionId
        : selection.streamId;
  useEffect(() => {
    closeButton.current?.focus();
  }, [selection.kind, selectionKey]);

  /* The Escape listener answers to `close`, and only to that. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  /*
   * There is deliberately no focus trap here any more.
   *
   * The inspector used to be an overlay dialog with `aria-modal="true"`, which
   * removes everything outside it from the assistive tree — so Tab had to be
   * contained or a screen-reader user could land on controls their reader could
   * no longer describe. The pane is docked now: it is permanently visible
   * beside the content, nothing behind it is inert, and trapping Tab in a region
   * the user never "entered" would strand them. Tab passes through, and Escape
   * still returns to whatever opened it.
   */
  useEffect(() => {
    if (previousClockTarget.current !== activeSessionKey) {
      previousClockTarget.current = activeSessionKey;
      if (activeSessionKey !== undefined) setClockNowMs(eligibilityNowMs);
    }
    if (activeSessionKey === undefined) return;
    const timer = setInterval(() => setClockNowMs(now().getTime()), SESSION_DURATION_TICK_MS);
    return () => clearInterval(timer);
  }, [activeSessionKey, eligibilityNowMs, now]);

  const title = `${selection.kind[0]?.toUpperCase()}${selection.kind.slice(1)} inspector`;
  const projectEvents =
    selection.kind === 'project'
      ? relatedActivity(activity, (event) => event.projectId === selection.projectId)
      : [];
  const sessionEvents =
    selection.kind === 'session'
      ? relatedActivity(activity, (event) => event.sessionId === selection.sessionId)
      : [];
  const eventSession =
    selectedEvent?.sessionId !== undefined
      ? sessions.find((candidate) => candidate.id === selectedEvent.sessionId)
      : undefined;
  const eventSessionProjectMismatch =
    selectedEvent !== undefined &&
    eventSession !== undefined &&
    selectedEvent.projectId !== undefined &&
    eventSession.projectId !== selectedEvent.projectId;
  const duration =
    selectedSession === undefined ? undefined : sessionDuration(selectedSession, clockNowMs);
  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      <header>
        <div>
          <p className="eyebrow">Read-only evidence</p>
          <h2 id="inspector-title">{title}</h2>
        </div>
        <button ref={closeButton} type="button" onClick={close} aria-label="Close inspector">
          ×
        </button>
      </header>
      <div className="inspector__body">
        {selection.kind === 'project' ? (
          selectedProject === undefined ? (
            <p className="empty-state">Selected project unavailable</p>
          ) : (
            <>
              <DetailList
                rows={[
                  ['Name', selectedProject.name],
                  ['Project ID', selectedProject.id],
                  ['Local path', selectedProject.localPath],
                  ['Active sessions', <Count value={selectedProject.activeSessions} />],
                ]}
              />
              <RelatedActivity events={projectEvents} />
            </>
          )
        ) : selection.kind === 'session' ? (
          selectedSession === undefined ? (
            <p className="empty-state">Selected session unavailable</p>
          ) : (
            <>
              <DetailList
                rows={[
                  ['Session ID', selectedSession.id],
                  ['Agent ID', selectedSession.agentId],
                  ['Project', selectedSession.projectName],
                  ['Project ID', selectedSession.projectId],
                  ['Status', selectedSession.statusLabel],
                  ['Presence', selectedSession.presence],
                  ['Branch', selectedSession.branch],
                  ['Started', selectedSession.startedAt],
                  ['Last heartbeat', selectedSession.lastHeartbeatAt],
                  [
                    'Duration',
                    <span aria-label={`Session duration: ${duration}`}>{duration}</span>,
                  ],
                ]}
              />
              <RelatedActivity events={sessionEvents} />
            </>
          )
        ) : selectedEvent === undefined ? (
          <p className="empty-state">
            Selected event unavailable from the retained Activity window
          </p>
        ) : (
          <>
            <DetailList
              rows={[
                ['Event type', selectedEvent.type],
                ['Stream ID', selectedEvent.streamId],
                ['Event ID', selectedEvent.id],
                ['Occurred at', selectedEvent.occurredAt],
                ['Workspace ID', selectedEvent.workspaceId],
                ['Project ID', selectedEvent.projectId],
                ['Agent ID', selectedEvent.agentId],
                ['Session ID', selectedEvent.sessionId],
                ['Correlation ID', selectedEvent.correlationId],
                ['Causation ID', selectedEvent.causationId],
              ]}
            />
            <InspectorSection title="Payload" defaultCollapsed>
              <pre className="inspector-json">
                <code>{formatSafeJson(selectedEvent.payload)}</code>
              </pre>
            </InspectorSection>
            {selectedEvent.projectId === undefined &&
            selectedEvent.sessionId === undefined ? null : (
              <InspectorSection title="Related entities" className="inspector-navigation">
                {selectedEvent.projectId === undefined
                  ? null
                  : (() => {
                      const project = projects.find(
                        (candidate) => candidate.id === selectedEvent.projectId,
                      );
                      return project === undefined ? (
                        <p>Referenced project unavailable</p>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onNavigate?.({ kind: 'project', projectId: project.id })}
                        >
                          Open project inspector
                        </button>
                      );
                    })()}
                {selectedEvent.sessionId === undefined ? null : eventSession === undefined ? (
                  <p>Referenced session unavailable</p>
                ) : eventSessionProjectMismatch ? (
                  <p>
                    Referenced session unavailable because its project does not match the event
                    project.
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => onNavigate?.({ kind: 'session', sessionId: eventSession.id })}
                  >
                    Open session inspector
                  </button>
                )}
              </InspectorSection>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * What the docked pane shows when nothing is selected.
 *
 * A docked column has a state an overlay never had: present, and empty. Leaving
 * it blank reads as a rendering fault, so it names itself and says what fills
 * it. It is the same landmark either way, so the region's accessible name does
 * not change as the selection comes and goes.
 */
export function InspectorEmpty() {
  return (
    <aside className="inspector inspector--empty" aria-labelledby="inspector-title">
      <header>
        <div>
          <p className="eyebrow">Read-only evidence</p>
          <h2 id="inspector-title">Inspector</h2>
        </div>
      </header>
      <div className="inspector__body">
        <p className="empty-state">
          Select a project, session or event to inspect the evidence behind it.
        </p>
      </div>
    </aside>
  );
}
