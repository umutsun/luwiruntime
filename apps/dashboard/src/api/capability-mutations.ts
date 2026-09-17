import {
  capabilityBindingSchema,
  capabilityPackageSchema,
  capabilityScanResponseSchema,
  publicErrorResponseSchema,
} from '@luwi/protocol/browser';
import type { z } from 'zod';

/**
 * The dashboard's fifth write surface (ADR 0036): skill management through the
 * daemon's **existing** capability endpoints — enable or disable a package,
 * assign it to a project or to one bound agent, unassign it, and re-observe the
 * native skill directories. Nothing here creates a package or writes a file:
 * the daemon refuses to update an observed package (its `SKILL.md` is the
 * truth) and LUWI never authors one.
 *
 * Kept in its own module for the same reason the other four are:
 * `product-independence.test.ts` allowlists exactly the modules that may issue a
 * non-GET request, so a write anywhere else is a test failure.
 */
export type CapabilityRecord = z.infer<typeof capabilityPackageSchema>;
export type CapabilityAssignment = z.infer<typeof capabilityBindingSchema>;
export type CapabilityScan = z.infer<typeof capabilityScanResponseSchema>;

/** A project-scoped target; with `agentId` the assignment is one agent's. */
export type CapabilityTarget = { projectId: string; agentId?: string };

export type CapabilityMutationResult<T> =
  | { state: 'ok'; data: T; httpStatus: number }
  | { state: 'failed'; reason: 'http'; code: string; message: string; httpStatus: number }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number };

type Parser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };

const blank = (value: string | undefined): boolean => value !== undefined && value.trim() === '';

const inputFailure = (message: string): CapabilityMutationResult<never> => ({
  state: 'failed',
  reason: 'http',
  httpStatus: 400,
  code: 'REQUEST_VALIDATION_FAILED',
  message,
});

export function createCapabilityMutations(fetchImpl: typeof fetch = fetch) {
  const capabilityPath = (capabilityId: string, suffix = ''): string =>
    `/api/v1/capabilities/${encodeURIComponent(capabilityId)}${suffix}`;

  const send = async <T>(
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
    schema: Parser<T>,
  ): Promise<CapabilityMutationResult<T>> => {
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
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { state: 'ok', httpStatus: response.status, data: parsed.data }
      : { state: 'failed', reason: 'invalid', httpStatus: response.status };
  };

  const assignment = (target: CapabilityTarget) => ({
    scope: 'project' as const,
    projectId: target.projectId,
    ...(target.agentId === undefined ? {} : { agentId: target.agentId }),
    enabled: true,
    settings: {},
  });

  return {
    async setEnabled(
      capabilityId: string,
      enabled: boolean,
    ): Promise<CapabilityMutationResult<CapabilityRecord>> {
      if (blank(capabilityId)) return inputFailure('A capability id is required.');
      return send(capabilityPath(capabilityId), 'PATCH', { enabled }, capabilityPackageSchema);
    },

    async assign(
      capabilityId: string,
      target: CapabilityTarget,
    ): Promise<CapabilityMutationResult<CapabilityAssignment>> {
      if (blank(capabilityId) || blank(target.projectId) || blank(target.agentId)) {
        return inputFailure('A capability assignment needs a capability and a project.');
      }
      return send(
        capabilityPath(capabilityId, '/assign'),
        'POST',
        assignment(target),
        capabilityBindingSchema,
      );
    },

    async unassign(
      capabilityId: string,
      target: CapabilityTarget,
    ): Promise<CapabilityMutationResult<CapabilityAssignment>> {
      if (blank(capabilityId) || blank(target.projectId) || blank(target.agentId)) {
        return inputFailure('A capability assignment needs a capability and a project.');
      }
      return send(
        capabilityPath(capabilityId, '/unassign'),
        'POST',
        assignment(target),
        capabilityBindingSchema,
      );
    },

    /** Re-observes the native skill directories; answers with the diagnostics. */
    async rescan(): Promise<CapabilityMutationResult<CapabilityScan>> {
      return send('/api/v1/capabilities/scan', 'POST', {}, capabilityScanResponseSchema);
    },
  };
}

export type CapabilityMutations = ReturnType<typeof createCapabilityMutations>;
