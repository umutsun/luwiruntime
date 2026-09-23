import { useEffect, useMemo, useState } from 'react';

import type { AutopilotStatus } from '../api/autopilot-status.js';
import type { AutopilotFlow } from '../api/autopilot-flow.js';
import type { AutopilotMutations } from '../api/autopilot-mutations.js';
import type { CoordinatorMutations } from '../api/coordinator-mutations.js';
import type { KnowledgeGraph } from '../api/knowledge-scope.js';
import type { AgentMessage } from '../api/messages-scope.js';
import type { SessionUsage } from '../api/session-usage.js';
import type { ResourceState } from '../components/panel.js';
import { ProjectAutopilot } from '../components/project-autopilot.js';
import { useToast } from '../components/toast.js';
import type { InspectorSelection } from '../inspectors/inspector-panel.js';
import type { PulseSnapshot } from '../pulse/model.js';
import type { DashboardEvent } from '../realtime/schema.js';
import { BoardView } from './board-view.js';
import { DrillDown, type AutopilotLink, type CoordinatorLink } from './drill-down.js';
import { FlowView } from './flow-view.js';
import { KnowledgeInspector, KnowledgeView, type KnowledgeState } from './knowledge-view.js';
import {
  buildOverview,
  emptyProjectsLabel,
  focusProject,
  panelFor,
  resolveFocus,
  type AutopilotFlowState,
  type AutopilotStatusState,
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
  messagesUnavailable = false,
  onFocus,
  onInspect,
  loadSessionUsage,
  loadKnowledge,
  loadAutopilot,
  loadAutopilotFlow,
  coordinatorMutations,
  onCoordinatorMutated,
  autopilotMutations,
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
  messagesUnavailable?: boolean;
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
  /** Reads a focused project's autopilot mode (ADR 0035); absent leaves the fact a dash. */
  loadAutopilot?: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<AutopilotStatus>>;
  /** Reads a focused project's autopilot goal/task flow; absent hides the flow section. */
  loadAutopilotFlow?: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<AutopilotFlow>>;
  /** Both present wires the drill-down's coordinator switch (ADR 0035); either absent hides it. */
  coordinatorMutations?: CoordinatorMutations;
  onCoordinatorMutated?: () => void;
  /** With `loadAutopilot`, wires the drill-down's autopilot mode switch (ADR 0035). */
  autopilotMutations?: AutopilotMutations;
}) {
  const pushToast = useToast();
  const overview = useMemo(
    () => buildOverview(snapshot, events, nowMs, hiddenProjects, messages, messagesUnavailable),
    [snapshot, events, nowMs, hiddenProjects, messages, messagesUnavailable],
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
  // The autopilot mode read (ADR 0035), for the project the owner drills into.
  // Re-read on refresh like usage — the mode changes on operator action, and the
  // coordinator's presence changes as sessions come and go.
  const focusedProjectId = resolved.kind === 'project' ? resolved.id : undefined;
  const [autopilot, setAutopilot] = useState<{
    projectId: string;
    state: AutopilotStatusState;
  }>();
  useEffect(() => {
    if (loadAutopilot === undefined || focusedProjectId === undefined) {
      setAutopilot(undefined);
      return undefined;
    }
    const controller = new AbortController();
    setAutopilot((current) =>
      current?.projectId === focusedProjectId
        ? current
        : { projectId: focusedProjectId, state: { state: 'loading' } },
    );
    void loadAutopilot(focusedProjectId, { signal: controller.signal }).then((state) => {
      if (controller.signal.aborted) return;
      setAutopilot({ projectId: focusedProjectId, state });
    });
    return () => controller.abort();
  }, [loadAutopilot, focusedProjectId, snapshot.snapshotAt]);
  // The autopilot goal/task flow, read on the same project focus and refresh as
  // the mode — goals plan, dispatch and get judged between snapshots.
  const [autopilotFlow, setAutopilotFlow] = useState<{
    projectId: string;
    state: AutopilotFlowState;
  }>();
  useEffect(() => {
    if (loadAutopilotFlow === undefined || focusedProjectId === undefined) {
      setAutopilotFlow(undefined);
      return undefined;
    }
    const controller = new AbortController();
    setAutopilotFlow((current) =>
      current?.projectId === focusedProjectId
        ? current
        : { projectId: focusedProjectId, state: { state: 'loading' } },
    );
    void loadAutopilotFlow(focusedProjectId, { signal: controller.signal }).then((state) => {
      if (controller.signal.aborted) return;
      setAutopilotFlow({ projectId: focusedProjectId, state });
    });
    return () => controller.abort();
  }, [loadAutopilotFlow, focusedProjectId, snapshot.snapshotAt]);
  const panel = useMemo(
    () =>
      panelFor(overview, resolved, realtime, {
        ...(sessionUsage === undefined ? {} : { sessionUsage }),
        ...(autopilot === undefined ? {} : { autopilot }),
        ...(autopilotFlow === undefined ? {} : { autopilotFlow }),
      }),
    [overview, resolved, realtime, sessionUsage, autopilot, autopilotFlow],
  );
  // The coordinator switch (ADR 0035), from the session panel the owner drills
  // into. One request at a time; the outcome is stated in words and cleared
  // when the focus moves, and a success re-reads the snapshot so the fact and
  // the badge follow the daemon rather than the click.
  const [coordinatorBusy, setCoordinatorBusy] = useState(false);
  const coordinatorEnabled =
    coordinatorMutations !== undefined && onCoordinatorMutated !== undefined;
  const runCoordinator = async (link: CoordinatorLink): Promise<void> => {
    if (coordinatorMutations === undefined || onCoordinatorMutated === undefined) return;
    if (coordinatorBusy) return;
    setCoordinatorBusy(true);
    const result =
      link.action === 'claim'
        ? await coordinatorMutations.claim(link.projectId, link.sessionId)
        : await coordinatorMutations.release(link.projectId, link.sessionId);
    setCoordinatorBusy(false);
    if (result.state === 'ok') {
      pushToast(
        link.action === 'claim' ? 'Coordinator assigned.' : 'Coordinator released.',
        'info',
      );
      onCoordinatorMutated();
      return;
    }
    pushToast(
      result.reason === 'http' ? result.message : 'The coordinator update could not be completed.',
      'error',
    );
  };
  // The autopilot mode switch (ADR 0035), from the project panel. One request at
  // a time; the daemon returns the new record, so the fact follows the response
  // without a re-read — autopilot is not in the pulse, so nothing else needs it.
  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const autopilotEnabled = autopilotMutations !== undefined && loadAutopilot !== undefined;
  const runAutopilot = async (link: AutopilotLink): Promise<void> => {
    if (autopilotMutations === undefined || autopilotBusy) return;
    setAutopilotBusy(true);
    const result = await autopilotMutations.setMode(link.projectId, link.mode);
    setAutopilotBusy(false);
    if (result.state === 'ok') {
      setAutopilot((current) => ({
        projectId: link.projectId,
        state: {
          state: 'ready',
          data: {
            mode: result.data.record.mode,
            configured: result.data.record.policy !== null,
            coordinatorOnline:
              result.data.coordinatorNotified ||
              (current?.projectId === link.projectId && current.state.state === 'ready'
                ? current.state.data.coordinatorOnline
                : false),
          },
        },
      }));
      pushToast(
        result.data.changed ? `Autopilot set to ${link.mode}.` : `Autopilot already ${link.mode}.`,
        'info',
      );
      return;
    }
    pushToast(
      result.reason === 'http' ? result.message : 'The autopilot update could not be completed.',
      'error',
    );
  };
  // Each hero tile opens its own detail drawer over the overview, the owner's
  // opener for the folded routes.
  const openStat = (stat: { route: string }) => {
    window.location.hash = stat.route;
  };

  // The Knowledge lens's project is the focus resolved to one; nothing focused
  // means the lens shows the project picker and reads nothing. Undefined off
  // the lens too, so the read below never runs there.
  const knowledgeProject = view === 'knowledge' ? focusProject(overview, resolved) : undefined;
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
        <StatsRow stats={overview.stats} variant="fill" onSelect={openStat} />
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
            {...(knowledgeProject === undefined ? {} : { project: knowledgeProject })}
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
          projects={overview.projects}
          {...(knowledgeProject === undefined ? {} : { projectName: knowledgeProject.name })}
          {...(knowledgeState === undefined ? {} : { graph: knowledgeState })}
          {...(knowledgeNode === undefined ? {} : { selectedId: knowledgeNode })}
          onSelectNode={setKnowledgeNode}
          onFocus={onFocus}
        />
      ) : (
        <DrillDown
          panel={panel}
          nowMs={nowMs}
          onFocus={onFocus}
          onInspect={onInspect}
          {...(coordinatorEnabled
            ? {
                onCoordinator: (link: CoordinatorLink) => {
                  void runCoordinator(link);
                },
              }
            : {})}
          {...(autopilotEnabled
            ? {
                onAutopilot: (link: AutopilotLink) => {
                  void runAutopilot(link);
                },
              }
            : {})}
          {...(focusedProjectId !== undefined &&
          loadAutopilot !== undefined &&
          autopilotMutations !== undefined
            ? {
                autopilotControl: (
                  <ProjectAutopilot
                    projectId={focusedProjectId}
                    loadAutopilot={loadAutopilot}
                    autopilotMutations={autopilotMutations}
                  />
                ),
              }
            : {})}
        />
      )}
    </div>
  );
}
