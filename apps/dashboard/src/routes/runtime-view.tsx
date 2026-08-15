import type { WebSocketState } from '../app.js';
import { Panel } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours)}h ${minutes.toString().padStart(2, '0')}m`;
}

/**
 * The runtime's own identity and health, over `GET /api/v1/runtime`.
 *
 * This is where the mockup's stat strip pointed its latency and Redis
 * counters; until this route existed those stats had no destination. The
 * "Runtime health" panel moved here from Pulse with the phase-4 rebuild —
 * the strip already states daemon, latency and Redis at a glance, so on
 * Pulse the panel duplicated the line above it.
 *
 * Host and port are the loopback address this page itself was loaded from;
 * displaying them reveals nothing the browser's own URL bar does not.
 */
export function RuntimeView({
  snapshot,
  websocketState,
}: {
  snapshot: PulseSnapshot;
  websocketState: WebSocketState;
}) {
  const health = snapshot.health.state === 'ready' ? snapshot.health.data : undefined;
  const runtime = snapshot.runtime.state === 'ready' ? snapshot.runtime.data : undefined;

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
    </div>
  );
}
