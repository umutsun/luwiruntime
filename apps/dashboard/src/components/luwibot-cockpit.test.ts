import { describe, expect, it } from 'vitest';

import { cockpitStatus } from './luwibot-cockpit.js';

describe('cockpitStatus', () => {
  it('speaks the right line for each goal state', () => {
    expect(cockpitStatus('proposed', 0, 0)).toBe('Queued · waiting to plan');
    expect(cockpitStatus('planning', 0, 0)).toBe('Planning…');
    expect(cockpitStatus('plan_review', 0, 3)).toBe('Plan ready · 3 steps to review');
    expect(cockpitStatus('plan_review', 0, 1)).toBe('Plan ready · 1 step to review');
    expect(cockpitStatus('plan_review', 0, 0)).toBe('Plan ready to review');
    expect(cockpitStatus('blocked', 0, 0)).toBe('Blocked · needs your answer');
    expect(cockpitStatus('running', 2, 3)).toBe('2 of 3 tasks done');
    expect(cockpitStatus('running', 1, 1)).toBe('1 of 1 task done');
    expect(cockpitStatus('running', 0, 0)).toBe('Running…');
  });
});
