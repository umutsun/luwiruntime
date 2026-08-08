import type { DashboardEvent } from '../realtime/schema.js';

export type Availability<T> = { state: 'ready'; data: T } | { state: 'unavailable' };
export type ObservedBoolean = boolean | 'unknown';

export type PulseProject = { id: string; name: string; localPath: string };
export type PulseSession = {
  id: string;
  agentId: string;
  projectId: string;
  status: string;
  presence: 'online' | 'offline';
  startedAt: string;
  lastHeartbeatAt: string;
  branch?: string;
};
export type PulseUsageSource = {
  source: 'agent-exact' | 'agent-reported' | 'adapter-extracted' | 'luwi-estimated' | 'unavailable';
  recordCount: number;
  totalTokens?: number;
};
export type PulseContextContribution = {
  assigned: ObservedBoolean;
  effective: ObservedBoolean;
  loaded: ObservedBoolean;
  invoked: ObservedBoolean;
};

export type PulseHealth = {
  status: 'ok' | 'degraded';
  runtimeState: string;
  uptimeMs: number;
  redis:
    | { connected: true; status: 'connected'; latencyMs: number }
    | { connected: false; status: 'disconnected' };
};

export type PulseResources = {
  health: Availability<PulseHealth>;
  projects: Availability<PulseProject[]>;
  sessions: Availability<PulseSession[]>;
  agents: Availability<unknown[]>;
  usage: Availability<PulseUsageSource[]>;
  context: Availability<PulseContextContribution[]>;
  activity: Availability<DashboardEvent[]>;
  findings: Availability<unknown[]>;
};

export type PulseInput = PulseResources & {
  measuredLatencyMs: number;
  snapshotAt: string;
};

type CountValue = { state: 'ready' | 'empty'; value: number } | { state: 'unavailable' };

const usageOrder = [
  'agent-exact',
  'agent-reported',
  'adapter-extracted',
  'luwi-estimated',
  'unavailable',
] as const;

const usageLabels: Record<(typeof usageOrder)[number], string> = {
  'agent-exact': 'Exact',
  'agent-reported': 'Reported',
  'adapter-extracted': 'Extracted',
  'luwi-estimated': 'Estimated',
  unavailable: 'Unavailable',
};

const knownSessionStatuses = new Set([
  'starting',
  'idle',
  'thinking',
  'tool_running',
  'waiting_for_input',
  'waiting_for_agent',
  'blocked',
  'completed',
  'disconnected',
]);

export function labelSessionStatus(status: string): string {
  if (!knownSessionStatuses.has(status)) return 'Unknown';
  return status.replaceAll('_', ' ');
}

function countOf<T>(resource: Availability<T[]>): CountValue {
  if (resource.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: resource.data.length === 0 ? 'empty' : 'ready',
    value: resource.data.length,
  };
}

export function buildPulseSnapshot(input: PulseInput) {
  const projectById = new Map(
    input.projects.state === 'ready'
      ? input.projects.data.map((project) => [project.id, project] as const)
      : [],
  );
  const sessions =
    input.sessions.state === 'ready'
      ? input.sessions.data.map((session) => ({
          ...session,
          projectName: projectById.get(session.projectId)?.name ?? 'Unavailable',
          statusLabel: labelSessionStatus(session.status),
        }))
      : [];
  const activeSessions =
    input.sessions.state === 'ready'
      ? sessions.filter(
          (session) =>
            session.presence === 'online' &&
            session.status !== 'completed' &&
            session.status !== 'disconnected',
        )
      : [];

  const activeSessionCount: CountValue =
    input.sessions.state === 'unavailable'
      ? { state: 'unavailable' }
      : {
          state: activeSessions.length === 0 ? 'empty' : 'ready',
          value: activeSessions.length,
        };

  const projects =
    input.projects.state === 'ready'
      ? input.projects.data.map((project) => ({
          ...project,
          activeSessions: activeSessions.filter((session) => session.projectId === project.id)
            .length,
        }))
      : [];

  const usageSources = input.usage.state === 'ready' ? input.usage.data : [];
  const usage =
    input.usage.state === 'ready'
      ? usageOrder.flatMap((source) => {
          const row = usageSources.find((candidate) => candidate.source === source);
          return row === undefined
            ? []
            : [
                {
                  source: row.source,
                  label: usageLabels[source],
                  records: row.recordCount,
                  totalTokens: row.totalTokens,
                },
              ];
        })
      : [];

  const contributions = input.context.state === 'ready' ? input.context.data : [];
  const context = {
    assigned: contributions.filter((item) => item.assigned === true).length,
    effective: contributions.filter((item) => item.effective === true).length,
    loaded: contributions.filter((item) => item.loaded === true).length,
    invoked: contributions.filter((item) => item.invoked === true).length,
    unknown: contributions.filter((item) =>
      [item.assigned, item.effective, item.loaded, item.invoked].includes('unknown'),
    ).length,
  };

  return {
    snapshotAt: input.snapshotAt,
    measuredLatencyMs: input.measuredLatencyMs,
    health: input.health,
    projectCount: countOf(input.projects),
    activeSessionCount,
    agentCount: countOf(input.agents),
    sessions,
    activeSessions,
    projects,
    usage,
    usageState: input.usage.state,
    context,
    contextState: input.context.state,
    activityState: input.activity.state,
    activity: input.activity.state === 'ready' ? input.activity.data : [],
    findingCount: countOf(input.findings),
    partial: [
      input.health,
      input.projects,
      input.sessions,
      input.agents,
      input.usage,
      input.context,
      input.activity,
      input.findings,
    ].some((resource) => resource.state === 'unavailable'),
  };
}

export type PulseSnapshot = ReturnType<typeof buildPulseSnapshot>;
