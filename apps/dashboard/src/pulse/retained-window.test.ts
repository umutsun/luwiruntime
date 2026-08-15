import { describe, expect, it } from 'vitest';

import type { DashboardEvent } from '../realtime/schema.js';
import { bucketRetainedWindow } from './retained-window.js';

function event(occurredAt: string, streamId = occurredAt): DashboardEvent {
  return {
    streamId,
    id: streamId,
    type: 'session.status_changed',
    occurredAt,
    workspaceId: 'w1',
    payload: {},
  } as DashboardEvent;
}

describe('retained window bucketing', () => {
  it('spreads events across buckets spanning the first and last observation', () => {
    const window = bucketRetainedWindow(
      [
        event('2026-08-05T08:00:00.000Z'),
        event('2026-08-05T08:00:01.000Z'),
        event('2026-08-05T09:00:00.000Z'),
        event('2026-08-05T10:00:00.000Z'),
      ],
      4,
    );

    expect(window.buckets).toEqual([2, 0, 1, 1]);
    expect(window.total).toBe(4);
    expect(window.spanMs).toBe(7_200_000);
    expect(window.firstAt).toBe('2026-08-05T08:00:00.000Z');
    expect(window.lastAt).toBe('2026-08-05T10:00:00.000Z');
  });

  it('reports a zero bucket as a real observed zero, not as an absent measurement', () => {
    // The rendering rule — an empty bucket is a gap, never a drawn zero — is
    // the view's. The model keeps the count, because within the retained
    // window a bucket with no events is a thing that was measured.
    const window = bucketRetainedWindow(
      [event('2026-08-05T08:00:00.000Z'), event('2026-08-05T08:00:04.000Z')],
      4,
    );

    expect(window.buckets).toEqual([1, 0, 0, 1]);
  });

  it('has no window at all when nothing was retained', () => {
    const window = bucketRetainedWindow([], 7);

    expect(window.buckets).toEqual([]);
    expect(window.total).toBe(0);
    expect(window.spanMs).toBe(0);
    expect(window.firstAt).toBeUndefined();
    expect(window.lastAt).toBeUndefined();
  });

  it('puts a zero-span window in one bucket rather than dividing by zero', () => {
    const window = bucketRetainedWindow(
      [event('2026-08-05T08:00:00.000Z', 'a'), event('2026-08-05T08:00:00.000Z', 'b')],
      5,
    );

    expect(window.buckets).toEqual([2]);
    expect(window.spanMs).toBe(0);
  });

  it('is not ordered by input, because the retained read is newest-first', () => {
    const window = bucketRetainedWindow(
      [
        event('2026-08-05T10:00:00.000Z'),
        event('2026-08-05T09:00:00.000Z'),
        event('2026-08-05T08:00:00.000Z'),
      ],
      3,
    );

    expect(window.buckets).toEqual([1, 1, 1]);
    expect(window.firstAt).toBe('2026-08-05T08:00:00.000Z');
  });

  it('drops an unparseable timestamp instead of bucketing it at the epoch', () => {
    // Redis data is untrusted input (AGENTS.md section 7/14). A NaN here would
    // silently anchor the window at 1970 and flatten every real bucket.
    const window = bucketRetainedWindow(
      [event('not-a-timestamp'), event('2026-08-05T08:00:00.000Z')],
      2,
    );

    expect(window.total).toBe(1);
    expect(window.ignored).toBe(1);
  });

  it('counts only the events a caller filtered in, so a per-project trace is honest', () => {
    const window = bucketRetainedWindow([event('2026-08-05T08:00:00.000Z')], 7);

    expect(window.buckets).toEqual([1]);
    expect(window.total).toBe(1);
  });

  it('accepts the enclosing window, so per-project traces share one time axis', () => {
    // Each project bucketing its own span would put unrelated instants in the
    // same column and invite a comparison across rows that means nothing.
    const bounds = {
      firstMs: Date.parse('2026-08-05T08:00:00.000Z'),
      lastMs: Date.parse('2026-08-05T12:00:00.000Z'),
    };
    const window = bucketRetainedWindow([event('2026-08-05T11:00:00.000Z')], 4, bounds);

    // Four one-hour buckets over 08:00-12:00; 11:00 opens the last of them.
    expect(window.buckets).toEqual([0, 0, 0, 1]);
    expect(window.spanMs).toBe(14_400_000);
  });

  it('still draws one bucket when the enclosing window has no span', () => {
    const instant = Date.parse('2026-08-05T08:00:00.000Z');
    const window = bucketRetainedWindow([event('2026-08-05T08:00:00.000Z')], 4, {
      firstMs: instant,
      lastMs: instant,
    });

    expect(window.buckets).toEqual([1]);
  });

  it('reports an empty filtered set inside an enclosing window as no window at all', () => {
    const window = bucketRetainedWindow([], 4, {
      firstMs: Date.parse('2026-08-05T08:00:00.000Z'),
      lastMs: Date.parse('2026-08-05T12:00:00.000Z'),
    });

    expect(window.buckets).toEqual([]);
    expect(window.total).toBe(0);
  });
});

describe('retained window labelling', () => {
  it('describes the span so the strip cannot be read as a per-minute rate', () => {
    const window = bucketRetainedWindow(
      [event('2026-08-05T08:00:00.000Z'), event('2026-08-05T10:30:00.000Z')],
      4,
    );

    expect(window.spanLabel).toBe('2h 30m');
  });

  it('says so when the window has no measurable span', () => {
    expect(bucketRetainedWindow([event('2026-08-05T08:00:00.000Z')], 4).spanLabel).toBe('a moment');
    expect(bucketRetainedWindow([], 4).spanLabel).toBeUndefined();
  });
});
