import { randomUUID } from 'node:crypto';

import { createRuntimeEvent } from '@luwi/protocol';
import type { AgentMessage, Project, SessionView, WorkLease } from '@luwi/protocol';
import { RedisRepositoryError, type RuntimeRepository } from '@luwi/redis';
import { ApplicationError } from '@luwi/runtime';

import type { CanonicalStore } from './canonical-store.js';

/**
 * Project unregister (F3): the registry forgets a project and the evidence
 * LUWI collected about it. Nothing on disk is touched.
 *
 * Refuses while anything live points at the project — a session that is not
 * terminal, a held lease, a live coordinator, a message still in flight —
 * naming what blocks it. There is no force: the reader ends or releases what
 * is live first.
 *
 * Order is chosen for a crash at any point: the canonical manifest is untracked
 * first (a restart re-registers whatever the manifest still lists, under a new
 * id, and the next reconcile's second loop re-tracks any project the runtime
 * still holds — so the safe failure is "still registered"); the leaves are then
 * purged in re-runnable batches; and one atomic Function ends it, refusing if a
 * session registered in between.
 */
export type ProjectUnregisterService = {
  remove(projectId: string): Promise<void>;
};

export type ProjectUnregisterDependencies = {
  repository: Pick<RuntimeRepository, 'getProject' | 'listSessions' | 'unregisterProject'>;
  leases: { listProjectLeases(projectId: string, limit: number): Promise<WorkLease[]> };
  messages: {
    listMessages(query: { projectId: string; limit: number }): Promise<AgentMessage[]>;
  };
  coordinator: { getCoordinator(projectId: string): Promise<{ sessionId: string } | null> };
  purge: { purgeProjectLeaves(projectId: string): Promise<Record<string, number>> };
  canonicalStore: Pick<CanonicalStore, 'untrackProject' | 'trackProject'>;
  /**
   * Resolves once no background writer keyed by this project (a git or
   * package scan a session close just triggered) is still running, so it
   * cannot write evidence after the project is gone. Absent means none.
   */
  awaitQuiescence?: (projectId: string) => Promise<void>;
  workspaceId: string;
  createId?: () => string;
  onUnregistered?: (project: Project) => void;
};

/** The same vocabulary as `messageTerminalStateSchema`; a message in any other state is in flight. */
const TERMINAL_MESSAGE_STATES = new Set(['responded', 'rejected', 'timed_out', 'failed']);
const BLOCKER_LIMIT = 20;
const LIST_LIMIT = 1000;
const RACE_ATTEMPTS = 3;

const isTerminalSession = (session: SessionView): boolean =>
  session.status === 'completed' || session.status === 'disconnected';

export function createProjectUnregisterService(
  dependencies: ProjectUnregisterDependencies,
): ProjectUnregisterService {
  const createId = dependencies.createId ?? randomUUID;

  // Public error details carry scalars only, so the blocking ids travel as one
  // comma-separated string, bounded to the first BLOCKER_LIMIT.
  const named = (ids: readonly string[]): string => ids.slice(0, BLOCKER_LIMIT).join(', ');
  const refuse = (
    code: string,
    message: string,
    details: Record<string, string | number | boolean | null>,
  ): never => {
    throw new ApplicationError(code, message, 409, details);
  };

  const assertNoBlockers = async (projectId: string, sessions: SessionView[]): Promise<void> => {
    const active = sessions.filter((session) => !isTerminalSession(session));
    if (active.length > 0) {
      refuse(
        'PROJECT_HAS_ACTIVE_SESSIONS',
        'The project still has sessions that are not terminal.',
        { count: active.length, sessions: named(active.map(({ id }) => id)) },
      );
    }
    const held = (await dependencies.leases.listProjectLeases(projectId, LIST_LIMIT)).filter(
      (lease) => lease.state === 'held',
    );
    if (held.length > 0) {
      refuse('PROJECT_HAS_HELD_LEASES', 'The project still has held work leases.', {
        count: held.length,
        leases: named(held.map(({ id }) => id)),
      });
    }
    const coordinator = await dependencies.coordinator.getCoordinator(projectId);
    if (coordinator !== null) {
      const holder = sessions.find((session) => session.id === coordinator.sessionId);
      // A terminal holder is not live: the daemon lets the next claim take the
      // role over, and the unregister drops the record with the project.
      if (holder !== undefined && !isTerminalSession(holder)) {
        refuse('PROJECT_COORDINATOR_HELD', 'The project still has a live coordinator.', {
          coordinator: coordinator.sessionId,
        });
      }
    }
    const inFlight = (
      await dependencies.messages.listMessages({ projectId, limit: LIST_LIMIT })
    ).filter((message) => !TERMINAL_MESSAGE_STATES.has(message.state));
    if (inFlight.length > 0) {
      refuse('PROJECT_HAS_INFLIGHT_MESSAGES', 'The project still has messages in flight.', {
        count: inFlight.length,
        messages: named(inFlight.map(({ correlationId }) => correlationId)),
      });
    }
  };

  return {
    async remove(projectId) {
      const project = await dependencies.repository.getProject(projectId);
      if (project === null) {
        throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
      }
      await assertNoBlockers(projectId, await dependencies.repository.listSessions(projectId));
      await dependencies.awaitQuiescence?.(projectId);

      await dependencies.canonicalStore.untrackProject(projectId);

      try {
        for (let attempt = 1; ; attempt += 1) {
          await dependencies.purge.purgeProjectLeaves(projectId);
          const result = await dependencies.repository.unregisterProject({
            projectId,
            event: createRuntimeEvent({
              type: 'project.unregistered',
              workspaceId: dependencies.workspaceId,
              projectId,
              payload: {
                project: {
                  id: project.id,
                  name: project.name,
                  canonicalPath: project.canonicalPath,
                },
              },
              ...(dependencies.createId === undefined ? {} : { id: createId() }),
            }),
          });
          if (result.status === 'unregistered') break;
          if (result.status === 'not_found') {
            throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
          }
          // A session registered between the read and the Function: read again,
          // refuse if it is live, purge it if it already ended, and try once more.
          if (attempt >= RACE_ATTEMPTS) {
            refuse(
              'PROJECT_UNREGISTER_RACED',
              'Sessions kept registering while the project was being unregistered.',
              { sessions: result.sessions },
            );
          }
          await assertNoBlockers(projectId, await dependencies.repository.listSessions(projectId));
        }
      } catch (error) {
        // The project is still registered, so the manifest must list it again —
        // otherwise it stays inconsistent until the next start's reconcile.
        // A purge refusal (a blocker that appeared between the read and the
        // purge, or one past the read limit) is the same 409 as the pre-check.
        await dependencies.canonicalStore.trackProject(project);
        if (error instanceof RedisRepositoryError && error.code.startsWith('PROJECT_HAS_')) {
          throw new ApplicationError(error.code, error.message, 409);
        }
        throw error;
      }
      dependencies.onUnregistered?.(project);
    },
  };
}
