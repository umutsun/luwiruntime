import { describe, expect, it } from 'vitest';

import { publicErrorResponseSchema } from './public-error.js';

describe('public error response', () => {
  it('accepts the shape the daemon returns for a refused mutation', () => {
    const parsed = publicErrorResponseSchema.parse({
      error: { code: 'CONFIG_PLAN_EXPIRED', message: 'The configuration plan has expired.' },
    });

    expect(parsed.error.code).toBe('CONFIG_PLAN_EXPIRED');
  });

  it('accepts bounded safe details and rejects unbounded ones', () => {
    expect(
      publicErrorResponseSchema.safeParse({
        error: { code: 'X', message: 'y', details: { existingProjectId: 'p-1', count: 2 } },
      }).success,
    ).toBe(true);
    expect(
      publicErrorResponseSchema.safeParse({
        error: { code: 'X', message: 'y', details: { nested: { deep: true } } },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty code or message, so a failure cannot render as blank', () => {
    expect(publicErrorResponseSchema.safeParse({ error: { code: '', message: 'y' } }).success).toBe(
      false,
    );
    expect(publicErrorResponseSchema.safeParse({ error: { code: 'X', message: '' } }).success).toBe(
      false,
    );
  });
});
