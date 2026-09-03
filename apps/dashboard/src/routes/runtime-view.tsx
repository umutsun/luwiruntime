import { useEffect, useState } from 'react';

import type { WebSocketState } from '../app.js';
import type { RuntimeResources } from '../api/runtime-resources.js';
import { formatBytes } from '../components/format.js';
import { Panel, type ResourceState } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';

/** Resource figures are a rate over the previous read, so the read repeats. */
const RESOURCES_REFRESH_MS = 10_000;

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${minutes.toString().padStart(2, '0')}m`;
}

function formatPercent(value: number | undefined): string {
  // The first read has nothing to compare against, and says so.
  return value === undefined ? 'Measuring…' : `${String(Math.round(value))}%`;
}

/**
 * The runtime's own identity and health, over `GET /api/v1/runtime`, and since
 * the resources read what the machine has and what LUWI costs on it.
 *
 * This is where the mockup's stat strip pointed its latency and Redis
 * counters; until this route existed those stats had no destination. The
 * "Runtime health" panel moved here from Pulse with the phase-4 rebuild —
 * the strip already states daemon, latency and Redis at a glance, so on
 * Pulse the panel duplicated the line above it.
 *
 * Host and port are the loopback address this page itself was loaded from;
 * displaying them reveals nothing the browser's own URL bar does not. The
 * resource figures are the daemon's own measurements of its host, shown to
 * the developer who owns that host.
 */
export function RuntimeView({
  snapshot,
  websocketState,
  loadResources,
}: {
  snapshot: PulseSnapshot;
  websocketState: WebSocketState;
  loadResources?: (options?: { signal?: AbortSignal }) => Promise<ResourceState<RuntimeResources>>;
}) {
  const health = snapshot.health.state === 'ready' ? snapshot.health.data : undefined;
  const runtime = snapshot.runtime.state === 'ready' ? snapshot.runtime.data : undefined;
  const [resources, setResources] = useState<ResourceState<RuntimeResources>>();

  useEffect(() => {
    if (loadResources === undefined) return undefined;
    const controller = new AbortController();
    const refresh = (): void => {
      void loadResources({ signal: controller.signal }).then((next) => {
        if (!controller.signal.aborted) setResources(next);
      });
    };
    refresh();
    const timer = setInterval(refresh, RESOURCES_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [loadResources]);

  const figures = resources?.state === 'ready' ? resources.data : undefined;

  return (
    <div className="route-stack runtime-grid">
      <Panel title="Runtime health">
        <dl className="health-list">
          <div>
            <dt>Daemon</dt>
            <dd>
              {health === undefined ? (
                <StatusChip tone="danger">Unavailable</StatusChip>
              ) : (
                <StatusChip tone={health.status === 'ok' ? 'success' : 'danger'}>
                  {health.status}
                </StatusChip>
              )}
            </dd>
          </div>
          <div>
            <dt>Local Redis</dt>
            <dd>
              {health?.redis.connected ? (
                <StatusChip tone="success">Connected</StatusChip>
              ) : (
                <StatusChip tone="danger">Unavailable</StatusChip>
              )}
            </dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{health === undefined ? 'Unavailable' : formatDuration(health.uptimeMs)}</dd>
          </div>
          <div>
            <dt>Realtime</dt>
            <dd>{websocketState}</dd>
          </div>
        </dl>
        {/*
         * "Function library" and "Projection health" stayed banned here when
         * the panel moved from Pulse: no daemon route exposes function-library
         * state, and projection health is read on the Graph route where ADR
         * 0013's cost is paid on purpose. A row that can only ever say one
         * thing is not evidence.
         */}
      </Panel>

      <Panel title="Runtime identity">
        {runtime === undefined ? (
          <p className="empty-state">Unavailable</p>
        ) : (
          <dl className="health-list">
            <div>
              <dt>Workspace</dt>
              <dd>{runtime.workspaceId}</dd>
            </div>
            <div>
              <dt>Runtime state</dt>
              <dd>{runtime.runtimeState}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{`${runtime.version} · protocol ${String(runtime.protocolVersion)}`}</dd>
            </div>
            <div>
              <dt>Instance</dt>
              <dd>{runtime.runtimeInstanceId}</dd>
            </div>
            <div>
              <dt>Listening</dt>
              <dd>{`${runtime.host}:${String(runtime.port)}`}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>
                <time dateTime={runtime.startedAt}>
                  {new Date(runtime.startedAt).toLocaleString()}
                </time>
              </dd>
            </div>
          </dl>
        )}
      </Panel>

      {loadResources === undefined ? null : (
        <>
          <Panel title="Host">
            {figures === undefined ? (
              <p className="empty-state" aria-busy={resources === undefined ? 'true' : undefined}>
                {resources === undefined ? 'Reading the machine' : 'Unavailable'}
              </p>
            ) : (
              <dl className="health-list">
                <div>
                  <dt>CPU</dt>
                  <dd>
                    {`${figures.host.cpu.model ?? figures.host.platform} · ${String(figures.host.cpu.cores)} cores`}
                  </dd>
                </div>
                <div>
                  <dt>CPU load</dt>
                  <dd>{formatPercent(figures.host.cpu.utilizationPercent)}</dd>
                </div>
                <div>
                  <dt>Memory</dt>
                  <dd>
                    {`${formatBytes(figures.host.memory.totalBytes - figures.host.memory.freeBytes)} used of ${formatBytes(figures.host.memory.totalBytes)}`}
                  </dd>
                </div>
                <div>
                  <dt>Disk</dt>
                  <dd>
                    {figures.host.disk === undefined
                      ? 'Unavailable'
                      : `${formatBytes(figures.host.disk.freeBytes)} free of ${formatBytes(figures.host.disk.totalBytes)} · ${figures.host.disk.path}`}
                  </dd>
                </div>
                <div>
                  <dt>GPU</dt>
                  <dd>
                    {figures.host.gpus === undefined
                      ? 'Not detected'
                      : figures.host.gpus.length === 0
                        ? 'None reported'
                        : figures.host.gpus
                            .map((gpu) =>
                              [
                                gpu.name,
                                gpu.memoryUsedBytes !== undefined &&
                                gpu.memoryTotalBytes !== undefined
                                  ? `${formatBytes(gpu.memoryUsedBytes)} of ${formatBytes(gpu.memoryTotalBytes)}`
                                  : undefined,
                                gpu.utilizationPercent === undefined
                                  ? undefined
                                  : formatPercent(gpu.utilizationPercent),
                              ]
                                .filter((part) => part !== undefined)
                                .join(' · '),
                            )
                            .join('; ')}
                  </dd>
                </div>
              </dl>
            )}
          </Panel>

          <Panel title="Footprint">
            {figures === undefined ? (
              <p className="empty-state">{resources === undefined ? 'Reading' : 'Unavailable'}</p>
            ) : (
              <dl className="health-list">
                <div>
                  <dt>Daemon memory</dt>
                  <dd>
                    {`${formatBytes(figures.daemon.rssBytes)} resident · ${formatBytes(figures.daemon.heapUsedBytes)} heap`}
                  </dd>
                </div>
                <div>
                  <dt>Daemon CPU</dt>
                  <dd>{formatPercent(figures.daemon.cpuPercent)}</dd>
                </div>
                <div>
                  <dt>Redis memory</dt>
                  <dd>
                    {figures.redis === undefined
                      ? 'Unavailable'
                      : figures.redis.maxMemoryBytes === 0
                        ? `${formatBytes(figures.redis.usedMemoryBytes)} · no limit set`
                        : `${formatBytes(figures.redis.usedMemoryBytes)} of ${formatBytes(figures.redis.maxMemoryBytes)}`}
                  </dd>
                </div>
                <div>
                  <dt>Redis keys</dt>
                  <dd>
                    {figures.redis === undefined
                      ? 'Unavailable'
                      : figures.redis.keyCount.toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt>Observed</dt>
                  <dd>
                    <time dateTime={figures.observedAt}>
                      {new Date(figures.observedAt).toLocaleTimeString()}
                    </time>
                  </dd>
                </div>
              </dl>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
