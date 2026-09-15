import { useEffect, useMemo, useState } from 'react';

import type { AgentMessage } from '../api/messages-scope.js';
import type { SessionUsage } from '../api/session-usage.js';
import type { ResourceState } from '../components/panel.js';
import type { InspectorSelection } from '../inspectors/inspector-panel.js';
import type { PulseSnapshot } from '../pulse/model.js';
import type { DashboardEvent } from '../realtime/schema.js';
import { BoardView } from './board-view.js';
import { DrillDown } from './drill-down.js';
import { FlowView } from './flow-view.js';
import {
  buildOverview,
  panelFor,
  resolveFocus,
  type Focus,
  type SessionUsageState,
} from './model.js';
import { RadialView } from './radial-view.js';
import { StatsRow } from './stats-row.js';
import { Ticker } from './ticker.js';
import { TimelineView } from './timeline-view.js';
import type { ViewChoice } from './use-view-choice.js';

/**
 * The overview: one model, four lenses, one drill-down.
 *
 * Focus is owned by the shell because the header's PROJECT switcher sets it
 * too; the lenses only report clicks. Every lens reads the same `Overview`,
 * so switching cannot change a number.
 */
export function Overview({
  snapshot,
  events,
  nowMs,
  view,
  focus,
  following,
  pendingCount,
  realtime,
  hiddenProjects = 0,
  messages = [],
  onFocus,
  onInspect,
  loadSessionUsage,
}: {
  snapshot: PulseSnapshot;
  events: readonly DashboardEvent[];
  nowMs: number;
  view: ViewChoice;
  focus: Focus;
  following: boolean;
  pendingCount: number;
  /** The realtime connection, in words the drill-down repeats. */
  realtime: string;
  /** Registered projects the owner's filter keeps off this overview. */
  hiddenProjects?: number;
  /** The bounded message list, so the stream can show what each exchange answered. */
  messages?: readonly AgentMessage[];
  onFocus: (focus: Focus) => void;
  onInspect: (selection: InspectorSelection) => void;
  /** Reads a focused session's usage (model, tokens); absent leaves those facts as dashes. */
  loadSessionUsage?: (
    sessionId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<SessionUsage>>;
}) {
  const overview = useMemo(
    () => buildOverview(snapshot, events, nowMs, hiddenProjects, messages),
    [snapshot, events, nowMs, hiddenProjects, messages],
  );
  const resolved = resolveFocus(overview, focus);
  const focusedSessionId = resolved.kind === 'session' ? resolved.id : undefined;
  const [sessionUsage, setSessionUsage] = useState<{
    sessionId: string;
    state: SessionUsageState;
  }>();
  // Re-read when the focus moves and whenever the snapshot refreshes, because
  // usage attribution keeps arriving while a session runs.
  useEffect(() => {
    if (loadSessionUsage === undefined || focusedSessionId === undefined) {
      setSessionUsage(undefined);
      return undefined;
    }
    const controller = new AbortController();
    setSessionUsage((current) =>
      current?.sessionId === focusedSessionId
        ? current
        : { sessionId: focusedSessionId, state: { state: 'loading' } },
    );
    void loadSessionUsage(focusedSessionId, { signal: controller.signal }).then((state) => {
      if (controller.signal.aborted) return;
      setSessionUsage({ sessionId: focusedSessionId, state });
    });
    return () => controller.abort();
  }, [loadSessionUsage, focusedSessionId, snapshot.snapshotAt]);
  const panel = useMemo(
    () =>
      panelFor(overview, resolved, realtime, sessionUsage === undefined ? {} : { sessionUsage }),
    [overview, resolved, realtime, sessionUsage],
  );
  const toRuntime = () => onFocus({ kind: 'runtime' });

  return (
    <div className="overview">
      <div className="overview__main">
        {view === 'board' ? (
          <>
            <StatsRow
              stats={overview.stats}
              variant="inline"
              onSelect={toRuntime}
              trailing={
                <span className="board__legend" aria-hidden="true">
                  <span className="board__legend-item">
                    <span className="board__legend-swatch board__legend-swatch--blocked" />
                    blocked
                  </span>
                  <span className="board__legend-item">
                    <span className="board__legend-swatch board__legend-swatch--active" />
                    active
                  </span>
                  <span className="board__legend-item">
                    <span className="board__legend-swatch board__legend-swatch--quiet" />
                    quiet
                  </span>
                </span>
              }
            />
            <BoardView overview={overview} focus={resolved} realtime={realtime} onFocus={onFocus} />
          </>
        ) : view === 'flow' ? (
          <>
            <StatsRow stats={overview.stats} variant="fill" onSelect={toRuntime} />
            <FlowView overview={overview} focus={resolved} onFocus={onFocus} />
          </>
        ) : view === 'radial' ? (
          <>
            <StatsRow stats={overview.stats} variant="bars" onSelect={toRuntime} />
            <RadialView overview={overview} focus={resolved} onFocus={onFocus} />
          </>
        ) : (
          <>
            <StatsRow
              stats={overview.stats.filter((stat) => stat.key !== 'events')}
              variant="plain"
              onSelect={toRuntime}
            />
            <TimelineView overview={overview} focus={resolved} onFocus={onFocus} />
          </>
        )}
        <Ticker
          rows={overview.ticker}
          following={following}
          pendingCount={pendingCount}
          available={overview.activityState === 'ready'}
        />
      </div>
      <DrillDown panel={panel} nowMs={nowMs} onFocus={onFocus} onInspect={onInspect} />
    </div>
  );
}
