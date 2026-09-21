import { useEffect, useState } from 'react';

import type { AutopilotMode } from '@luwi/protocol/browser';

import type { AutopilotMutations } from '../api/autopilot-mutations.js';
import type { AutopilotStatus } from '../api/autopilot-status.js';
import type { ResourceState } from './panel.js';

/**
 * The autopilot mode switch (ADR 0035) in the project drawer.
 *
 * The same switch already lives in the overview drill-down, but only there; the
 * drawer is where the project's other settings — edit, unregister, skills — are,
 * so the mode belongs here too for discoverability. It reuses the existing
 * `autopilotMutations.setMode` write and the `loadAutopilot` read, so it adds no
 * write surface: the POST stays in the allowlisted `autopilot-mutations.ts`.
 */
const MODES: readonly AutopilotMode[] = ['off', 'supervised', 'autopilot'];

const actionLabel = (mode: AutopilotMode): string =>
  mode === 'off' ? 'Turn off' : mode === 'supervised' ? 'Enable supervised' : 'Enable autopilot';

const modeLabel = (mode: AutopilotMode): string =>
  mode === 'off' ? 'Off' : mode === 'supervised' ? 'Supervised' : 'Autopilot';

export function ProjectAutopilot({
  projectId,
  loadAutopilot,
  autopilotMutations,
}: {
  projectId: string;
  loadAutopilot: (
    projectId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ResourceState<AutopilotStatus>>;
  autopilotMutations: AutopilotMutations;
}) {
  // Undefined until the first read returns: `ResourceState` has no loading state.
  const [status, setStatus] = useState<ResourceState<AutopilotStatus>>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();

  useEffect(() => {
    setNote(undefined);
    setStatus(undefined);
    const controller = new AbortController();
    void loadAutopilot(projectId, { signal: controller.signal }).then((next) => {
      if (controller.signal.aborted) return;
      setStatus(next);
    });
    return () => controller.abort();
  }, [loadAutopilot, projectId]);

  const ready = status?.state === 'ready' ? status.data : undefined;

  const setMode = async (mode: AutopilotMode): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNote(undefined);
    const result = await autopilotMutations.setMode(projectId, mode);
    setBusy(false);
    if (result.state === 'ok') {
      setStatus({
        state: 'ready',
        data: {
          mode: result.data.record.mode,
          configured: result.data.record.policy !== null,
          // The daemon only tells us it notified a coordinator; keep the last
          // known online flag otherwise, so the hint does not flip to false on a
          // mode change that did not touch the coordinator.
          coordinatorOnline: result.data.coordinatorNotified || (ready?.coordinatorOnline ?? false),
        },
      });
      setNote(result.data.changed ? `Autopilot set to ${mode}.` : `Autopilot already ${mode}.`);
      return;
    }
    setNote(
      result.reason === 'http' ? result.message : 'The autopilot update could not be completed.',
    );
  };

  return (
    <section aria-label="Autopilot mode">
      <h4>Autopilot</h4>
      {status === undefined ? (
        <p className="coordinator-note">Reading autopilot…</p>
      ) : ready === undefined ? (
        <p className="coordinator-note">Autopilot status is unavailable.</p>
      ) : (
        <>
          <p className="coordinator-note">
            Mode: <strong>{modeLabel(ready.mode)}</strong>
            {ready.mode !== 'off' && !ready.coordinatorOnline
              ? ' — no live coordinator, so it dispatches nothing.'
              : null}
          </p>
          <div className="row-actions">
            {MODES.filter((mode) => mode !== ready.mode).map((mode) => (
              <button
                key={mode}
                type="button"
                className="row-action"
                disabled={busy}
                onClick={() => void setMode(mode)}
                aria-label={`${actionLabel(mode)} for project ${projectId}`}
              >
                {actionLabel(mode)}
              </button>
            ))}
          </div>
        </>
      )}
      {note === undefined ? null : (
        <p className="coordinator-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
