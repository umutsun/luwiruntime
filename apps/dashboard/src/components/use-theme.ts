import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'luwi.theme';

function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Reads the stored choice defensively.
 *
 * `localStorage` throws rather than returning null when storage is disabled or
 * a quota is exhausted, and a dashboard that fails to render because it could
 * not read a colour preference would be a poor trade. Anything unreadable or
 * unrecognised falls back to following the operating system.
 */
function storedChoice(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeChoice(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/**
 * The theme control the stylesheet was always written for.
 *
 * `tokens.css` has carried three states since the light theme landed: a dark
 * `:root`, a `prefers-color-scheme: light` block scoped so an explicit dark
 * choice still wins, and a `[data-theme='light']` block. Nothing ever set the
 * attribute, so only two of the three were reachable and the user had no say.
 * This is the missing half, not a new capability.
 *
 * `system` removes the attribute rather than resolving the media query itself,
 * so the page keeps following the OS when it changes mid-session.
 */
export function useTheme(): { choice: ThemeChoice; setChoice: (next: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(storedChoice);

  useEffect(() => {
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A preference that cannot be persisted still applies for this session.
    }
  }, []);

  return { choice, setChoice };
}

/**
 * The three choices as a segmented control shows them. A segment, not a cycling
 * icon: the system-following default stays visible instead of being one of
 * three states hidden behind a single glyph.
 */
export const THEME_OPTIONS: ReadonlyArray<{ choice: ThemeChoice; label: string; title: string }> = [
  { choice: 'system', label: 'Auto', title: 'Follow the operating system' },
  { choice: 'light', label: 'Light', title: 'Light theme' },
  { choice: 'dark', label: 'Dark', title: 'Dark theme' },
];
