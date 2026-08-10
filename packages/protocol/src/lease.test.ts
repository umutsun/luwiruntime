import { describe, expect, it } from 'vitest';

import {
  LEASE_MAX_ACTIVE_PER_PROJECT,
  leasePathsConflict,
  normalizeLeasePath,
  workLeaseSchema,
  leaseAcquireRequestSchema,
  type WorkLease,
} from './lease.js';

describe('normalizeLeasePath', () => {
  it('keeps a plain relative path and derives a lowercased match form', () => {
    expect(normalizeLeasePath('apps/daemon/src')).toEqual({
      path: 'apps/daemon/src',
      matchPath: 'apps/daemon/src/',
    });
  });

  it('accepts Windows separators, because half the callers on this platform produce them', () => {
    expect(normalizeLeasePath('apps\\daemon\\src').path).toBe('apps/daemon/src');
  });

  it('collapses repeated separators and strips a leading ./ and surrounding slashes', () => {
    expect(normalizeLeasePath('./apps//daemon/src/').path).toBe('apps/daemon/src');
  });

  /**
   * Case-insensitive matching is deliberate. On this platform `src/App.ts` and
   * `src/app.ts` are the same file, so comparing case-sensitively would miss a
   * real collision. The reverse error — refusing two genuinely distinct files
   * on a case-sensitive filesystem — costs a retry; missing a collision costs
   * the thing this feature exists to prevent.
   */
  it('lowercases only the match form and preserves the path as written', () => {
    const result = normalizeLeasePath('Apps/Daemon/App.ts');
    expect(result.path).toBe('Apps/Daemon/App.ts');
    expect(result.matchPath).toBe('apps/daemon/app.ts/');
  });

  it('represents a whole-project lease as a match form that prefixes everything', () => {
    expect(normalizeLeasePath('.')).toEqual({ path: '.', matchPath: '' });
  });

  /**
   * Stripping a leading separator would silently turn an absolute path into a
   * different project-relative one, so both forms are refused instead.
   */
  it('refuses an absolute path rather than reinterpreting it', () => {
    expect(() => normalizeLeasePath('/etc/passwd')).toThrow(/relative/i);
    expect(() => normalizeLeasePath('C:/Windows')).toThrow(/relative/i);
    expect(() => normalizeLeasePath('\\\\server\\share')).toThrow(/relative/i);
  });

  it('refuses a path that climbs out of the project', () => {
    expect(() => normalizeLeasePath('apps/../../secrets')).toThrow(/outside/i);
    expect(() => normalizeLeasePath('..')).toThrow(/outside/i);
  });

  it('refuses an empty path, which is not the same request as a whole-project lease', () => {
    expect(() => normalizeLeasePath('')).toThrow(/empty/i);
    expect(() => normalizeLeasePath('   ')).toThrow(/empty/i);
  });

  /**
   * A bare separator run is refused as absolute rather than as empty, and that
   * is the more useful of the two answers: it names what is wrong with the
   * input the caller actually sent.
   */
  it('refuses a bare separator run as an absolute path', () => {
    expect(() => normalizeLeasePath('///')).toThrow(/relative/i);
  });

  it('refuses a path beyond the bounds the record can carry', () => {
    expect(() => normalizeLeasePath('a/'.repeat(200))).toThrow(/segments/i);
    expect(() => normalizeLeasePath('a'.repeat(4097))).toThrow(/long/i);
  });
});

describe('leasePathsConflict', () => {
  const match = (value: string) => normalizeLeasePath(value).matchPath;

  it('finds the same path in conflict with itself', () => {
    expect(leasePathsConflict(match('src/app.ts'), match('src/app.ts'))).toBe(true);
  });

  it('finds a file in conflict with a directory that contains it, in both orders', () => {
    expect(leasePathsConflict(match('apps/daemon/src'), match('apps/daemon/src/app.ts'))).toBe(
      true,
    );
    expect(leasePathsConflict(match('apps/daemon/src/app.ts'), match('apps/daemon/src'))).toBe(
      true,
    );
  });

  /**
   * The classic prefix bug: `src/app` is not a parent of `src/appendix`, and a
   * raw string comparison says it is. The trailing separator in the match form
   * is what makes the comparison segment-aware.
   */
  it('does not confuse a sibling whose name starts with the same characters', () => {
    expect(leasePathsConflict(match('src/app'), match('src/appendix'))).toBe(false);
    expect(leasePathsConflict(match('src/app.ts'), match('src/app.test.ts'))).toBe(false);
  });

  it('finds no conflict between unrelated branches', () => {
    expect(leasePathsConflict(match('apps/daemon'), match('apps/dashboard'))).toBe(false);
  });

  it('puts a whole-project lease in conflict with everything, including itself', () => {
    expect(leasePathsConflict(match('.'), match('apps/daemon/src'))).toBe(true);
    expect(leasePathsConflict(match('apps/daemon/src'), match('.'))).toBe(true);
    expect(leasePathsConflict(match('.'), match('.'))).toBe(true);
  });

  it('matches paths differing only in case, on the platform where that is one file', () => {
    expect(leasePathsConflict(match('src/App.ts'), match('src/app.ts'))).toBe(true);
  });
});

describe('leaseAcquireRequestSchema', () => {
  it('accepts a request and applies the default duration', () => {
    const parsed = leaseAcquireRequestSchema.parse({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      path: 'apps/daemon/src',
      reason: 'rewriting the capability route',
    });
    expect(parsed.durationMs).toBe(300_000);
  });

  it('bounds the requested duration so a lease cannot be held indefinitely', () => {
    expect(() =>
      leaseAcquireRequestSchema.parse({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        path: 'src',
        reason: 'x',
        durationMs: 60 * 60 * 1000 + 1,
      }),
    ).toThrow();
    expect(() =>
      leaseAcquireRequestSchema.parse({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        path: 'src',
        reason: 'x',
        durationMs: 999,
      }),
    ).toThrow();
  });

  it('requires a reason, because an unexplained hold cannot be judged by whoever it blocks', () => {
    expect(() =>
      leaseAcquireRequestSchema.parse({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        path: 'src',
      }),
    ).toThrow();
  });
});

describe('workLeaseSchema', () => {
  const lease: WorkLease = {
    id: 'lease-1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    agentId: 'seed-codex',
    path: 'apps/daemon/src',
    matchPath: 'apps/daemon/src/',
    reason: 'rewriting the capability route',
    state: 'held',
    acquiredAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:05:00.000Z',
  };

  it('validates a held lease', () => {
    expect(workLeaseSchema.parse(lease)).toMatchObject({ state: 'held' });
  });

  it('rejects a match form that does not correspond to its path', () => {
    expect(() => workLeaseSchema.parse({ ...lease, matchPath: 'somewhere/else/' })).toThrow();
  });

  /** A released lease that never recorded when is not a released lease. */
  it('requires a release timestamp once the state says released', () => {
    expect(() => workLeaseSchema.parse({ ...lease, state: 'released' })).toThrow();
    expect(
      workLeaseSchema.parse({
        ...lease,
        state: 'released',
        releasedAt: '2026-08-10T00:02:00.000Z',
      }),
    ).toMatchObject({ state: 'released' });
  });

  it('bounds how many leases a project may hold at once', () => {
    expect(LEASE_MAX_ACTIVE_PER_PROJECT).toBe(100);
  });
});
