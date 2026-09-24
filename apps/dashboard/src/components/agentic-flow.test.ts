import { describe, expect, it } from 'vitest';

import { agenticStages, involvement } from './agentic-flow.js';

const activeKey = (stages: ReturnType<typeof agenticStages>) =>
  stages.find((stage) => stage.status === 'active')?.key;

describe('agenticStages', () => {
  it('sits at plan while a goal is proposed or planning', () => {
    expect(activeKey(agenticStages('proposed', 0, 0))).toBe('plan');
    expect(activeKey(agenticStages('planning', 0, 0))).toBe('plan');
  });

  it('marks review as the active human touchpoint on plan_review', () => {
    const stages = agenticStages('plan_review', 0, 3);
    expect(activeKey(stages)).toBe('review');
    expect(stages.find((stage) => stage.key === 'review')?.actor).toBe('you');
  });

  it('advances from build to verify as the tasks finish', () => {
    expect(activeKey(agenticStages('running', 0, 3))).toBe('build');
    expect(activeKey(agenticStages('running', 3, 3))).toBe('verify');
  });

  it('places a blocked goal with no plan at review, one with tasks at build', () => {
    expect(activeKey(agenticStages('blocked', 0, 0))).toBe('review');
    expect(activeKey(agenticStages('blocked', 1, 3))).toBe('build');
  });

  it('fills earlier stages done and later ones upcoming', () => {
    // running with unfinished tasks → active is build (index 2).
    expect(agenticStages('running', 0, 3).map((stage) => stage.status)).toEqual([
      'done',
      'done',
      'active',
      'upcoming',
      'upcoming',
    ]);
  });
});

describe('involvement', () => {
  it('flags the operator turn on plan_review and blocked', () => {
    expect(involvement('plan_review').you).toBe(true);
    expect(involvement('blocked').you).toBe(true);
  });

  it('reads autonomous while planning or running', () => {
    expect(involvement('planning').you).toBe(false);
    expect(involvement('running').you).toBe(false);
    expect(involvement('running').text).toContain('Agents are working');
  });
});
