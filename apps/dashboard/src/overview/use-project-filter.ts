import { useCallback, useState } from 'react';

/**
 * Which projects the overview shows.
 *
 * Two persisted choices: projects the owner switched off one by one, and a
 * "hide quiet" rule that drops every project without an active session. The
 * switched-off set is stored as the *hidden* ids rather than the visible ones,
 * so a project registered tomorrow shows up rather than starting hidden.
 * Storage is read the way `use-theme.ts` reads it: anything unreadable or
 * malformed is the default, which is everything visible.
 */
export type ProjectFilter = { hidden: ReadonlySet<string>; hideQuiet: boolean };

const STORAGE_KEY = 'luwi.projects';
const EMPTY: ProjectFilter = { hidden: new Set(), hideQuiet: false };

function storedFilter(): ProjectFilter {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const record = parsed as { hidden?: unknown; hideQuiet?: unknown };
    const hidden = Array.isArray(record.hidden)
      ? record.hidden.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    return { hidden: new Set(hidden), hideQuiet: record.hideQuiet === true };
  } catch {
    return EMPTY;
  }
}

function persist(filter: ProjectFilter): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hidden: [...filter.hidden], hideQuiet: filter.hideQuiet }),
    );
  } catch {
    // A preference that cannot be persisted still applies for this session.
  }
}

export function useProjectFilter(): ProjectFilter & {
  /** Switch one project off or back on. */
  toggle: (projectId: string) => void;
  /** Keep only this project, given every id currently registered. */
  only: (projectId: string, allIds: readonly string[]) => void;
  /** Switch every project back on; the quiet rule is left as it is. */
  showAll: () => void;
  setHideQuiet: (hideQuiet: boolean) => void;
} {
  const [filter, setFilter] = useState<ProjectFilter>(storedFilter);
  const update = useCallback((next: (current: ProjectFilter) => ProjectFilter) => {
    setFilter((current) => {
      const value = next(current);
      persist(value);
      return value;
    });
  }, []);

  const toggle = useCallback(
    (projectId: string) =>
      update((current) => {
        const hidden = new Set(current.hidden);
        if (hidden.has(projectId)) hidden.delete(projectId);
        else hidden.add(projectId);
        return { ...current, hidden };
      }),
    [update],
  );
  const only = useCallback(
    (projectId: string, allIds: readonly string[]) =>
      update((current) => ({
        ...current,
        hidden: new Set(allIds.filter((id) => id !== projectId)),
      })),
    [update],
  );
  const showAll = useCallback(
    () => update((current) => ({ ...current, hidden: new Set() })),
    [update],
  );
  const setHideQuiet = useCallback(
    (hideQuiet: boolean) => update((current) => ({ ...current, hideQuiet })),
    [update],
  );

  return { ...filter, toggle, only, showAll, setHideQuiet };
}

/**
 * The ids the overview may show, or `undefined` when nothing is filtered —
 * the no-filter case is the common one and must cost no work.
 */
export function visibleProjectIds(
  filter: ProjectFilter,
  projects: ReadonlyArray<{ id: string; active: boolean }>,
): ReadonlySet<string> | undefined {
  if (filter.hidden.size === 0 && !filter.hideQuiet) return undefined;
  return new Set(
    projects
      .filter((project) => !filter.hidden.has(project.id) && (!filter.hideQuiet || project.active))
      .map((project) => project.id),
  );
}
