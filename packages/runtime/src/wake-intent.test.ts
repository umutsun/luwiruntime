import { describe, expect, it } from 'vitest';

import { canTransitionWakeIntent, classifyWakeProcessResult } from './wake-intent.js';

describe('wake intent state machine', () => {
  const wakeIntentStates = [
    'pending',
    'claimed',
    'dispatching',
    'dispatched',
    'fallback_only',
    'indeterminate',
  ] as const;
  const allowedWakeTransitions = new Set([
    'pending:claimed',
    'claimed:dispatching',
    'claimed:fallback_only',
    'claimed:indeterminate',
    'dispatching:dispatched',
    'dispatching:fallback_only',
    'dispatching:indeterminate',
  ]);

  it.each(
    wakeIntentStates.flatMap((from) =>
      wakeIntentStates.map((to) => [from, to, allowedWakeTransitions.has(`${from}:${to}`)]),
    ),
  )('uses the complete wake transition matrix for %s -> %s', (from, to, expected) => {
    expect(canTransitionWakeIntent(from, to)).toBe(expected);
  });

  it('preserves the safety-critical wake transition examples', () => {
    expect(canTransitionWakeIntent('pending', 'claimed')).toBe(true);
    expect(canTransitionWakeIntent('dispatching', 'dispatched')).toBe(true);
    expect(canTransitionWakeIntent('dispatching', 'claimed')).toBe(false);
    expect(canTransitionWakeIntent('indeterminate', 'claimed')).toBe(false);
  });
});

describe('wake process classification', () => {
  it.each([
    [{ started: false, spawnFailure: true }, 'fallback_only'],
    [{ started: false, spawnFailure: true, exitCode: 1 }, 'indeterminate'],
    [{ started: false, spawnFailure: true, timedOut: true }, 'indeterminate'],
    [{ started: false, spawnFailure: true, signal: 'SIGTERM' }, 'indeterminate'],
    [{ started: false, spawnFailure: true, crashed: true }, 'indeterminate'],
    [{ started: false, spawnFailure: true, ownershipLost: true }, 'indeterminate'],
    [{ started: true, exitCode: 0 }, 'dispatched'],
    [{ started: true, spawnFailure: true, exitCode: 0 }, 'indeterminate'],
    [{ started: true, exitCode: 1 }, 'indeterminate'],
    [{ started: true, timedOut: true }, 'indeterminate'],
    [{ started: true, signal: 'SIGTERM' }, 'indeterminate'],
    [{ started: true, crashed: true }, 'indeterminate'],
    [{ started: true, ownershipLost: true }, 'indeterminate'],
    [{ started: true }, 'indeterminate'],
    [{ started: false }, 'indeterminate'],
  ] as const)('classifies %o as %s', (result, expected) => {
    expect(classifyWakeProcessResult(result)).toBe(expected);
  });
});
