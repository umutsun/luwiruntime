import { sourceEventIdentity } from './intelligence-repository.js';
import { isSafeKeyPart, type RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

/**
 * The leaves of a project unregister (F3): every per-project index family and
 * the records it enumerates, and those records' memberships in the global and
 * agent/session-side indexes. One module rather than a method on each
 * repository, because every key it names is already defined in `redis-keys.ts`
 * and the shape is the same for all of them — enumerate, remove the mirrors,
 * delete the record, delete the index.
 *
 * Plain commands, no Function and no event: a crash part-way leaves a project
 * that is still registered with some evidence gone, and running the purge again
 * finishes it. Only the end of the unregister is atomic (`unregisterProject`).
 *
 * It refuses, as the service refused before it, a session that is not terminal,
 * a held lease, or a message in flight — a race between the two reads must not
 * take a live thing down with the project.
 *
 * Left alone on purpose: native bindings and links (no `projectId`; retention
 * bounds them), the graph generation (rebuilt whole from the registry), config
 * plans/operations/drifts, and the aggregate usage-metric counters.
 */
export type ProjectPurgeSummary = Record<string, number>;

export interface ProjectPurge {
  purgeProjectLeaves(projectId: string): Promise<ProjectPurgeSummary>;
}

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'disconnected']);
const TERMINAL_MESSAGE_STATES = new Set(['responded', 'rejected', 'timed_out', 'failed']);

function strings(reply: unknown): string[] {
  return Array.isArray(reply)
    ? reply.filter((value): value is string => typeof value === 'string')
    : [];
}

function storedJson(reply: unknown): Record<string, unknown> | null {
  if (typeof reply !== 'string') return null;
  try {
    const value: unknown = JSON.parse(reply);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A stored identifier, only when it could have named a key: every key the
 * runtime writes goes through `keyPart`, so a value that fails its pattern is
 * index corruption, and building a key from it would throw and leave the
 * unregister stuck on that member forever. The caller skips or drops it.
 */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && isSafeKeyPart(value) ? value : undefined;

/** A message hash is written field by field (`message_request`), not as one `json` field. */
type StoredMessage = {
  state?: string;
  correlationId?: string;
  sourceSessionId?: string;
  targetSessionId?: string;
  idempotencyKeyHash?: string;
};

export function createProjectPurge(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
}): ProjectPurge {
  const { client, keys } = options;
  const send = (command: string[]): Promise<unknown> => client.sendCommand(command);
  /**
   * Index members, with any that could never have named a key dropped from the
   * index and counted, so a corrupt member cannot wedge the unregister.
   */
  const unsafe: string[] = [];
  const membersOf = async (key: string, reply: unknown): Promise<string[]> => {
    const safe: string[] = [];
    for (const member of strings(reply)) {
      if (isSafeKeyPart(member)) safe.push(member);
      else {
        unsafe.push(`${key}:${member}`);
        await send(['SREM', key, member]);
      }
    }
    return safe;
  };
  const members = async (key: string): Promise<string[]> =>
    membersOf(key, await send(['SMEMBERS', key]));
  const ranked = async (key: string): Promise<string[]> => {
    const safe: string[] = [];
    for (const member of strings(await send(['ZRANGE', key, '0', '-1']))) {
      if (isSafeKeyPart(member)) safe.push(member);
      else {
        unsafe.push(`${key}:${member}`);
        await send(['ZREM', key, member]);
      }
    }
    return safe;
  };
  const messageFields = async (messageId: string): Promise<StoredMessage> => {
    const reply = await send([
      'HMGET',
      keys.message(messageId),
      'state',
      'correlationId',
      'sourceSessionId',
      'targetSessionId',
      'idempotencyKeyHash',
    ]);
    const [state, correlationId, sourceSessionId, targetSessionId, idempotencyKeyHash] =
      Array.isArray(reply) ? (reply as unknown[]) : [];
    const correlation = text(correlationId);
    const source = text(sourceSessionId);
    const target = text(targetSessionId);
    const idempotency = text(idempotencyKeyHash);
    return {
      ...(typeof state === 'string' ? { state } : {}),
      ...(correlation === undefined ? {} : { correlationId: correlation }),
      ...(source === undefined ? {} : { sourceSessionId: source }),
      ...(target === undefined ? {} : { targetSessionId: target }),
      ...(idempotency === undefined ? {} : { idempotencyKeyHash: idempotency }),
    };
  };
  const json = async (key: string): Promise<Record<string, unknown> | null> =>
    storedJson(await send(['HGET', key, 'json']));
  const del = async (...targets: string[]): Promise<void> => {
    for (let index = 0; index < targets.length; index += 100) {
      await send(['DEL', ...targets.slice(index, index + 100)]);
    }
  };
  const srem = (key: string, member: string): Promise<unknown> => send(['SREM', key, member]);
  const zrem = (key: string, member: string): Promise<unknown> => send(['ZREM', key, member]);

  return {
    async purgeProjectLeaves(projectId) {
      const summary: ProjectPurgeSummary = {};
      const count = (name: string): void => {
        summary[name] = (summary[name] ?? 0) + 1;
      };

      // Two phases per family: every blocker is read before anything is
      // written, so a refusal here leaves the project exactly as it was found.
      const sessions: Array<{ sessionId: string; agentId: string | undefined }> = [];
      for (const sessionId of await members(keys.projectSessions(projectId))) {
        const reply = await send(['HMGET', keys.session(sessionId), 'status', 'agentId']);
        const [status, agentId] = Array.isArray(reply) ? (reply as unknown[]) : [];
        if (typeof status === 'string' && !TERMINAL_SESSION_STATUSES.has(status)) {
          throw new RedisRepositoryError(
            'PROJECT_HAS_ACTIVE_SESSIONS',
            'A session that is not terminal cannot be purged.',
          );
        }
        sessions.push({ sessionId, agentId: text(agentId) });
      }
      const messages: Array<{ messageId: string; stored: StoredMessage }> = [];
      for (const messageId of await ranked(keys.projectMessages(projectId))) {
        const stored = await messageFields(messageId);
        if (stored.state !== undefined && !TERMINAL_MESSAGE_STATES.has(stored.state)) {
          throw new RedisRepositoryError(
            'PROJECT_HAS_INFLIGHT_MESSAGES',
            'A message in flight cannot be purged with its project.',
          );
        }
        messages.push({ messageId, stored });
      }
      // The held-lease index. Released and expired records were never indexed
      // by project and are reachable only by id; they stay as they are.
      if (Number(await send(['HLEN', keys.projectLeases(projectId)])) > 0) {
        throw new RedisRepositoryError(
          'PROJECT_HAS_HELD_LEASES',
          'A held work lease cannot be purged with its project.',
        );
      }

      for (const { sessionId, agentId } of sessions) {
        await del(
          keys.session(sessionId),
          keys.sessionPresence(sessionId),
          keys.sessionLeases(sessionId),
          keys.sessionNativeBinding(sessionId),
          keys.sourceSessionMessages(sessionId),
          keys.targetSessionMessages(sessionId),
          keys.sessionUsage(sessionId),
          keys.sessionCommits(sessionId),
          keys.sessionContextContributions(sessionId),
        );
        // The inbox stream carries its consumer group with it.
        await send(['UNLINK', keys.sessionInbox(sessionId)]);
        await zrem(keys.heartbeatDeadlines, sessionId);
        if (agentId !== undefined) await srem(keys.agentSessions(agentId), sessionId);
        await srem(keys.projectSessions(projectId), sessionId);
        count('sessions');
      }
      await del(keys.projectLeases(projectId));

      for (const { messageId, stored } of messages) {
        const { correlationId, sourceSessionId: source, targetSessionId: target } = stored;
        // The idempotency index is keyed by the caller's hash, else by the id
        // (`createMessage`); the lookup mirrors that choice.
        const idempotency = stored.idempotencyKeyHash ?? messageId;
        if (correlationId !== undefined) await del(keys.messageCorrelation(correlationId));
        if (source !== undefined) {
          await del(keys.messageIdempotency(source, idempotency));
          await zrem(keys.sourceSessionMessages(source), messageId);
        }
        if (target !== undefined) await zrem(keys.targetSessionMessages(target), messageId);
        await zrem(keys.messagesIndex, messageId);
        await zrem(keys.terminalMessages, messageId);
        await zrem(keys.messageDeadlines, messageId);
        await del(keys.message(messageId));
        count('messages');
      }
      await del(keys.projectMessages(projectId));

      // Usage metric counters are kept per scope and source. The project- and
      // session-scoped hashes (all-time and per day) describe only this project,
      // so they go with it; the agent- and workspace-scoped ones aggregate other
      // projects too and cannot be decremented from what is known here, so they
      // stay. Each record names the source and the day its counters landed in.
      const metricKeys = new Set<string>();
      for (const usageId of await members(keys.projectUsage(projectId))) {
        const stored = await json(keys.usage(usageId));
        const agentId = text(stored?.['agentId']);
        const sessionId = text(stored?.['sessionId']);
        const source = text(stored?.['source']);
        const day = text(stored?.['observedAt'])?.slice(0, 10);
        const sourceEventId = text(stored?.['sourceEventId']) ?? usageId;
        if (source !== undefined) {
          metricKeys.add(keys.usageMetric(`project:${projectId}`, source));
          if (day !== undefined) {
            metricKeys.add(keys.usageMetric(`day:${day}:project:${projectId}`, source));
          }
          if (sessionId !== undefined) {
            metricKeys.add(keys.usageMetric(`session:${sessionId}`, source));
            if (day !== undefined) {
              metricKeys.add(keys.usageMetric(`day:${day}:session:${sessionId}`, source));
            }
          }
        }
        await srem(keys.usageIndex, usageId);
        if (agentId !== undefined) await srem(keys.agentUsage(agentId), usageId);
        if (sessionId !== undefined) await srem(keys.sessionUsage(sessionId), usageId);
        await del(keys.usageSourceEvent(sourceEventIdentity(sourceEventId)), keys.usage(usageId));
        count('usage');
      }
      if (metricKeys.size > 0) await del(...metricKeys);
      await del(keys.projectUsage(projectId));

      for (const observationId of await members(keys.projectGitObservations(projectId))) {
        await srem(keys.gitObservationsIndex, observationId);
        await del(keys.gitObservation(observationId));
        count('gitObservations');
      }
      for (const sha of await members(keys.projectCommits(projectId))) {
        await del(keys.gitCommit(projectId, sha));
        count('commits');
      }
      await del(
        keys.projectGitObservations(projectId),
        keys.projectGitCurrent(projectId),
        keys.projectCommits(projectId),
      );

      for (const id of await members(keys.projectAttributions(projectId))) {
        await srem(keys.attributionsIndex, id);
        await del(keys.attribution(id));
        count('attributions');
      }
      await del(keys.projectAttributions(projectId));

      for (const id of await members(keys.projectSessionFileChanges(projectId))) {
        await del(keys.sessionFileChange(id));
        count('fileChanges');
      }
      await del(keys.projectSessionFileChanges(projectId));

      for (const member of await members(keys.projectPackages(projectId))) {
        const separator = member.indexOf(':');
        if (separator <= 0) continue;
        await del(keys.package(projectId, member.slice(0, separator), member.slice(separator + 1)));
        count('packages');
      }
      for (const id of await members(keys.projectTechnologies(projectId))) {
        await del(keys.technology(projectId, id));
        count('technologies');
      }
      await del(
        keys.projectPackages(projectId),
        keys.projectTechnologies(projectId),
        keys.projectWorkspaceLocations(projectId),
      );

      for (const id of await members(keys.projectContextContributions(projectId))) {
        const stored = await json(keys.contextContribution(id));
        const agentId = text(stored?.['agentId']);
        const sessionId = text(stored?.['sessionId']);
        await srem(keys.contextContributionsIndex, id);
        if (agentId !== undefined) await srem(keys.agentContextContributions(agentId), id);
        if (sessionId !== undefined) await srem(keys.sessionContextContributions(sessionId), id);
        await del(keys.contextContribution(id));
        count('contextContributions');
      }
      await del(keys.projectContextContributions(projectId));

      for (const id of await members(keys.projectOptimizationFindings(projectId))) {
        await srem(keys.optimizationFindingsIndex, id);
        await del(keys.optimizationFinding(id));
        count('findings');
      }
      for (const id of await members(keys.projectOptimizationProposals(projectId))) {
        await srem(keys.optimizationProposalsIndex, id);
        await del(keys.optimizationProposal(id));
        count('proposals');
      }
      await del(
        keys.projectOptimizationFindings(projectId),
        keys.projectOptimizationProposals(projectId),
      );

      for (const id of await members(keys.projectAgentBindings(projectId))) {
        const agentId = text((await json(keys.projectAgentBinding(id)))?.['agentId']);
        if (agentId !== undefined) await srem(keys.agentProjectBindings(agentId), id);
        await del(keys.projectAgentBinding(id));
        count('agentBindings');
      }
      await del(keys.projectAgentBindings(projectId));

      for (const id of await members(keys.projectCapabilities(projectId))) {
        const kind = text((await json(keys.capability(id)))?.['kind']);
        await srem(keys.capabilitiesIndex, id);
        if (kind !== undefined) await srem(keys.capabilitiesByKind(kind), id);
        await del(keys.capability(id));
        count('capabilities');
      }
      await del(keys.projectCapabilities(projectId));

      for (const id of await members(keys.projectCapabilityBindings(projectId))) {
        const agentId = text((await json(keys.capabilityBinding(id)))?.['agentId']);
        await srem(keys.capabilityBindingsIndex, id);
        if (agentId !== undefined) await srem(keys.agentCapabilities(agentId), id);
        await del(keys.capabilityBinding(id));
        count('capabilityBindings');
      }
      await del(keys.projectCapabilityBindings(projectId));

      for (const id of await members(keys.projectContextSources(projectId))) {
        const agentId = text((await json(keys.contextSource(id)))?.['agentId']);
        await srem(keys.contextSourcesIndex, id);
        if (agentId !== undefined) await srem(keys.agentContextSources(agentId), id);
        await del(keys.contextSource(id));
        count('contextSources');
      }
      await del(keys.projectContextSources(projectId));

      // Profiles carry an optional projectId but have no per-project index.
      for (const id of await members(keys.profilesIndex)) {
        if (text((await json(keys.profile(id)))?.['projectId']) !== projectId) continue;
        await srem(keys.profilesIndex, id);
        await del(keys.profile(id));
        count('profiles');
      }

      // Footprints are indexed as `<projectId>:<agentId>`.
      const footprintPrefix = `${projectId}:`;
      for (const member of await members(keys.contextFootprintsIndex)) {
        if (!member.startsWith(footprintPrefix)) continue;
        await srem(keys.contextFootprintsIndex, member);
        await del(keys.contextFootprint(projectId, member.slice(footprintPrefix.length)));
        count('contextFootprints');
      }

      if (unsafe.length > 0) summary['unsafeMembersDropped'] = unsafe.length;
      return summary;
    },
  };
}
