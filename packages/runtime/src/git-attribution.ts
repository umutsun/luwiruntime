import { createHash } from 'node:crypto';

import {
  attributionRecordSchema,
  type AgentSession,
  type AttributionRecord,
  type GitObservation,
} from '@luwi/protocol';

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TRAILING_WINDOW_MS = 15 * 60 * 1000;

function identity(parts: readonly string[]): string {
  return `attr-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

function pathIdentity(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function withinRepository(session: AgentSession, repositoryRoot: string): boolean {
  const root = pathIdentity(repositoryRoot);
  for (const candidate of [session.workingDirectory, session.worktreePath]) {
    if (candidate === undefined) continue;
    const normalized = pathIdentity(candidate);
    if (normalized === root || normalized.startsWith(`${root}/`)) return true;
  }
  return false;
}

function matchesCorrelation(
  session: AgentSession,
  observation: GitObservation,
  committedAt: string,
  clockSkewMs: number,
  trailingWindowMs: number,
): boolean {
  if (session.projectId !== observation.projectId) return false;
  if (
    session.branch !== undefined &&
    observation.branch !== undefined &&
    session.branch !== observation.branch
  ) {
    return false;
  }
  if (!withinRepository(session, observation.repositoryRoot)) return false;
  const commitTime = Date.parse(committedAt);
  return (
    commitTime >= Date.parse(session.startedAt) - clockSkewMs &&
    commitTime <= Date.parse(session.lastHeartbeatAt) + trailingWindowMs
  );
}

export type GitAttributionOptions = {
  clockSkewMs?: number;
  trailingWindowMs?: number;
};

export function attributeGitObservation(
  observation: GitObservation,
  sessions: AgentSession[],
  options: GitAttributionOptions = {},
): AttributionRecord[] {
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const trailingWindowMs = options.trailingWindowMs ?? DEFAULT_TRAILING_WINDOW_MS;
  return observation.recentCommits.map((commit) => {
    const trailerSessionId = commit.trailers['Luwi-Session'];
    const trailerAgentId = commit.trailers['Luwi-Agent'];
    const trailerProjectId = commit.trailers['Luwi-Project'];
    const trailerSession =
      trailerSessionId === undefined
        ? undefined
        : sessions.find(
            (session) =>
              session.id === trailerSessionId && session.projectId === observation.projectId,
          );
    const hasContradictoryTrailer =
      trailerSessionId !== undefined &&
      (trailerSession === undefined ||
        (trailerAgentId !== undefined && trailerAgentId !== trailerSession.agentId) ||
        (trailerProjectId !== undefined && trailerProjectId !== observation.projectId));
    if (hasContradictoryTrailer) {
      return attributionRecordSchema.parse({
        id: identity([observation.projectId, commit.sha, 'unknown']),
        projectId: observation.projectId,
        commitSha: commit.sha,
        confidence: 'unknown',
        observedAt: observation.observedAt,
        evidenceIds: [observation.id, commit.sha],
        reasons: ['contradictory-luwi-trailers'],
      });
    }
    if (trailerSession !== undefined) {
      return attributionRecordSchema.parse({
        id: identity([observation.projectId, commit.sha, trailerSession.id, 'exact']),
        projectId: observation.projectId,
        sessionId: trailerSession.id,
        agentId: trailerSession.agentId,
        commitSha: commit.sha,
        confidence: 'exact',
        observedAt: observation.observedAt,
        evidenceIds: [observation.id, commit.sha],
        reasons: ['explicit-luwi-session-trailer'],
      });
    }

    const matches = sessions.filter((session) =>
      matchesCorrelation(session, observation, commit.committedAt, clockSkewMs, trailingWindowMs),
    );
    if (matches.length === 1) {
      const session = matches[0]!;
      return attributionRecordSchema.parse({
        id: identity([observation.projectId, commit.sha, session.id, 'correlated']),
        projectId: observation.projectId,
        sessionId: session.id,
        agentId: session.agentId,
        commitSha: commit.sha,
        confidence: 'correlated',
        observedAt: observation.observedAt,
        evidenceIds: [observation.id, commit.sha],
        reasons: ['branch-time-worktree-correlation'],
      });
    }
    return attributionRecordSchema.parse({
      id: identity([observation.projectId, commit.sha, 'unknown']),
      projectId: observation.projectId,
      commitSha: commit.sha,
      confidence: 'unknown',
      observedAt: observation.observedAt,
      evidenceIds: [observation.id, commit.sha],
      reasons: [
        matches.length === 0 ? 'insufficient-session-correlation' : 'ambiguous-session-correlation',
      ],
    });
  });
}
