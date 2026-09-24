import type { DashboardEvent } from '../realtime/schema.js';

export type Availability<T> = { state: 'ready'; data: T } | { state: 'unavailable' };
export type ObservedBoolean = boolean | 'unknown';

export type PulseProject = {
  id: string;
  name: string;
  localPath: string;
  repositoryUrl?: string;
  defaultBranch?: string;
};
export type PulseSession = {
  id: string;
  agentId: string;
  projectId: string;
  status: string;
  presence: 'online' | 'offline';
  startedAt: string;
  lastHeartbeatAt: string;
  branch?: string;
  /** Reported by the session about itself; absent when it reported none. */
  taskSummary?: string;
  /** Free-form, as registered (e.g. `{ model }`); optional so older reads still type. */
  metadata?: Record<string, unknown>;
};
export type PulseUsageSource = {
  source: 'agent-exact' | 'agent-reported' | 'adapter-extracted' | 'luwi-estimated' | 'unavailable';
  recordCount: number;
  totalTokens?: number;
};
export type PulseContextContribution = {
  /**
   * Optional in the protocol, and therefore optional here. A contribution that
   * names no session belongs to no session — it is never attributed to one.
   */
  sessionId?: string;
  assigned: ObservedBoolean;
  effective: ObservedBoolean;
  loaded: ObservedBoolean;
  invoked: ObservedBoolean;
};

/**
 * `kind` and `adapterId` are rendered verbatim as data. The dashboard never
 * maps them to per-vendor labels or behaviour: `product-independence.test.ts`
 * forbids vendor names in production source precisely so that no agent can be
 * privileged by the code that displays it.
 */
export type PulseAgent = {
  id: string;
  kind: string;
  displayName: string;
  adapterId: string;
  enabled: boolean;
  detectedVersion?: string;
  updatedAt: string;
};

export type PulseFinding = {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  summary: string;
  state: 'open' | 'dismissed' | 'proposed' | 'resolved';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  sessionCount: number;
  observationCount: number;
  updatedAt: string;
};

export type PulseHealth = {
  status: 'ok' | 'degraded';
  runtimeState: string;
  uptimeMs: number;
  redis:
    | { connected: true; status: 'connected'; latencyMs: number }
    | { connected: false; status: 'disconnected' };
};

/**
 * One project's Git facts, as the daemon's read-only observation reported
 * them. Only stated facts — the mockup's `Release Readiness` judgement was
 * replaced by exactly this list (see the redesign plan's honest replacements).
 */
export type PulseGitFacts = {
  branch?: string;
  headSha?: string;
  clean: boolean;
  untrackedCount: number;
  tagCount: number;
  /** Commits in the observer's bounded recent window (git log -n), not a total. */
  recentCommitCount: number;
  /** Reachable commits from HEAD (a true total); absent for an unborn HEAD. */
  commitCount?: number;
  observedAt: string;
};

/**
 * `not-observed` is a complete answer: no scan was ever recorded. It must not
 * be folded into `unavailable`, which claims a fault.
 */
export type PulseGitEntry = {
  projectId: string;
  git:
    { state: 'ready'; data: PulseGitFacts } | { state: 'not-observed' } | { state: 'unavailable' };
};

export type PulseGitResource = { truncated: boolean; entries: PulseGitEntry[] };

/**
 * The per-project coordinator role (ADR 0035) as the daemon reports it: the
 * session that holds it (or `null`) and whether that session is still live.
 * Only a live holder is authoritative; a terminal one reads `live: false` and
 * is takeable, so the sessions view badges only `sessionId` matches with `live`.
 */
export type PulseCoordinator = { sessionId: string | null; live: boolean };
export type PulseCoordinatorEntry = {
  projectId: string;
  coordinator: Availability<PulseCoordinator>;
};
export type PulseCoordinatorResource = { truncated: boolean; entries: PulseCoordinatorEntry[] };

/**
 * The flow roles (F5, ADR 0036) a project's bound agents hold, as the daemon
 * records them: configuration on the binding, never a session claim. Read per
 * project with the same bounded fan-out as git and the coordinator, so the
 * sessions table can chip a row and the drill-down can state who implements
 * and who verifies without a per-row read.
 */
export type PulseFlowRole = 'implementer' | 'verifier';
export type PulseBinding = { agentId: string; enabled: boolean; flowRoles: PulseFlowRole[] };
export type PulseBindingsEntry = { projectId: string; bindings: Availability<PulseBinding[]> };
export type PulseBindingsResource = { truncated: boolean; entries: PulseBindingsEntry[] };

export type PulseRuntimeInfo = {
  workspaceId: string;
  version: string;
  protocolVersion: number;
  runtimeState: string;
  runtimeInstanceId: string;
  startedAt: string;
  uptimeMs: number;
  host: string;
  port: number;
};

export type PulseResources = {
  health: Availability<PulseHealth>;
  projects: Availability<PulseProject[]>;
  sessions: Availability<PulseSession[]>;
  agents: Availability<PulseAgent[]>;
  usage: Availability<PulseUsageSource[]>;
  context: Availability<PulseContextContribution[]>;
  activity: Availability<DashboardEvent[]>;
  findings: Availability<PulseFinding[]>;
  runtime: Availability<PulseRuntimeInfo>;
  git: Availability<PulseGitResource>;
  coordinator: Availability<PulseCoordinatorResource>;
  bindings: Availability<PulseBindingsResource>;
};

export type PulseInput = Omit<PulseResources, 'runtime' | 'git' | 'coordinator' | 'bindings'> & {
  measuredLatencyMs: number;
  snapshotAt: string;
  /**
   * Optional because most unit tests build an input without the newest reads;
   * the real loader always supplies them. An absent key means "not requested"
   * and does not mark the snapshot partial — an explicit `unavailable` still
   * does.
   */
  runtime?: Availability<PulseRuntimeInfo>;
  git?: Availability<PulseGitResource>;
  coordinator?: Availability<PulseCoordinatorResource>;
  bindings?: Availability<PulseBindingsResource>;
};

/**
 * A count that knows whether it was actually observed.
 *
 * A failed read must never surface as `0`. Every count derived from a resource
 * that can fail carries this instead of a bare number, so the view is forced to
 * decide what to render rather than silently printing a zero the runtime never
 * measured.
 */
export type CountValue = { state: 'ready' | 'empty'; value: number } | { state: 'unavailable' };

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

/**
 * The nine observed session statuses, in the order a breakdown reads them.
 *
 * Ordered rather than a bare set because the Active Work header states the
 * whole vocabulary in this sequence. There is deliberately no "running" entry:
 * it is not a status the runtime records, and folding `thinking` and
 * `tool_running` into one would manufacture it.
 */
const sessionStatusOrder = [
  'starting',
  'idle',
  'thinking',
  'tool_running',
  'waiting_for_input',
  'waiting_for_agent',
  'blocked',
  'completed',
  'disconnected',
] as const;

const knownSessionStatuses = new Set<string>(sessionStatusOrder);

const waitingStatuses = new Set(['waiting_for_input', 'waiting_for_agent']);

export function labelSessionStatus(status: string): string {
  if (!knownSessionStatuses.has(status)) return 'Unknown';
  return status.replaceAll('_', ' ');
}

/**
 * How a session reached the runtime: a headless `cli` worker (`agent run`), an
 * interactive `gui`/`ide` attach, or the realtime `bridge`. Generic by design —
 * `product-independence.test.ts` forbids vendor names in production source, and
 * these four are client shapes, not vendors.
 */
export type ClientKind = 'cli' | 'gui' | 'ide' | 'bridge';
const knownClientKinds = new Set<ClientKind>(['cli', 'gui', 'ide', 'bridge']);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * The client kind, from an explicit `metadata.client` marker when one is present,
 * else derived from the signals the runtime already carries: a bridge stamps
 * `metadata.bridge`, an interactive attach earns a native `metadata.title`, and a
 * plain session is a CLI worker. The marker makes new sessions exact; the
 * fallback keeps every already-registered session answerable.
 */
export function deriveClientKind(metadata: Record<string, unknown> | undefined): ClientKind {
  const explicit = metadata?.['client'];
  if (typeof explicit === 'string' && knownClientKinds.has(explicit as ClientKind)) {
    return explicit as ClientKind;
  }
  if (isNonEmptyString(metadata?.['bridge'])) return 'bridge';
  if (isNonEmptyString(metadata?.['title'])) return 'gui';
  return 'cli';
}

/** One entry per status actually present, so an absent status states nothing. */
export type SessionStatusCount = { status: string; label: string; count: number };

function countOf<T>(resource: Availability<T[]>): CountValue {
  if (resource.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: resource.data.length === 0 ? 'empty' : 'ready',
    value: resource.data.length,
  };
}

/**
 * The context evidence one session reported.
 *
 * `not-observed` is not `0`: it means the contributions read succeeded and no
 * contribution named this session, which is a different fact from a count of
 * zero loaded sources and a different fact again from a failed read.
 */
export type SessionContextEvidence =
  | { state: 'ready'; assigned: number; loaded: number; invoked: number }
  | { state: 'not-observed' }
  | { state: 'unavailable' };

export function buildPulseSnapshot(input: PulseInput) {
  const projectById = new Map(
    input.projects.state === 'ready'
      ? input.projects.data.map((project) => [project.id, project] as const)
      : [],
  );
  const agentById = new Map(
    input.agents.state === 'ready'
      ? input.agents.data.map((agent) => [agent.id, agent] as const)
      : [],
  );
  const contributionsBySession = new Map<string, PulseContextContribution[]>();
  if (input.context.state === 'ready') {
    for (const contribution of input.context.data) {
      if (contribution.sessionId === undefined) continue;
      const bucket = contributionsBySession.get(contribution.sessionId);
      if (bucket === undefined) contributionsBySession.set(contribution.sessionId, [contribution]);
      else bucket.push(contribution);
    }
  }
  const sessionContext = (sessionId: string): SessionContextEvidence => {
    if (input.context.state === 'unavailable') return { state: 'unavailable' };
    const rows = contributionsBySession.get(sessionId);
    if (rows === undefined) return { state: 'not-observed' };
    return {
      state: 'ready',
      assigned: rows.filter((row) => row.assigned === true).length,
      loaded: rows.filter((row) => row.loaded === true).length,
      invoked: rows.filter((row) => row.invoked === true).length,
    };
  };
  const sessions =
    input.sessions.state === 'ready'
      ? input.sessions.data.map((session) => {
          const definition = agentById.get(session.agentId);
          return {
            ...session,
            projectName: projectById.get(session.projectId)?.name ?? 'Unavailable',
            statusLabel: labelSessionStatus(session.status),
            /*
             * The raw id is the fallback, and the view is told which it got.
             * An opaque agent id must never be presented as though a definition
             * stood behind it — including when the agent read itself failed,
             * which is why this asks the map rather than the read's state.
             */
            agentName: definition?.displayName ?? session.agentId,
            agentKnown: definition !== undefined,
            clientKind: deriveClientKind(session.metadata),
            context: sessionContext(session.id),
          };
        })
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

  const perAgentSessionCount = (agentId: string): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = sessions.filter((session) => session.agentId === agentId).length;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  /*
   * A model is a session's statement about itself (`metadata.model`, reported
   * at registration), never a definition's property. Listed per agent as the
   * distinct values its sessions reported; none reported is an empty list, and
   * the row's session count already says when the read was unavailable.
   */
  const modelsOf = (rows: PulseSession[]): string[] =>
    [
      ...new Set(
        rows.flatMap((session) => {
          const model = session.metadata?.['model'];
          return typeof model === 'string' ? [model] : [];
        }),
      ),
    ].sort();
  const perAgentModels = (agentId: string): string[] =>
    modelsOf(sessions.filter((session) => session.agentId === agentId));
  /*
   * Agent ids that sessions carry but no definition covers — a session attached
   * by a launcher hook names its vendor, not a registered definition. Listed
   * rather than folded into a definition, because the definition is what would
   * be invented. Only when both reads succeeded: an unavailable side would make
   * every id look unregistered.
   */
  const definedAgents = input.agents.state === 'ready' ? input.agents.data : undefined;
  const unregisteredAgents =
    definedAgents !== undefined && input.sessions.state === 'ready'
      ? [...new Set(sessions.map((session) => session.agentId))]
          .filter((id) => !definedAgents.some((agent) => agent.id === id))
          .sort()
          .map((id) => {
            const rows = sessions.filter((session) => session.agentId === id);
            return { id, sessionCount: rows.length, models: modelsOf(rows) };
          })
      : [];
  const perProjectActiveSessions = (projectId: string): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = activeSessions.filter((session) => session.projectId === projectId).length;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  /*
   * Distinct agents holding an active session here — not the project's agent
   * bindings, which are a separately scoped read the Pulse batch does not make.
   * The two are different claims and the view labels this one as what it is.
   */
  const perProjectActiveAgents = (projectId: string): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = new Set(
      activeSessions
        .filter((session) => session.projectId === projectId)
        .map((session) => session.agentId),
    ).size;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  const projects =
    input.projects.state === 'ready'
      ? input.projects.data.map((project) => ({
          ...project,
          activeSessions: perProjectActiveSessions(project.id),
          activeAgents: perProjectActiveAgents(project.id),
        }))
      : [];

  const countActive = (matches: (status: string) => boolean): CountValue => {
    if (input.sessions.state === 'unavailable') return { state: 'unavailable' };
    const value = activeSessions.filter((session) => matches(session.status)).length;
    return { state: value === 0 ? 'empty' : 'ready', value };
  };
  const statusBreakdown: SessionStatusCount[] = [];
  for (const status of sessionStatusOrder) {
    const count = activeSessions.filter((session) => session.status === status).length;
    if (count > 0) statusBreakdown.push({ status, label: labelSessionStatus(status), count });
  }
  const unknownStatusCount = activeSessions.filter(
    (session) => !knownSessionStatuses.has(session.status),
  ).length;
  if (unknownStatusCount > 0) {
    statusBreakdown.push({ status: 'unknown', label: 'Unknown', count: unknownStatusCount });
  }

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

  const gitResource = input.git ?? { state: 'unavailable' as const };
  const gitEntryByProject = new Map(
    gitResource.state === 'ready'
      ? gitResource.data.entries.map((entry) => [entry.projectId, entry.git] as const)
      : [],
  );
  /*
   * One row per registered project, joined to whatever the per-project Git
   * read returned. A project past the fan-out cap has no entry and is shown
   * as unavailable — with the truncation disclosed — never silently dropped.
   */
  const repositoryFacts = (input.projects.state === 'ready' ? input.projects.data : []).map(
    (project) => ({
      projectId: project.id,
      name: project.name,
      git: gitEntryByProject.get(project.id) ?? { state: 'unavailable' as const },
    }),
  );

  const coordinatorResource = input.coordinator ?? { state: 'unavailable' as const };
  // projectId -> the live/none coordinator view, for the sessions table badge and
  // its Make/Release action. Only ready entries are kept; a missing project means
  // "not read", which the view treats the same as "no coordinator" (no badge).
  const coordinatorByProject: Record<string, PulseCoordinator> = {};
  if (coordinatorResource.state === 'ready') {
    for (const entry of coordinatorResource.data.entries) {
      if (entry.coordinator.state === 'ready') {
        coordinatorByProject[entry.projectId] = entry.coordinator.data;
      }
    }
  }

  const bindingsResource = input.bindings ?? { state: 'unavailable' as const };
  // projectId -> agentId -> the flow roles (F5, ADR 0036) an enabled binding
  // holds, for the sessions table chips and the drill-down facts. Only ready
  // entries with at least one role are kept; a missing key reads as none.
  const flowRolesByProject: Record<string, Record<string, PulseFlowRole[]>> = {};
  if (bindingsResource.state === 'ready') {
    for (const entry of bindingsResource.data.entries) {
      if (entry.bindings.state !== 'ready') continue;
      for (const binding of entry.bindings.data) {
        if (!binding.enabled || binding.flowRoles.length === 0) continue;
        (flowRolesByProject[entry.projectId] ??= {})[binding.agentId] = binding.flowRoles;
      }
    }
  }

  const contributions = input.context.state === 'ready' ? input.context.data : [];
  /*
   * The comp's two insight sentences, kept honest: a pair is counted only when
   * both sides are observed booleans. `unknown` is never counted as unused —
   * that is the ADR 0010 rule the Context route already renders.
   */
  const contextInsights = {
    assignedNeverLoaded: contributions.filter(
      (item) => item.assigned === true && item.loaded === false,
    ).length,
    loadedNotInvoked: contributions.filter((item) => item.loaded === true && item.invoked === false)
      .length,
  };
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
    statusBreakdown,
    waitingCount: countActive((status) => waitingStatuses.has(status)),
    blockedCount: countActive((status) => status === 'blocked'),
    agentCount: countOf(input.agents),
    agents:
      input.agents.state === 'ready'
        ? input.agents.data.map((agent) => ({
            ...agent,
            sessionCount: perAgentSessionCount(agent.id),
            models: perAgentModels(agent.id),
          }))
        : [],
    agentsState: input.agents.state,
    unregisteredAgents,
    sessions,
    activeSessions,
    projects,
    usage,
    usageState: input.usage.state,
    context,
    contextInsights,
    contextState: input.context.state,
    runtime: input.runtime ?? { state: 'unavailable' as const },
    repositoryFacts,
    gitState: gitResource.state,
    gitTruncated: gitResource.state === 'ready' ? gitResource.data.truncated : false,
    coordinatorByProject,
    coordinatorState: coordinatorResource.state,
    flowRolesByProject,
    bindingsState: bindingsResource.state,
    activityState: input.activity.state,
    activity: input.activity.state === 'ready' ? input.activity.data : [],
    findingCount: countOf(input.findings),
    findings: input.findings.state === 'ready' ? input.findings.data : [],
    findingsState: input.findings.state,
    sessionsState: input.sessions.state,
    partial: [
      input.health,
      input.projects,
      input.sessions,
      input.agents,
      input.usage,
      input.context,
      input.activity,
      input.findings,
      // Absent means "not requested" (unit-test inputs); only an explicit
      // failure marks the snapshot partial.
      ...(input.runtime === undefined ? [] : [input.runtime]),
      ...(input.git === undefined ? [] : [input.git]),
      ...(input.coordinator === undefined ? [] : [input.coordinator]),
      ...(input.bindings === undefined ? [] : [input.bindings]),
    ].some((resource) => resource.state === 'unavailable'),
  };
}

export type PulseSnapshot = ReturnType<typeof buildPulseSnapshot>;

/**
 * The overview's project filter, applied client-side.
 *
 * Narrows the snapshot to the projects the owner switched on: rows that carry
 * a `projectId` are filtered, and every count over them is recomputed so the
 * stats describe what is on screen, not the runtime. Two rules keep it honest:
 * a failed read stays failed — a filter never turns `unavailable` into an
 * empty list — and an event without a `projectId` belongs to the runtime, so
 * it is kept. Reads that have no per-project shape (usage grades, the context
 * counts, findings) pass through; their figures are runtime-wide either way.
 * `undefined` means no filter, and costs nothing.
 */
export function scopePulseSnapshotToProjects(
  snapshot: PulseSnapshot,
  visible: ReadonlySet<string> | undefined,
): PulseSnapshot {
  if (visible === undefined) return snapshot;
  const keep = (projectId: string | undefined): boolean =>
    projectId === undefined || visible.has(projectId);

  const sessions = snapshot.sessions.filter((session) => keep(session.projectId));
  const activeSessions = snapshot.activeSessions.filter((session) => keep(session.projectId));
  const projects = snapshot.projects.filter((project) => keep(project.id));
  const repositoryFacts = snapshot.repositoryFacts.filter((row) => keep(row.projectId));
  const activity = snapshot.activity.filter((event) => keep(event.projectId));

  const recount = (source: CountValue, value: number): CountValue =>
    source.state === 'unavailable'
      ? { state: 'unavailable' }
      : { state: value === 0 ? 'empty' : 'ready', value };

  const statusBreakdown: SessionStatusCount[] = [];
  for (const entry of snapshot.statusBreakdown) {
    const count = activeSessions.filter(
      (session) =>
        session.status === entry.status ||
        (entry.status === 'unknown' && labelSessionStatus(session.status) === 'Unknown'),
    ).length;
    if (count > 0) statusBreakdown.push({ ...entry, count });
  }

  return {
    ...snapshot,
    sessions,
    activeSessions,
    projects,
    repositoryFacts,
    activity,
    statusBreakdown,
    projectCount: recount(snapshot.projectCount, projects.length),
    activeSessionCount: recount(snapshot.activeSessionCount, activeSessions.length),
    waitingCount: recount(
      snapshot.waitingCount,
      activeSessions.filter((session) => session.status.startsWith('waiting')).length,
    ),
    blockedCount: recount(
      snapshot.blockedCount,
      activeSessions.filter((session) => session.status === 'blocked').length,
    ),
  };
}
