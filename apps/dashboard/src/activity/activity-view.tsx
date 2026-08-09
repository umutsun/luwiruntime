import { useEffect, useMemo, useRef, useState } from 'react';

import {
  activitySource,
  filterActivityEvents,
  resumeActivity,
  setActivityFollowing,
  type ActivityState,
} from '../realtime/activity-store.js';
import { isImplementedEventType, type DashboardEvent } from '../realtime/schema.js';

export function ActivityView({
  state,
  available = true,
  onStateChange,
  onOpenEvent,
}: {
  state: ActivityState;
  /**
   * Whether the activity read succeeded. Without this the view cannot tell a
   * failed read from a filter that matched nothing, and it blamed the filters
   * for both — Pulse already made the same distinction correctly.
   */
  available?: boolean;
  onStateChange: (state: ActivityState) => void;
  onOpenEvent: (event: DashboardEvent, opener: HTMLElement) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [source, setSource] = useState('');
  const [eventType, setEventType] = useState('');
  const [search, setSearch] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const streamRef = useRef<HTMLDivElement>(null);
  const previousStreamIds = useRef(new Set(state.events.map((event) => event.streamId)));
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingAnnouncement = useRef({ count: 0, latestType: '' });
  const following = useRef(state.following);
  following.current = state.following;
  const events = useMemo(
    () =>
      filterActivityEvents(state.events, {
        ...(projectId === '' ? {} : { projectId }),
        ...(source === '' ? {} : { source }),
        ...(eventType === '' ? {} : { eventType }),
        ...(search === '' ? {} : { search }),
      }).toReversed(),
    [eventType, projectId, search, source, state.events],
  );
  const projects = [...new Set(state.events.flatMap((event) => event.projectId ?? []))].sort();
  const sources = [...new Set(state.events.map(activitySource))].sort();
  const types = [...new Set(state.events.map((event) => event.type))].sort();

  useEffect(() => {
    const currentIds = new Set(state.events.map((event) => event.streamId));
    const added = state.events.filter((event) => !previousStreamIds.current.has(event.streamId));
    previousStreamIds.current = currentIds;
    if (added.length === 0) return;

    const latest = added.at(-1);
    pendingAnnouncement.current = {
      count: Math.min(state.maxEvents, pendingAnnouncement.current.count + added.length),
      latestType: latest?.type ?? pendingAnnouncement.current.latestType,
    };
    if (announcementTimer.current !== undefined) return;
    announcementTimer.current = setTimeout(() => {
      announcementTimer.current = undefined;
      const pending = pendingAnnouncement.current;
      pendingAnnouncement.current = { count: 0, latestType: '' };
      const eventsLabel = pending.count === 1 ? 'event' : 'events';
      setAnnouncement(
        following.current
          ? `${String(pending.count)} new activity ${eventsLabel}. Latest event: ${pending.latestType}.`
          : `${String(pending.count)} new activity ${eventsLabel} pending while Activity is paused.`,
      );
    }, 750);
  }, [state.events, state.maxEvents]);

  useEffect(
    () => () => {
      if (announcementTimer.current !== undefined) clearTimeout(announcementTimer.current);
    },
    [],
  );

  const pauseIfScrolledAway = (element: HTMLElement) => {
    const isAtLiveEdge = element.scrollTop <= 24;
    if (!isAtLiveEdge && state.following) {
      onStateChange(setActivityFollowing(state, false));
    }
  };

  const resumeFollowing = () => {
    streamRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    onStateChange(resumeActivity(state));
  };

  return (
    <section className="activity-workspace" aria-labelledby="activity-title">
      <span className="sr-only" aria-label="Activity updates" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
      <header className="activity-heading">
        <div>
          <p className="eyebrow">Durable normalized events</p>
          <h2 id="activity-title">Activity</h2>
          <p>Validated realtime observations. Newest retained event appears first.</p>
        </div>
        {state.following ? (
          <span className="activity-follow" role="status">
            Following live
          </span>
        ) : (
          <button
            className="retry-button"
            type="button"
            onClick={resumeFollowing}
            aria-label={`Resume live activity (${state.pendingCount} new)`}
          >
            Resume · {state.pendingCount} new
          </button>
        )}
      </header>

      <div className="activity-filters" aria-label="Activity filters">
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">All sources</option>
            {sources.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Event type
          <select value={eventType} onChange={(event) => setEventType(event.target.value)}>
            <option value="">All event types</option>
            {types.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="activity-filters__search">
          Search
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="ID or event type"
          />
        </label>
      </div>

      <div
        ref={streamRef}
        className="activity-stream"
        aria-label="Realtime activity stream"
        tabIndex={0}
        onScroll={(event) => pauseIfScrolledAway(event.currentTarget)}
      >
        {!available ? (
          <p className="empty-state">Activity snapshot unavailable</p>
        ) : events.length === 0 ? (
          <p className="empty-state">No activity matches these filters</p>
        ) : (
          <ol className="activity-feed">
            {events.map((item) => (
              <li key={item.streamId}>
                <button
                  type="button"
                  onClick={(event) => onOpenEvent(item, event.currentTarget)}
                  aria-label={`Inspect ${item.type} event`}
                >
                  <span className="activity-feed__type">{item.type}</span>
                  <span>
                    {activitySource(item)}
                    {isImplementedEventType(item.type) ? null : (
                      <small>Unsupported event type</small>
                    )}
                  </span>
                  <span>{item.projectId ?? 'workspace'}</span>
                  <time dateTime={item.occurredAt}>
                    {new Date(item.occurredAt).toLocaleString()}
                  </time>
                  <code>{item.streamId}</code>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
