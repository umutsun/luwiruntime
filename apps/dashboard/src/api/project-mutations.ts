import {
  projectRegistrationRequestSchema,
  projectResponseSchema,
  projectUpdateRequestSchema,
  publicErrorResponseSchema,
} from '@luwi/protocol/browser';
import type { z } from 'zod';

/**
 * The dashboard's third and last write surface (ADR 0033): registering a
 * project and editing its name, remote and default branch. Both go to the
 * daemon's own endpoints with the same bounded, validated shape the CLI sends;
 * the local path is identity and is never edited from here.
 *
 * Kept in its own module for the same reason the other two are:
 * `product-independence.test.ts` allowlists exactly the modules that may
 * issue a non-GET request, so a write anywhere else is a test failure.
 */
export type ProjectRegisterInput = {
  name: string;
  localPath: string;
  repositoryUrl?: string;
  defaultBranch?: string;
};

/** `null` clears an optional field; an absent key leaves it alone. */
export type ProjectUpdateInput = {
  name?: string;
  repositoryUrl?: string | null;
  defaultBranch?: string | null;
};

export type ProjectRecord = z.infer<typeof projectResponseSchema>;

export type ProjectMutationResult =
  | { state: 'ok'; data: ProjectRecord; httpStatus: number }
  | {
      state: 'failed';
      reason: 'input' | 'http';
      code: string;
      message: string;
      httpStatus?: number;
    }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number };

const inputFailure: ProjectMutationResult = {
  state: 'failed',
  reason: 'input',
  code: 'REQUEST_VALIDATION_FAILED',
  message: 'The project fields do not match the bounded project protocol.',
};

export function createProjectMutations(fetchImpl: typeof fetch = fetch) {
  const send = async (
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
  ): Promise<ProjectMutationResult> => {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return { state: 'failed', reason: 'transport' };
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return { state: 'failed', reason: 'invalid', httpStatus: response.status };
    }
    if (!response.ok) {
      const error = publicErrorResponseSchema.safeParse(value);
      return error.success
        ? {
            state: 'failed',
            reason: 'http',
            httpStatus: response.status,
            code: error.data.error.code,
            message: error.data.error.message,
          }
        : { state: 'failed', reason: 'invalid', httpStatus: response.status };
    }

    let parsed: ReturnType<typeof projectResponseSchema.safeParse>;
    try {
      parsed = projectResponseSchema.safeParse(value);
    } catch {
      return { state: 'failed', reason: 'invalid', httpStatus: response.status };
    }
    return parsed.success
      ? { state: 'ok', httpStatus: response.status, data: parsed.data }
      : { state: 'failed', reason: 'invalid', httpStatus: response.status };
  };

  return {
    async register(input: ProjectRegisterInput): Promise<ProjectMutationResult> {
      const request = projectRegistrationRequestSchema.safeParse({
        name: input.name,
        localPath: input.localPath,
        ...(input.repositoryUrl === undefined ? {} : { repositoryUrl: input.repositoryUrl }),
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
      });
      if (!request.success) return inputFailure;
      return send('/api/v1/projects', 'POST', request.data);
    },

    async update(projectId: string, input: ProjectUpdateInput): Promise<ProjectMutationResult> {
      const request = projectUpdateRequestSchema.safeParse({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.repositoryUrl === undefined ? {} : { repositoryUrl: input.repositoryUrl }),
        ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
      });
      if (!request.success || projectId.trim() === '') return inputFailure;
      return send(`/api/v1/projects/${encodeURIComponent(projectId)}`, 'PATCH', request.data);
    },
  };
}

export type ProjectMutations = ReturnType<typeof createProjectMutations>;
