import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DashboardApp, type WebSocketState } from './app.js';
import { createDaemonClient } from './api/client.js';
import { loadSubgraph, type GraphRoot, type SubgraphBounds } from './api/graph-explorer.js';
import {
  intelligenceResourceKeys,
  intelligenceResourcesForEvent,
  loadIntelligenceScope,
  type IntelligenceResourceKey,
  type IntelligenceResources,
} from './api/intelligence-scope.js';
import {
  agentPairResourceKeys,
  agentPairResourcesForEvent,
  loadAgentPairScope,
  type AgentPairResourceKey,
  type AgentPairResources,
} from './api/agent-pair-scope.js';
import {
  loadMessageScope,
  messageResourceKeys,
  messageResourcesForEvent,
  type MessageResourceKey,
  type MessageResources,
} from './api/messages-scope.js';
import {
  loadProjectScope,
  projectResourcesForEvent,
  projectScopeResourceKeys,
  type ProjectScopeResourceKey,
  type ProjectScopeResources,
} from './api/project-scope.js';
import { loadPulseInput, loadPulseResources } from './api/pulse.js';
import {
  createPulseRefreshController,
  freshnessForResources,
  type PulseFreshness,
} from './api/refresh-state.js';
import {
  affectsSelectedProject,
  buildPulseSnapshot,
  needsIntelligenceOf,
  needsMessagesOf,
  resourcesOf,
  seedActivity,
  selectedAgentOf,
  selectedProjectOf,
} from './bootstrap.js';
import { DashboardErrorBoundary } from './error-boundary.js';
import type { PulseInput } from './pulse/model.js';
import {
  acceptActivityEvent,
  createActivityState,
  type ActivityState,
} from './realtime/activity-store.js';
import {
  createInvalidationCoordinator,
  createLiveRefreshCoordinator,
  createRefreshRequestRouter,
} from './realtime/invalidation.js';
import { routeRealtimeEvent } from './realtime/event-pipeline.js';
import { createRealtimeController, toRealtimeUrl } from './realtime/observer.js';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/pulse.css';
import './styles/activity.css';
import './styles/projects.css';

const client = createDaemonClient();

/**
 * Bound once so the Graph explorer's load effect has a stable dependency; a new
 * function identity per render would re-fetch the subgraph on every render.
 */
const fetchSubgraph = (
  root: GraphRoot,
  bounds: SubgraphBounds,
  options?: { signal?: AbortSignal },
) => loadSubgraph(client, root, bounds, options);

function DashboardRoute() {
  const [input, setInput] = useState<PulseInput>();
  const [bootstrap, setBootstrap] = useState<{ request: number; input: PulseInput }>();
  const [activity, setActivity] = useState<ActivityState>(createActivityState);
  const activityRef = useRef(activity);
  const [websocketState, setWebsocketState] = useState<WebSocketState>('connecting');
  const [freshness, setFreshness] = useState<PulseFreshness>('current');
  const [staleResources, setStaleResources] = useState<readonly string[]>([]);
  const [invalidEventCount, setInvalidEventCount] = useState(0);
  const [requestNumber, setRequestNumber] = useState(0);
  const refreshRequestRouter = useMemo(
    () => createRefreshRequestRouter(() => setRequestNumber((value) => value + 1)),
    [],
  );
  const retry = useCallback(() => refreshRequestRouter.request(), [refreshRequestRouter]);

  const [selectedProjectId, setSelectedProjectId] = useState(() =>
    selectedProjectOf(window.location.hash),
  );
  const [projectResources, setProjectResources] = useState<Partial<ProjectScopeResources>>({});
  const [projectScopeLoading, setProjectScopeLoading] = useState(false);
  // The realtime controller is created once per bootstrap, so it must read the
  // current selection through a ref rather than a captured value.
  const selectedProjectRef = useRef(selectedProjectId);
  selectedProjectRef.current = selectedProjectId;

  const [selectedAgentId, setSelectedAgentId] = useState(() =>
    selectedAgentOf(window.location.hash),
  );
  const [agentPairResources, setAgentPairResources] = useState<Partial<AgentPairResources>>({});
  const [agentPairLoading, setAgentPairLoading] = useState(false);
  const selectedAgentRef = useRef(selectedAgentId);
  selectedAgentRef.current = selectedAgentId;

  const [needsIntelligence, setNeedsIntelligence] = useState(() =>
    needsIntelligenceOf(window.location.hash),
  );
  const [intelligenceResources, setIntelligenceResources] = useState<
    Partial<IntelligenceResources>
  >({});
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const needsIntelligenceRef = useRef(needsIntelligence);
  needsIntelligenceRef.current = needsIntelligence;

  const [needsMessages, setNeedsMessages] = useState(() => needsMessagesOf(window.location.hash));
  const [messageResources, setMessageResources] = useState<Partial<MessageResources>>({});
  const [messagesLoading, setMessagesLoading] = useState(false);
  const needsMessagesRef = useRef(needsMessages);
  needsMessagesRef.current = needsMessages;

  useEffect(() => {
    const update = () => {
      setSelectedProjectId(selectedProjectOf(window.location.hash));
      setSelectedAgentId(selectedAgentOf(window.location.hash));
      setNeedsIntelligence(needsIntelligenceOf(window.location.hash));
      setNeedsMessages(needsMessagesOf(window.location.hash));
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    if (!needsIntelligence) return undefined;
    const controller = new AbortController();
    setIntelligenceLoading(true);
    void loadIntelligenceScope(client, intelligenceResourceKeys, {
      signal: controller.signal,
    }).then((next) => {
      if (controller.signal.aborted) return;
      setIntelligenceResources(next);
      setIntelligenceLoading(false);
    });
    return () => controller.abort();
  }, [needsIntelligence, requestNumber]);

  useEffect(() => {
    if (!needsMessages) return undefined;
    const controller = new AbortController();
    setMessagesLoading(true);
    void loadMessageScope(client, messageResourceKeys, { signal: controller.signal }).then(
      (next) => {
        if (controller.signal.aborted) return;
        setMessageResources(next);
        setMessagesLoading(false);
      },
    );
    return () => controller.abort();
  }, [needsMessages, requestNumber]);

  useEffect(() => {
    if (selectedProjectId === undefined) {
      setProjectResources({});
      setProjectScopeLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setProjectScopeLoading(true);
    // Previous results are cleared so a slow load never shows another
    // project's evidence under this project's name.
    setProjectResources({});
    void loadProjectScope(client, selectedProjectId, projectScopeResourceKeys, {
      signal: controller.signal,
    }).then((next) => {
      if (controller.signal.aborted) return;
      setProjectResources(next);
      setProjectScopeLoading(false);
    });
    return () => controller.abort();
  }, [selectedProjectId, requestNumber]);

  useEffect(() => {
    if (selectedProjectId === undefined || selectedAgentId === undefined) {
      setAgentPairResources({});
      setAgentPairLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setAgentPairLoading(true);
    // Cleared for the same reason the project scope is: a slow read must never
    // paint one pair's configuration under another pair's name.
    setAgentPairResources({});
    void loadAgentPairScope(client, selectedProjectId, selectedAgentId, agentPairResourceKeys, {
      signal: controller.signal,
    }).then((next) => {
      if (controller.signal.aborted) return;
      setAgentPairResources(next);
      setAgentPairLoading(false);
    });
    return () => controller.abort();
  }, [selectedProjectId, selectedAgentId, requestNumber]);

  const refreshAgentPairScope = useCallback((keys: readonly AgentPairResourceKey[]) => {
    const projectId = selectedProjectRef.current;
    const agentId = selectedAgentRef.current;
    if (projectId === undefined || agentId === undefined || keys.length === 0) return;
    void loadAgentPairScope(client, projectId, agentId, keys).then((next) => {
      // Generation guard on both halves of the pair.
      if (selectedProjectRef.current !== projectId || selectedAgentRef.current !== agentId) return;
      setAgentPairResources((current) => ({ ...current, ...next }));
    });
  }, []);

  const refreshIntelligenceScope = useCallback((keys: readonly IntelligenceResourceKey[]) => {
    if (!needsIntelligenceRef.current || keys.length === 0) return;
    void loadIntelligenceScope(client, keys).then((next) => {
      if (!needsIntelligenceRef.current) return;
      setIntelligenceResources((current) => ({ ...current, ...next }));
    });
  }, []);

  const refreshMessageScope = useCallback((keys: readonly MessageResourceKey[]) => {
    if (!needsMessagesRef.current || keys.length === 0) return;
    void loadMessageScope(client, keys).then((next) => {
      if (!needsMessagesRef.current) return;
      setMessageResources((current) => ({ ...current, ...next }));
    });
  }, []);

  const refreshProjectScope = useCallback((keys: readonly ProjectScopeResourceKey[]) => {
    const projectId = selectedProjectRef.current;
    if (projectId === undefined || keys.length === 0) return;
    void loadProjectScope(client, projectId, keys).then((next) => {
      // Generation guard: drop the response if the selection moved on.
      if (selectedProjectRef.current !== projectId) return;
      setProjectResources((current) => ({ ...current, ...next }));
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadPulseInput(client, { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted) return;
      setInput(next);
      const seededActivity = seedActivity(next);
      activityRef.current = seededActivity;
      setActivity(seededActivity);
      setFreshness(freshnessForResources(resourcesOf(next)));
      setStaleResources([]);
      setInvalidEventCount(0);
      setBootstrap({ request: requestNumber, input: next });
    });
    return () => controller.abort();
  }, [requestNumber]);

  useEffect(() => {
    if (bootstrap === undefined) return undefined;
    const refreshController = createPulseRefreshController({
      initial: resourcesOf(bootstrap.input),
      load: (keys, signal) => loadPulseResources(client, keys, { signal }),
      onChange: (next) => {
        setFreshness(next.freshness);
        setStaleResources(next.staleResources);
        setInput((current) =>
          current === undefined
            ? current
            : {
                ...current,
                ...next.resources,
                snapshotAt: next.lastSuccessAt,
              },
        );
        if (next.resources.activity.state === 'ready') {
          const merged = next.resources.activity.data.reduce(
            (state, event) => acceptActivityEvent(state, event).state,
            activityRef.current,
          );
          activityRef.current = merged;
          setActivity(merged);
        }
      },
    });
    const invalidation = createInvalidationCoordinator({
      refresh: (keys) => refreshController.refresh(keys),
    });
    const liveRefresh = createLiveRefreshCoordinator({
      invalidateAll: () => invalidation.invalidateAll(),
    });
    const detachRetry = refreshRequestRouter.attach(() => invalidation.invalidateAll());

    if (typeof WebSocket === 'undefined') {
      setWebsocketState('unavailable');
      return () => {
        detachRetry();
        invalidation.stop();
        refreshController.stop();
      };
    }

    const realtime = createRealtimeController({
      url: toRealtimeUrl(window.location),
      Socket: WebSocket,
      onState: (state) => {
        setWebsocketState(state);
        liveRefresh.observe(state);
      },
      onEvent: (event) => {
        const accepted = routeRealtimeEvent(activityRef.current, event);
        if (!accepted.accepted) return;
        activityRef.current = accepted.state;
        setActivity(accepted.state);
        invalidation.invalidate(accepted.invalidations);
        // Project panels refresh only for the project on screen. An event for
        // another project changes nothing that is rendered, so it costs no
        // request.
        if (affectsSelectedProject(selectedProjectRef.current, event.projectId)) {
          refreshProjectScope(projectResourcesForEvent(event.type));
        }
        refreshIntelligenceScope(intelligenceResourcesForEvent(event.type));
        refreshMessageScope(messageResourcesForEvent(event.type));
        refreshAgentPairScope(agentPairResourcesForEvent(event.type));
      },
      onInvalid: () => setInvalidEventCount((count) => Math.min(99, count + 1)),
    });
    realtime.start();
    return () => {
      detachRetry();
      realtime.stop();
      invalidation.stop();
      refreshController.stop();
    };
  }, [
    bootstrap,
    refreshRequestRouter,
    refreshProjectScope,
    refreshIntelligenceScope,
    refreshMessageScope,
    refreshAgentPairScope,
  ]);

  const snapshot = useMemo(
    () => (input === undefined ? undefined : buildPulseSnapshot(input)),
    [input],
  );
  if (snapshot === undefined) {
    return (
      <main className="route-loading" aria-busy="true">
        <span className="identity__mark">L</span>
        <p className="eyebrow">LUWI Runtime</p>
        <h1>Loading validated Pulse snapshot</h1>
      </main>
    );
  }

  return (
    <DashboardApp
      snapshot={snapshot}
      websocketState={websocketState}
      activityState={activity}
      freshness={freshness}
      staleResources={staleResources}
      invalidEventCount={invalidEventCount}
      projectResources={projectResources}
      projectScopeLoading={projectScopeLoading}
      intelligenceResources={intelligenceResources}
      intelligenceLoading={intelligenceLoading}
      messageResources={messageResources}
      messagesLoading={messagesLoading}
      agentPairResources={agentPairResources}
      agentPairLoading={agentPairLoading}
      loadSubgraph={fetchSubgraph}
      onRetry={retry}
      onActivityStateChange={(next) => {
        activityRef.current = next;
        setActivity(next);
      }}
    />
  );
}

const root = document.querySelector('#root');
if (root === null) throw new Error('Dashboard root element is missing.');

createRoot(root).render(
  <StrictMode>
    <DashboardErrorBoundary>
      <DashboardRoute />
    </DashboardErrorBoundary>
  </StrictMode>,
);
