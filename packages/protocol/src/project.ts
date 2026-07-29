import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(128);
const pathSchema = z.string().trim().min(1).max(4096);
const timestampSchema = z.iso.datetime({ offset: false });

export const projectRegistrationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  localPath: pathSchema,
  repositoryUrl: z.url().max(2048).optional(),
  defaultBranch: z.string().trim().min(1).max(512).optional(),
});

export const projectSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  localPath: pathSchema,
  canonicalPath: pathSchema,
  repositoryUrl: z.url().max(2048).optional(),
  defaultBranch: z.string().trim().min(1).max(512).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const projectResponseSchema = projectSchema;
export const projectCollectionResponseSchema = z.strictObject({
  projects: z.array(projectSchema),
});

export type ProjectRegistrationRequest = z.infer<typeof projectRegistrationRequestSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectCollectionResponse = z.infer<typeof projectCollectionResponseSchema>;
