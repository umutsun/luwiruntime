import { describe, expect, it } from 'vitest';

import { frameJudgment, parseJudgment, validatePlannedTasks } from './judgment.js';

describe('parseJudgment', () => {
  it('accepts a bare decision object, a wrapped one, and a fenced one', () => {
    const bare = parseJudgment('review', '{"verdict":"accept","feedback":"fine","confidence":0.9}');
    expect(bare).toMatchObject({
      ok: true,
      decision: { kind: 'review', decision: { verdict: 'accept' } },
    });
    const wrapped = parseJudgment(
      'review',
      'Sure:\n```json\n{"kind":"review","decision":{"verdict":"rework","feedback":"add tests","confidence":0.7}}\n```',
    );
    expect(wrapped).toMatchObject({ ok: true, decision: { decision: { verdict: 'rework' } } });
  });

  it('reports the exact refusals for an invalid answer, and a kind mismatch', () => {
    expect(parseJudgment('plan', 'no json here')).toEqual({
      ok: false,
      errors: ['The answer contains no JSON object.'],
    });
    const invalid = parseJudgment('plan', '{"tasks":[],"confidence":2}');
    expect(invalid.ok).toBe(false);
    expect((invalid as { errors: string[] }).errors.length).toBeGreaterThan(0);
    expect(
      parseJudgment('plan', '{"kind":"review","decision":{"verdict":"accept","confidence":1}}'),
    ).toMatchObject({
      ok: false,
      errors: ['Expected a plan decision, got review.'],
    });
  });

  it('extracts the first balanced object even when braces appear inside strings', () => {
    const result = parseJudgment(
      'summarize',
      'Result: {"summary":"used } and { inside","workerNotes":{}} trailing',
    );
    expect(result).toMatchObject({
      ok: true,
      decision: { decision: { summary: 'used } and { inside' } },
    });
  });
});

describe('validatePlannedTasks', () => {
  it('refuses unknown workers, forward dependencies and an over-budget plan', () => {
    const errors = validatePlannedTasks(
      [
        {
          title: 'a',
          brief: 'a',
          agentId: 'gemini-cli',
          paths: [],
          dependsOn: [1],
          evidenceRequirements: [],
        },
        {
          title: 'b',
          brief: 'b',
          agentId: 'codex',
          paths: [],
          dependsOn: [0],
          evidenceRequirements: [],
        },
      ],
      { workers: ['codex'], maxTasks: 1, alreadyPlanned: 0 },
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('budget');
    expect(errors[1]).toContain('gemini-cli');
    expect(errors[2]).toContain('not earlier');
  });
});

describe('frameJudgment', () => {
  it('keeps the framing fixed and puts the context last', () => {
    const text = frameJudgment('plan', { goal: { id: 'g' } });
    expect(text.startsWith('LUWI autopilot judgment: plan.')).toBe(true);
    expect(text).toContain('you do not act');
    expect(text.endsWith('CONTEXT:\n\n{"goal":{"id":"g"}}')).toBe(true);
  });
});
