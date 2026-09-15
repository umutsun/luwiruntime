import { useEffect, useMemo, useState } from 'react';

import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import type { AgentMessage } from '../api/messages-scope.js';
import type { SessionUsage } from '../api/session-usage.js';
import type { ResourceState } from '../components/panel.js';
import type { InspectorSelection } from '../inspectors/inspector-panel.js';
import type { PulseSnapshot } from '../pulse/model.js';
import type { DashboardEvent } from '../realtime/schema.js';
import { BoardView } from './board-view.js';
import { DrillDown } from './drill-down.js';
import { FlowView } from './flow-view.js';
import { KnowledgeInspector, KnowledgeView, type KnowledgeState } from './knowledge-view.js';
import {
  buildOverview,
  emptyProjectsLabel,
  focusProject,
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
 * The overview: one model, five lenses, one docked aside.
 *
 * Focus is owned by the shell because the header's PROJECT switcher sets it
 * too; the lenses only report clicks. Four lenses read the same `Overview`,
 * so switching cannot change a number. The fifth, Knowledge, draws one
 * project's graphify graph: it resolves the focus to a project (or takes the
 * first one on the overview), reads that graph only while it is open, and
 * swaps the drill-down for its own inspector.
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
  loadKnowledge,
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
  /** Reads one project's knowledge graph for the Knowledge lens; absent renders it unavailable. */
  loadKnowledge?: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<KnowledgeGraph>>;
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

  // The Knowledge lens's project: the focus resolved to one, else the first on
  // the overview. Undefined off the lens, so the read below never runs there.
  const knowledgeProject =
    view === 'knowledge' ? (focusProject(overview, resolved) ?? overview.projects[0]) : undefined;
  const knowledgeProjectId = knowledgeProject?.id;
  const [knowledge, setKnowledge] = useState<{
    projectId: string;
    state: ResourceState<KnowledgeGraph>;
  }>();
  const [knowledgeNode, setKnowledgeNode] = useState<string>();
  // Reads once per project while the lens is open — not on every snapshot,
  // because graphify output changes on git hooks, not every few seconds. A
  // project switch clears the selection: node ids do not carry across graphs.
  useEffect(() => {
    setKnowledgeNode(undefined);
    if (loadKnowledge === undefined || knowledgeProjectId === undefined) return undefined;
    const controller = new AbortController();
    void loadKnowledge(knowledgeProjectId, { signal: controller.signal }).then((state) => {
      if (controller.signal.aborted) return;
      setKnowledge({ projectId: knowledgeProjectId, state });
    });
    return () => controller.abort();
  }, [loadKnowledge, knowledgeProjectId]);
  const knowledgeState: KnowledgeState | undefined =
    knowledgeProjectId === undefined
      ? undefined
      : loadKnowledge === undefined
        ? { state: 'unavailable' }
        : knowledge?.projectId === knowledgeProjectId
          ? knowledge.state
          : { state: 'loading' };

  return (
    <div className="overview">
      <div className="overview__main">
        {/* One stat strip for every lens: the same header row and figures whichever
            lens is open, so switching a lens never changes the numbers or their shape. */}
        <StatsRow stats={overview.stats} variant="fill" onSelect={toRuntime} />
        {view === 'board' ? (
          <BoardView overview={overview} focus={resolved} realtime={realtime} onFocus={onFocus} />
        ) : view === 'flow' ? (
          <FlowView overview={overview} focus={resolved} onFocus={onFocus} />
        ) : view === 'radial' ? (
          <RadialView overview={overview} focus={resolved} onFocus={onFocus} />
        ) : view === 'timeline' ? (
          <TimelineView overview={overview} focus={resolved} onFocus={onFocus} />
        ) : (
          <KnowledgeView
            projects={overview.projects}
            {...(knowledgeProjectId === undefined ? {} : { projectId: knowledgeProjectId })}
            {...(knowledgeState === undefined ? {} : { graph: knowledgeState })}
            emptyLabel={emptyProjectsLabel(overview)}
            {...(knowledgeNode === undefined ? {} : { selectedId: knowledgeNode })}
            onSelectNode={setKnowledgeNode}
            onFocus={onFocus}
          />
        )}
        <Ticker
          rows={overview.ticker}
          following={following}
          pendingCount={pendingCount}
          available={overview.activityState === 'ready'}
        />
      </div>
      {view === 'knowledge' ? (
        <KnowledgeInspector
          {...(knowledgeProject === undefined ? {} : { projectName: knowledgeProject.name })}
          {...(knowledgeState === undefined ? {} : { graph: knowledgeState })}
          {...(knowledgeNode === undefined ? {} : { selectedId: knowledgeNode })}
          onSelectNode={setKnowledgeNode}
        />
      ) : (
        <DrillDown panel={panel} nowMs={nowMs} onFocus={onFocus} onInspect={onInspect} />
      )}
    </div>
  );
}
