/**
 * Run a side effect over items with a wait between each, so a periodic fan-out
 * (the git/package scan across every project) does not run back-to-back and
 * block the event loop long enough to lapse session presence and churn the
 * fleet. The wait yields the loop; heartbeats are serviced between items.
 *
 * The wait is between items only (never after the last), and `keepGoing` lets a
 * drain/shutdown stop the fan-out early. Pure but for the injected `wait`, so it
 * is a table of test rows.
 */
export async function forEachSpaced<T>(
  items: readonly T[],
  onItem: (item: T) => void,
  options: {
    spacingMs: number;
    wait: (ms: number) => Promise<void>;
    keepGoing?: () => boolean;
  },
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    if (options.keepGoing?.() === false) return;
    onItem(items[index] as T);
    if (index < items.length - 1) await options.wait(options.spacingMs);
  }
}
