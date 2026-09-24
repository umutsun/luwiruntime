import { useEffect, useRef, useState } from 'react';

import type { ProjectDiscovery, ProjectDiscoveryResult } from '../api/project-discovery.js';
import type { ProjectMutations } from '../api/project-mutations.js';
import { TableWrap } from './panel.js';

type Candidate = ProjectDiscovery['candidates'][number];

type RowState =
  | { state: 'idle' }
  | { state: 'registering' }
  | { state: 'registered'; id: string }
  | { state: 'failed'; message: string };

/**
 * "Scan a folder": the reader names a root, the daemon lists the directories
 * directly under it, and the reader registers the ones they tick — each
 * through the same `POST /projects` the register form uses, one at a time, so
 * a failure is reported on its own row and never stops the rest. There is no
 * folder picker: a browser cannot read the machine's directories, so the path
 * is typed, exactly as the CLI's `project discover` takes it.
 */
export function ProjectDiscoveryPanel({
  load,
  mutations,
  onRegistered,
  onCancel,
}: {
  load: (root: string, options?: { signal?: AbortSignal }) => Promise<ProjectDiscoveryResult>;
  mutations: ProjectMutations;
  /** The ids registered by the last batch, after it finishes; empty when none was. */
  onRegistered: (registeredIds: string[]) => void;
  onCancel: () => void;
}) {
  const rootRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<AbortController | undefined>(undefined);
  const [root, setRoot] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>();
  const [scan, setScan] = useState<ProjectDiscovery>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rootRef.current?.focus();
    return () => scanRef.current?.abort();
  }, []);

  const registrable = (candidate: Candidate): boolean =>
    candidate.existingProjectId === undefined && candidate.reason === undefined;

  const runScan = async (): Promise<void> => {
    const trimmed = root.trim();
    if (trimmed === '' || scanning || busy) return;
    scanRef.current?.abort();
    const controller = new AbortController();
    scanRef.current = controller;
    setScanning(true);
    setError(undefined);
    setScan(undefined);
    setRows({});
    const result = await load(trimmed, { signal: controller.signal });
    if (controller.signal.aborted) return;
    setScanning(false);
    if (result.state === 'failed') {
      setError(result.message);
      return;
    }
    setScan(result.data);
    // Everything registrable starts ticked; the reader unticks what they do not want.
    setSelected(new Set(result.data.candidates.filter(registrable).map((c) => c.canonicalPath)));
  };

  const toggle = (key: string, on: boolean): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const targets =
    scan === undefined
      ? []
      : scan.candidates.filter(
          (candidate) =>
            registrable(candidate) &&
            selected.has(candidate.canonicalPath) &&
            (rows[candidate.canonicalPath]?.state ?? 'idle') === 'idle',
        );

  const registerSelected = async (): Promise<void> => {
    if (busy || targets.length === 0) return;
    setBusy(true);
    const registered: string[] = [];
    for (const candidate of targets) {
      const key = candidate.canonicalPath;
      setRows((previous) => ({ ...previous, [key]: { state: 'registering' } }));
      const result = await mutations.register({
        name: candidate.displayName,
        localPath: candidate.localPath,
      });
      const outcome: RowState =
        result.state === 'ok'
          ? { state: 'registered', id: result.data.id }
          : {
              state: 'failed',
              message:
                result.reason === 'http' || result.reason === 'input'
                  ? result.message
                  : 'The registration could not be completed.',
            };
      setRows((previous) => ({ ...previous, [key]: outcome }));
      if (result.state === 'ok') registered.push(result.data.id);
    }
    setBusy(false);
    setSelected(new Set());
    onRegistered(registered);
  };

  const statusOf = (candidate: Candidate, row: RowState): string => {
    if (row.state === 'registering') return 'registering…';
    if (row.state === 'registered') return 'registered';
    if (row.state === 'failed') return row.message;
    if (candidate.existingProjectId !== undefined) return 'already registered';
    if (candidate.reason === 'outside_root') return 'resolves outside the root';
    if (candidate.reason === 'unreadable') return 'cannot be read';
    if (candidate.reason === 'excluded') return 'excluded';
    return '—';
  };

  return (
    <form
      className="project-form"
      aria-label="Scan a folder"
      onSubmit={(event) => {
        event.preventDefault();
        void runScan();
      }}
    >
      <p className="bounded-note">
        One directory level is listed. A folder already registered is marked, and one the daemon
        cannot read, or that resolves outside the root, cannot be picked. Each ticked folder is
        registered on its own, with the folder name as its project name.
      </p>
      <label>
        Root folder
        <input
          ref={rootRef}
          required
          value={root}
          disabled={scanning || busy}
          placeholder="C:/path/to/projects"
          onChange={(event) => {
            setRoot(event.target.value);
            setError(undefined);
          }}
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
        <button type="submit" disabled={scanning || busy || root.trim() === ''}>
          {scanning ? 'Scanning…' : 'Scan'}
        </button>
      </div>
      {scan === undefined ? null : scan.candidates.length === 0 ? (
        <p className="empty-state">No directories under {scan.root}</p>
      ) : (
        <>
          <TableWrap caption={`Directories under ${scan.root}`}>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Select</span>
                </th>
                <th scope="col">Folder</th>
                <th scope="col">Path</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {scan.candidates.map((candidate) => {
                const row = rows[candidate.canonicalPath] ?? { state: 'idle' };
                const pickable = registrable(candidate) && row.state === 'idle';
                return (
                  <tr key={candidate.canonicalPath}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${candidate.directoryName}`}
                        checked={pickable && selected.has(candidate.canonicalPath)}
                        disabled={!pickable || busy}
                        onChange={(event) => toggle(candidate.canonicalPath, event.target.checked)}
                      />
                    </td>
                    <td>{candidate.displayName}</td>
                    <td>
                      <code title={candidate.canonicalPath}>{candidate.localPath}</code>
                    </td>
                    <td>{statusOf(candidate, row)}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
          {scan.truncated ? (
            <p className="bounded-note">
              Only the first {scan.candidates.length} directories are listed.
            </p>
          ) : null}
          <div className="project-form__actions">
            <button
              type="button"
              disabled={busy || targets.length === 0}
              onClick={() => void registerSelected()}
            >
              {busy ? 'Registering…' : `Register ${String(targets.length)} selected`}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
