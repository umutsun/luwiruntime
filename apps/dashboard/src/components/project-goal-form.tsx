import { useState } from 'react';

import type { GoalMutations } from '../api/goal-mutations.js';

/**
 * Create an autopilot goal for the project from its drawer, so the operator can
 * start — and keep continuing — autopilot work without the CLI. A created goal
 * starts `proposed` and the CLI orchestrator's planCycle starts it on its own, so
 * this form only creates; there is no separate "start". The POST lives in the
 * allowlisted `goal-mutations.ts`, and the operator is the request's actor.
 */
export function ProjectGoalForm({
  projectId,
  goalMutations,
}: {
  projectId: string;
  goalMutations: GoalMutations;
}) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();

  const canSubmit = title.trim() !== '' && objective.trim() !== '' && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setNote(undefined);
    setError(undefined);
    const result = await goalMutations.create(projectId, {
      title: title.trim(),
      objective: objective.trim(),
    });
    setBusy(false);
    if (result.state === 'ok') {
      setTitle('');
      setObjective('');
      setNote(`Goal created — autopilot will start it: "${result.data.title}".`);
      return;
    }
    setError(result.reason === 'http' ? result.message : 'The goal could not be created.');
  };

  return (
    <section aria-label="New goal">
      <h4>New goal</h4>
      <form
        className="project-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Title
          <input
            value={title}
            maxLength={200}
            disabled={busy}
            placeholder="e.g. Add localized dates to the admin app"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Objective
          <textarea
            value={objective}
            rows={3}
            disabled={busy}
            placeholder="What &ldquo;done&rdquo; means — the outcome autopilot should reach."
            onChange={(event) => setObjective(event.target.value)}
          />
        </label>
        {error === undefined ? null : (
          <p className="outcome outcome--bad" role="alert">
            {error}
          </p>
        )}
        {note === undefined ? null : (
          <p className="coordinator-note" role="status">
            {note}
          </p>
        )}
        <div className="project-form__actions">
          <button type="submit" disabled={!canSubmit}>
            Create goal
          </button>
        </div>
      </form>
    </section>
  );
}
