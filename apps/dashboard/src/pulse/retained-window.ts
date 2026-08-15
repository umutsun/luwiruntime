import type { DashboardEvent } from '../realtime/schema.js';

/**
 * Bucketing over the retained activity window.
 *
 * There is no server-side event rate. `GET /api/v1/events` takes a `limit`, not
 * a time bound, so the only thing the dashboard can honestly draw is the
 * distribution of the events it actually holds, across the span those events
 * cover. On a quiet runtime that span can be days — which is precisely why the
 * caller must label the mark with `spanLabel` rather than as "per minute".
 *
 * The result carries counts, including zeros. Whether an empty bucket is drawn
 * as a gap is the view's rule, not this module's: within the window a bucket
 * with no events genuinely observed none, and throwing that away here would
 * make a real measurement indistinguishable from a failed read.
 */
export type RetainedWindow = {
  /** One count per bucket, oldest first. Empty when nothing was retained. */
  buckets: number[];
  /** Events that landed in a bucket. */
  total: number;
  /** Events whose `occurredAt` could not be parsed, and so were not bucketed. */
  ignored: number;
  spanMs: number;
  firstAt?: string;
  lastAt?: string;
  spanLabel?: string;
};

function formatSpan(spanMs: number): string {
  if (spanMs <= 0) return 'a moment';
  const seconds = Math.round(spanMs / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

/**
 * The window a caller wants the buckets laid out over.
 *
 * Supplied when several traces must share one time axis — the per-project rows
 * against the strip's whole-runtime window. Without it each trace would derive
 * its own span, and two bars in the same column would stand for two unrelated
 * instants.
 */
export type RetainedBounds = { firstMs: number; lastMs: number };

export function bucketRetainedWindow(
  events: readonly DashboardEvent[],
  bucketCount: number,
  bounds?: RetainedBounds,
): RetainedWindow {
  const stamps: number[] = [];
  let ignored = 0;
  for (const event of events) {
    const parsed = Date.parse(event.occurredAt);
    // Untrusted input: a NaN would anchor the window at the epoch and flatten
    // every real bucket into the last one.
    if (Number.isFinite(parsed)) stamps.push(parsed);
    else ignored += 1;
  }

  if (stamps.length === 0) return { buckets: [], total: 0, ignored, spanMs: 0 };

  const first = bounds?.firstMs ?? Math.min(...stamps);
  const last = bounds?.lastMs ?? Math.max(...stamps);
  const spanMs = Math.max(0, last - first);
  const base = {
    total: stamps.length,
    ignored,
    spanMs,
    firstAt: new Date(first).toISOString(),
    lastAt: new Date(last).toISOString(),
    spanLabel: formatSpan(spanMs),
  };

  // Every event shares one instant, so there is exactly one bucket to draw.
  // Spreading it over `bucketCount` would render a single observation as a
  // mostly-empty series and imply quiet intervals that were never observed.
  if (spanMs === 0) return { ...base, buckets: [stamps.length] };

  const buckets = Array.from({ length: bucketCount }, () => 0);
  for (const stamp of stamps) {
    const slot = Math.min(bucketCount - 1, Math.floor(((stamp - first) / spanMs) * bucketCount));
    buckets[slot] = (buckets[slot] ?? 0) + 1;
  }

  return { ...base, buckets };
}
