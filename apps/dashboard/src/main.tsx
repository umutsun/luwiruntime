import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { DashboardApp, type WebSocketState } from './app.js';
import { createDaemonClient } from './api/client.js';
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
import { DashboardErrorBoundary } from './error-boundary.js';
import { buildPulseSnapshot, type PulseInput, type PulseResources } from './pulse/model.js';
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
import { parseRoute } from './routing.js';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/pulse.css';
import './styles/activity.css';
import './styles/projects.css';

const client = createDaemonClient();

function selectedProjectOf(hash: string): string | undefined {
  const route = parseRoute(hash);
  return route.name === 'projects' ? route.projectId : undefined;
}

function resourcesOf(input: PulseInput): PulseResources {
  return {
    health: input.health,
    projects: input.projects,
    sessions: input.sessions,
    agents: input.agents,
    usage: input.usage,
    context: input.context,
    activity: input.activity,
    findings: input.findings,
  };
}

function seedActivity(input: PulseInput): ActivityState {
  return input.activity.state === 'ready'
    ? input.activity.data.reduce(
        (state, event) => acceptActivityEvent(state, event).state,
        createActivityState(),
      )
    : createActivityState();
}

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

  useEffect(() => {
    const update = () => setSelectedProjectId(selectedProjectOf(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

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
        const selected = selectedProjectRef.current;
        if (
          selected !== undefined &&
          (event.projectId === undefined || event.projectId === selected)
        ) {
          refreshProjectScope(projectResourcesForEvent(event.type));
        }
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
  }, [bootstrap, refreshRequestRouter, refreshProjectScope]);

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
