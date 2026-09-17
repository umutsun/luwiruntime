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

/**
 * The outcome of an unregister (F3). `204` carries no record; a `409` carries
 * the daemon's reason and its scalar `details` (which sessions, leases or
 * messages still block it), shown to the reader as they are.
 */
export type ProjectRemoveResult =
  | { state: 'ok'; httpStatus: 204 }
  | {
      state: 'failed';
      reason: 'input' | 'http';
      code: string;
      message: string;
      httpStatus?: number;
      details?: Record<string, unknown>;
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

    /**
     * Unregister (F3): the registry forgets the project and the evidence LUWI
     * collected about it; nothing on disk changes. The daemon answers `204`, or
     * a named `409` while anything live still points at the project.
     */
    async remove(projectId: string): Promise<ProjectRemoveResult> {
      if (projectId.trim() === '') {
        return {
          state: 'failed',
          reason: 'input',
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'A project id is required.',
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
          method: 'DELETE',
          headers: { accept: 'application/json' },
        });
      } catch {
        return { state: 'failed', reason: 'transport' };
      }
      if (response.status === 204) return { state: 'ok', httpStatus: 204 };
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return { state: 'failed', reason: 'invalid', httpStatus: response.status };
      }
      const error = publicErrorResponseSchema.safeParse(value);
      return error.success
        ? {
            state: 'failed',
            reason: 'http',
            httpStatus: response.status,
            code: error.data.error.code,
            message: error.data.error.message,
            ...(error.data.error.details === undefined
              ? {}
              : { details: error.data.error.details }),
          }
        : { state: 'failed', reason: 'invalid', httpStatus: response.status };
    },
  };
}

export type ProjectMutations = ReturnType<typeof createProjectMutations>;
