import { useEffect, useRef, useState } from 'react';

import type {
  ProjectMutationResult,
  ProjectMutations,
  ProjectRecord,
} from '../api/project-mutations.js';
import type { PulseProject } from '../pulse/model.js';

/**
 * Project fields, edited in place: register a project, or change one that is
 * registered. It is a plain form for the detail drawer to hold — there is no
 * dialog of its own, the drawer already owns focus and Escape. The local path
 * is the project's identity and is shown, never edited; clearing the remote or
 * the default branch sends `null`, which is the protocol's word for "remove",
 * not an empty string.
 */
export type ProjectFormMode = { kind: 'register' } | { kind: 'edit'; project: PulseProject };

function failureMessage(result: ProjectMutationResult): string {
  if (result.state === 'ok') return '';
  if (result.reason === 'http' || result.reason === 'input') return result.message;
  if (result.reason === 'transport') {
    return 'The daemon could not be reached. Check runtime status and try again.';
  }
  return 'The daemon returned an invalid response. The change was not confirmed.';
}

export function ProjectForm({
  mode,
  mutations,
  onSuccess,
  onCancel,
}: {
  mode: ProjectFormMode;
  mutations: ProjectMutations;
  onSuccess: (project: ProjectRecord, mode: ProjectFormMode['kind']) => void;
  onCancel: () => void;
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const existing = mode.kind === 'edit' ? mode.project : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [localPath, setLocalPath] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState(existing?.repositoryUrl ?? '');
  const [defaultBranch, setDefaultBranch] = useState(existing?.defaultBranch ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const trimmed = {
    name: name.trim(),
    localPath: localPath.trim(),
    repositoryUrl: repositoryUrl.trim(),
    defaultBranch: defaultBranch.trim(),
  };
  const changed =
    existing === undefined
      ? trimmed.name !== '' && trimmed.localPath !== ''
      : trimmed.name !== existing.name ||
        trimmed.repositoryUrl !== (existing.repositoryUrl ?? '') ||
        trimmed.defaultBranch !== (existing.defaultBranch ?? '');
  const canSubmit = !busy && trimmed.name !== '' && changed;

  const submit = async () => {
    if (busyRef.current || !canSubmit) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    const result =
      existing === undefined
        ? await mutations.register({
            name: trimmed.name,
            localPath: trimmed.localPath,
            ...(trimmed.repositoryUrl === '' ? {} : { repositoryUrl: trimmed.repositoryUrl }),
            ...(trimmed.defaultBranch === '' ? {} : { defaultBranch: trimmed.defaultBranch }),
          })
        : await mutations.update(existing.id, {
            ...(trimmed.name === existing.name ? {} : { name: trimmed.name }),
            ...(trimmed.repositoryUrl === (existing.repositoryUrl ?? '')
              ? {}
              : { repositoryUrl: trimmed.repositoryUrl === '' ? null : trimmed.repositoryUrl }),
            ...(trimmed.defaultBranch === (existing.defaultBranch ?? '')
              ? {}
              : { defaultBranch: trimmed.defaultBranch === '' ? null : trimmed.defaultBranch }),
          });
    if (result.state === 'ok') {
      onSuccess(result.data, mode.kind);
      return;
    }
    busyRef.current = false;
    setBusy(false);
    setError(failureMessage(result));
  };

  const edit = (change: () => void) => {
    change();
    setError(undefined);
  };

  return (
    <form
      className="project-form"
      aria-label={existing === undefined ? 'Register a project' : 'Edit project'}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="bounded-note">
        {existing === undefined
          ? 'The path is canonicalised and checked for a duplicate by the daemon; the remote and default branch are detected from Git when left empty.'
          : 'The local path is the project’s identity and cannot change. Leave a field empty to clear it.'}
      </p>
      <label>
        Name
        <input
          ref={firstFieldRef}
          required
          value={name}
          disabled={busy}
          onChange={(event) => edit(() => setName(event.target.value))}
        />
      </label>
      {existing === undefined ? (
        <label>
          Local path
          <input
            required
            value={localPath}
            disabled={busy}
            placeholder="C:/path/to/project"
            onChange={(event) => edit(() => setLocalPath(event.target.value))}
          />
        </label>
      ) : (
        <p className="project-form__path">
          <span>Local path</span>
          <code title={existing.localPath}>{existing.localPath}</code>
        </p>
      )}
      <label>
        Repository URL (optional)
        <input
          value={repositoryUrl}
          disabled={busy}
          onChange={(event) => edit(() => setRepositoryUrl(event.target.value))}
        />
      </label>
      <label>
        Default branch (optional)
        <input
          value={defaultBranch}
          disabled={busy}
          onChange={(event) => edit(() => setDefaultBranch(event.target.value))}
        />
      </label>
      {error === undefined ? null : (
        <p className="outcome outcome--bad" role="alert">
          {error}
        </p>
      )}
      <div className="project-form__actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={!canSubmit}>
          {busy ? 'Saving…' : existing === undefined ? 'Register project' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
