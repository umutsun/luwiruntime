import { useCallback, useState } from 'react';

/**
 * The five lenses, in the order the switch shows them. Four draw the whole
 * overview model; Knowledge draws one project's graphify graph and reads it
 * only while it is open.
 */
export const VIEW_CHOICES = ['board', 'flow', 'radial', 'timeline', 'knowledge'] as const;
export type ViewChoice = (typeof VIEW_CHOICES)[number];

export const VIEW_LABELS: Record<ViewChoice, string> = {
  board: 'Board',
  flow: 'Flow',
  radial: 'Radial',
  timeline: 'Timeline',
  knowledge: 'Knowledge',
};

const STORAGE_KEY = 'luwi.view';

function isViewChoice(value: unknown): value is ViewChoice {
  return VIEW_CHOICES.includes(value as ViewChoice);
}

/**
 * Reads the stored lens defensively, exactly as `use-theme.ts` reads the
 * theme: storage may throw, and an unreadable preference is not worth a blank
 * dashboard. Anything unrecognised is the Board.
 */
function storedChoice(): ViewChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isViewChoice(raw) ? raw : 'board';
  } catch {
    return 'board';
  }
}

export function useViewChoice(): { view: ViewChoice; setView: (next: ViewChoice) => void } {
  const [view, setViewState] = useState<ViewChoice>(storedChoice);
  const setView = useCallback((next: ViewChoice) => {
    setViewState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A preference that cannot be persisted still applies for this session.
    }
  }, []);
  return { view, setView };
}
