import { useEffect, useState } from 'react';

const HASHED_BUNDLE = /assets\/index-[A-Za-z0-9_-]+\.js/;
const CHECK_INTERVAL_MS = 60_000;

/**
 * The hashed bundle this page is running, read from the module script that
 * loaded it. Undefined off a built page — the Vite dev server and jsdom carry
 * no hashed bundle — which is what makes the watch a no-op there.
 */
function runningBundle(): string | undefined {
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="assets/index-"]',
  );
  return script?.getAttribute('src')?.match(HASHED_BUNDLE)?.[0];
}

/**
 * Whether the daemon now serves a newer dashboard build than this tab loaded.
 *
 * The daemon reads `dist/` per request and serves `index.html` with `no-store`,
 * so a reload always gets the current build — but an open tab never learns of
 * one on its own, and a change shipped an hour ago stays invisible until the
 * owner happens to reload. This asks for `index.html` (a few hundred bytes,
 * uncached) on mount, once a minute, and whenever the tab becomes visible,
 * and compares the hashed bundle it names to the one this page is running.
 * Nothing else is fetched; a failed read (the daemon restarting, the machine
 * asleep) reports nothing and the next tick asks again.
 */
export function useBuildWatch(fetchImpl: typeof fetch | undefined = globalThis.fetch): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const running = runningBundle();
    if (running === undefined || fetchImpl === undefined) return undefined;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const response = await fetchImpl('/', {
          cache: 'no-store',
          headers: { accept: 'text/html' },
        });
        if (!response.ok) return;
        const served = (await response.text()).match(HASHED_BUNDLE)?.[0];
        if (!cancelled && served !== undefined && served !== running) setStale(true);
      } catch {
        // Unreachable daemon: nothing to report yet.
      }
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    void check();
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchImpl]);
  return stale;
}
