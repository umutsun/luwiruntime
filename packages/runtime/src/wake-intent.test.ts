import { describe, expect, it } from 'vitest';

import { canTransitionWakeIntent, classifyWakeProcessResult } from './wake-intent.js';

describe('wake intent state machine', () => {
  it.each([
    ['pending', 'claimed', true],
    ['claimed', 'dispatching', true],
    ['claimed', 'fallback_only', true],
    ['claimed', 'indeterminate', true],
    ['dispatching', 'dispatched', true],
    ['dispatching', 'fallback_only', true],
    ['dispatching', 'indeterminate', true],
    ['dispatching', 'claimed', false],
    ['pending', 'fallback_only', false],
    ['dispatched', 'claimed', false],
    ['fallback_only', 'claimed', false],
    ['indeterminate', 'claimed', false],
  ] as const)('allows wake transition %s -> %s: %s', (from, to, expected) => {
    expect(canTransitionWakeIntent(from, to)).toBe(expected);
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
