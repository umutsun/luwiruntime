export interface RedisKeys {
  readonly namespace: string;
  readonly globalEvents: string;
  readonly deadLetterEvents: string;
  readonly projectsIndex: string;
  readonly heartbeatDeadlines: string;
  readonly daemonOwner: string;
  projectEvents(projectId: string): string;
  project(projectId: string): string;
  session(sessionId: string): string;
  projectPathIndex(pathIdentityHash: string): string;
  projectSessions(projectId: string): string;
  agentSessions(agentId: string): string;
  sessionPresence(sessionId: string): string;
}

const safeKeyPartPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function keyPart(value: string): string {
  if (!safeKeyPartPattern.test(value)) {
    throw new Error('Unsafe Redis key identifier');
  }
  return value;
}

export function createRedisKeys(namespace = 'luwi:v1'): RedisKeys {
  const prefix = namespace.replace(/:+$/, '');

  return {
    namespace: prefix,
    globalEvents: `${prefix}:events:global`,
    deadLetterEvents: `${prefix}:events:dead-letter`,
    projectsIndex: `${prefix}:index:projects`,
    heartbeatDeadlines: `${prefix}:deadline:heartbeats`,
    daemonOwner: `${prefix}:runtime:daemon-owner`,
    projectEvents: (projectId) => `${prefix}:events:project:${keyPart(projectId)}`,
    project: (projectId) => `${prefix}:project:${keyPart(projectId)}`,
    session: (sessionId) => `${prefix}:session:${keyPart(sessionId)}`,
    projectPathIndex: (pathIdentityHash) =>
      `${prefix}:index:project:path:${keyPart(pathIdentityHash)}`,
    projectSessions: (projectId) => `${prefix}:index:project:${keyPart(projectId)}:sessions`,
    agentSessions: (agentId) => `${prefix}:index:agent:${keyPart(agentId)}:sessions`,
    sessionPresence: (sessionId) => `${prefix}:presence:session:${keyPart(sessionId)}`,
  };
}
