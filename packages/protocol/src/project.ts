import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(128);

/**
 * A git remote, not merely a URL.
 *
 * The register path fills this from `git config remote.origin.url`, and the
 * most common SSH remote is scp-style — `git@host:owner/repo.git` — which is
 * not an RFC URL and fails `z.url()`. That mismatch once poisoned a
 * projection: Lua wrote a record the TypeScript read path refused, and one
 * refused record turned the whole project list into a 500 (ADR 0015 makes
 * internal validation failures server errors on purpose). The rule that
 * matters is write-what-you-can-read: this schema is the single definition
 * both the request and the projection use.
 */
const scpStyleRemotePattern = /^[\w.-]+@[\w.-]+:[^\s]+$/u;
export const repositoryRemoteSchema = z.union([
  z.url().max(2048),
  z.string().trim().max(2048).regex(scpStyleRemotePattern),
]);
const pathSchema = z.string().trim().min(1).max(4096);
const timestampSchema = z.iso.datetime({ offset: false });

export const projectRegistrationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  localPath: pathSchema,
  repositoryUrl: repositoryRemoteSchema.optional(),
  defaultBranch: z.string().trim().min(1).max(512).optional(),
});

/**
 * The fields a registered project may change. The local path is the project's
 * identity (canonical, duplicate-checked at registration) and is not one of
 * them. `null` clears an optional field; an absent key leaves it alone.
 */
export const projectUpdateRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    repositoryUrl: repositoryRemoteSchema.nullable().optional(),
    defaultBranch: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one field must be provided.',
  });

export const projectSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  localPath: pathSchema,
  canonicalPath: pathSchema,
  repositoryUrl: repositoryRemoteSchema.optional(),
  defaultBranch: z.string().trim().min(1).max(512).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const projectResponseSchema = projectSchema;
export const projectCollectionResponseSchema = z.strictObject({
  projects: z.array(projectSchema),
});

/**
 * One directory found directly under a discovery root — the CLI's
 * `project discover`, the dashboard's "Scan a folder". A plain candidate has
 * neither field; one already registered names its `existingProjectId`; one
 * that cannot be registered says why in `reason`.
 */
export const projectDiscoveryCandidateSchema = z.strictObject({
  directoryName: z.string().min(1).max(255),
  displayName: z.string().trim().min(1).max(200),
  localPath: pathSchema,
  canonicalPath: pathSchema,
  existingProjectId: identifierSchema.optional(),
  reason: z.enum(['excluded', 'unreadable', 'outside_root']).optional(),
});

/** `truncated` discloses a root with more directories than the response carries. */
export const projectDiscoveryResponseSchema = z.strictObject({
  root: pathSchema,
  candidates: z.array(projectDiscoveryCandidateSchema),
  truncated: z.boolean(),
});

export type ProjectRegistrationRequest = z.infer<typeof projectRegistrationRequestSchema>;
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectCollectionResponse = z.infer<typeof projectCollectionResponseSchema>;
export type ProjectDiscoveryCandidate = z.infer<typeof projectDiscoveryCandidateSchema>;
export type ProjectDiscoveryResponse = z.infer<typeof projectDiscoveryResponseSchema>;
