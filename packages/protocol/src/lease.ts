import { z } from 'zod';

/**
 * Advisory work leases.
 *
 * A session takes a lease over a project-relative path before it edits there.
 * Two leases conflict when one path contains the other, and the runtime refuses
 * the second rather than granting it — the refusal is the whole point, because
 * a hold that never says no teaches its callers to stop asking.
 *
 * Advisory means the runtime cannot enforce it: AGENTS.md section 3 is explicit
 * that LUWI coordinates execution and does not inject into terminals, so an
 * agent that ignores a denial still edits the file. What the runtime guarantees
 * is a definite, atomic answer and a record of who holds what.
 */

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

/** Bounds the work `luwi_lease_acquire_v1` does inside one Redis Function call. */
export const LEASE_MAX_ACTIVE_PER_PROJECT = 100;
export const LEASE_DEFAULT_DURATION_MS = 300_000;
export const LEASE_MIN_DURATION_MS = 1_000;
export const LEASE_MAX_DURATION_MS = 3_600_000;

const MAX_PATH_LENGTH = 4096;
const MAX_PATH_SEGMENTS = 64;

export class LeasePathError extends Error {
  readonly code = 'LEASE_PATH_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'LeasePathError';
  }
}

export type NormalizedLeasePath = {
  /** As the caller wrote it, minus separator noise. This is what is displayed. */
  path: string;
  /**
   * The form conflict detection compares: lowercased, forward-slashed, and
   * terminated by a separator.
   *
   * The trailing separator is what makes a plain string prefix comparison
   * segment-aware. Without it `src/app` prefixes `src/appendix` and the runtime
   * would refuse a lease over an unrelated sibling. A whole-project lease is
   * the empty string, which prefixes everything — which is exactly right.
   */
  matchPath: string;
};

/**
 * Case is folded on purpose. On Windows `src/App.ts` and `src/app.ts` are one
 * file, so a case-sensitive comparison would miss a real collision. The
 * opposite error — refusing two genuinely distinct files on a case-sensitive
 * filesystem — costs a retry, and missing a collision costs the thing this
 * feature exists to prevent.
 */
export function normalizeLeasePath(input: string): NormalizedLeasePath {
  const trimmed = input.trim();
  if (trimmed === '') throw new LeasePathError('A lease path cannot be empty.');
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new LeasePathError(`A lease path cannot be longer than ${String(MAX_PATH_LENGTH)}.`);
  }

  const slashed = trimmed.replaceAll('\\', '/');
  // Refused rather than stripped: dropping a leading separator would silently
  // turn an absolute path into a different project-relative one.
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
    throw new LeasePathError('A lease path must be relative to the project root.');
  }

  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new LeasePathError('A lease path cannot point outside the project.');
  }
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw new LeasePathError(`A lease path cannot exceed ${String(MAX_PATH_SEGMENTS)} segments.`);
  }

  // Nothing but `.` segments survived, so the caller asked for the project
  // itself. A leading separator was already refused above, so this is the only
  // way to arrive here.
  if (segments.length === 0) return { path: '.', matchPath: '' };

  const path = segments.join('/');
  return { path, matchPath: `${path.toLowerCase()}/` };
}

/**
 * Whether two normalized match forms describe overlapping work.
 *
 * Containment in either direction is a conflict: a lease over a directory and
 * a lease over a file inside it are the same collision seen from two sides.
 */
export function leasePathsConflict(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

export const leaseStateSchema = z.enum(['held', 'released', 'expired']);
export type LeaseState = z.infer<typeof leaseStateSchema>;

const workLeaseObjectSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  /** The holder. A lease belongs to a session, so it dies when the session does. */
  sessionId: identifierSchema,
  /** Denormalized for display; a lease list must not require a session join to be readable. */
  agentId: identifierSchema,
  path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  matchPath: z.string().max(MAX_PATH_LENGTH + 1),
  reason: z.string().trim().min(1).max(500),
  state: leaseStateSchema,
  acquiredAt: timestampSchema,
  expiresAt: timestampSchema,
  renewedAt: timestampSchema.optional(),
  releasedAt: timestampSchema.optional(),
});

export const workLeaseSchema = workLeaseObjectSchema.superRefine((value, context) => {
  // Redis data is untrusted on read (section 7). A match form that does not
  // correspond to its path would silently mis-scope every conflict check.
  let expected: string;
  try {
    expected = normalizeLeasePath(value.path).matchPath;
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Lease path is not a valid project-relative path.',
      path: ['path'],
    });
    return;
  }
  if (expected !== value.matchPath) {
    context.addIssue({
      code: 'custom',
      message: 'Lease match form does not correspond to its path.',
      path: ['matchPath'],
    });
  }
  if (value.state === 'released' && value.releasedAt === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'A released lease must record when it was released.',
      path: ['releasedAt'],
    });
  }
});

export type WorkLease = z.infer<typeof workLeaseObjectSchema>;

export const leaseAcquireRequestSchema = z.strictObject({
  projectId: identifierSchema,
  sessionId: identifierSchema,
  path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  /**
   * Required. Whoever a lease blocks has to be able to judge it, and an
   * unexplained hold is indistinguishable from a stuck one.
   */
  reason: z.string().trim().min(1).max(500),
  durationMs: z.coerce
    .number()
    .int()
    .min(LEASE_MIN_DURATION_MS)
    .max(LEASE_MAX_DURATION_MS)
    .default(LEASE_DEFAULT_DURATION_MS),
});

export const leaseRenewRequestSchema = z.strictObject({
  sessionId: identifierSchema,
  durationMs: z.coerce
    .number()
    .int()
    .min(LEASE_MIN_DURATION_MS)
    .max(LEASE_MAX_DURATION_MS)
    .default(LEASE_DEFAULT_DURATION_MS),
});

export const leaseReleaseRequestSchema = z.strictObject({
  sessionId: identifierSchema,
});

/** What the holder of a conflicting lease is, told to the caller that was refused. */
export const leaseConflictSchema = z.strictObject({
  leaseId: identifierSchema,
  sessionId: identifierSchema,
  agentId: identifierSchema,
  path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
  reason: z.string().trim().min(1).max(500),
  expiresAt: timestampSchema,
});

export type LeaseConflict = z.infer<typeof leaseConflictSchema>;

export const leaseAcquireResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('granted'), lease: workLeaseSchema }),
  z.strictObject({ status: z.literal('denied'), conflict: leaseConflictSchema }),
]);

export type LeaseAcquireResponse = z.infer<typeof leaseAcquireResponseSchema>;

export const leaseCollectionSchema = z.strictObject({
  leases: z.array(workLeaseSchema).max(LEASE_MAX_ACTIVE_PER_PROJECT * 10),
  truncated: z.boolean().default(false),
});

export const leaseListQuerySchema = z.strictObject({
  projectId: identifierSchema.optional(),
  sessionId: identifierSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(LEASE_MAX_ACTIVE_PER_PROJECT),
});

export type LeaseCollection = z.infer<typeof leaseCollectionSchema>;
