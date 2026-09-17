import type { AgentMessage, SessionView } from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createMcpToolHandlers, McpDaemonError, type McpDaemonClient } from './index.js';

const timestamp = '2026-07-29T12:00:00.000Z';
const boundSession: SessionView = {
  id: 'source',
  agentId: 'claude-sim',
  projectId: 'project-1',
  status: 'idle',
  workingDirectory: 'C:/workspace',
  startedAt: timestamp,
  lastHeartbeatAt: timestamp,
  metadata: {},
  presence: 'online',
};

function client(): McpDaemonClient {
  return {
    verifyBoundSession: vi.fn(async () => boundSession),
    listProjects: vi.fn(async () => ({ projects: [] })),
    listProjectSessions: vi.fn(async () => ({ sessions: [boundSession] })),
    getSession: vi.fn(async () => boundSession),
    registerSession: vi.fn(async (request) => ({
      ...boundSession,
      id: 'revived',
      status: 'starting' as const,
      projectId: request.projectId,
      agentId: request.agentId,
    })),
    heartbeat: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => boundSession),
    setSessionStatus: vi.fn(async (sessionId, status) => ({
      ...boundSession,
      id: sessionId,
      status,
    })),
    getProject: vi.fn(async () => ({
      id: 'project-1',
      name: 'LUWI',
      localPath: 'C:/workspace',
      canonicalPath: 'C:/workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    listAgents: vi.fn(async () => []),
    getAgent: vi.fn(),
    listProjectAgents: vi.fn(async () => [
      {
        id: 'binding-1',
        projectId: 'project-1',
        agentId: 'claude-sim',
        enabled: true,
        profileIds: [],
        capabilityBindingIds: [],
        overrides: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]),
    getEffectiveConfig: vi.fn(),
    listCapabilities: vi.fn(async () => []),
    getCapability: vi.fn(),
    getContextFootprint: vi.fn(),
    listConfigDrift: vi.fn(async () => []),
    getUsageSummary: vi.fn(async (projectId, sessionId) => ({
      projectId,
      ...(sessionId === undefined ? {} : { sessionId }),
      recordCount: 0,
      sources: [],
    })),
    getContextIntelligence: vi.fn(async (projectId, agentId) => ({
      summary: {
        projectId,
        agentId,
        contributionCount: 0,
        assignedCount: 0,
        effectiveCount: 0,
        observedLoadedCount: 0,
        observedInvokedCount: 0,
        unknownLoadedCount: 0,
        sourceComposition: {},
        measuredAt: timestamp,
      },
      contributions: [],
      findings: [],
    })),
    getGitStatus: vi.fn(),
    getRecentCommits: vi.fn(async () => []),
    getPackageInventory: vi.fn(async () => []),
    getTechnologyInventory: vi.fn(async () => []),
    getGraphNeighbors: vi.fn(),
    getGraphPath: vi.fn(),
    listOptimizationFindings: vi.fn(async () => ({ findings: [], truncated: false })),
    getOptimizationProposal: vi.fn(),
    requestOptimizationAnalysis: vi.fn(async () => ({
      findings: [],
      proposals: [],
      analyzedAt: timestamp,
    })),
    acquireLease: vi.fn(async (body) => ({
      status: 'granted' as const,
      lease: {
        id: 'lease-1',
        projectId: body.projectId,
        sessionId: body.sessionId,
        agentId: 'claude-sim',
        path: body.path,
        matchPath: `${body.path.toLowerCase()}/`,
        reason: body.reason,
        state: 'held' as const,
        acquiredAt: timestamp,
        expiresAt: timestamp,
      },
    })),
    renewLease: vi.fn(),
    releaseLease: vi.fn(),
    listLeases: vi.fn(async () => ({ leases: [], truncated: false })),
    askAgent: vi.fn(async (body) => ({
      message: {
        id: 'message-1',
        correlationId: 'correlation-1',
        projectId: 'project-1',
        sourceSessionId: body.sourceSessionId,
        sourceAgentId: 'claude-sim',
        targetSessionId: 'target',
        targetAgentId: 'gemini-sim',
        selectionReason: 'selected target',
        kind: body.kind,
        content: body.content,
        evidenceRequirements: body.evidenceRequirements,
        state: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
        deadlineAt: '2026-07-29T12:02:00.000Z',
      },
      selectedTargetSessionId: 'target',
      selectedTargetAgentId: 'gemini-sim',
      selectionReason: 'selected target',
      delivery: 'live' as const,
      idempotent: false,
    })),
    getMessage: vi.fn(),
    waitForMessage: vi.fn(),
    claimInbox: vi.fn(async () => ({ items: [] })),
    transitionMessage: vi.fn(),
  };
}

describe('MCP tool handlers', () => {
  it('derives the message source from the bound session', async () => {
    const daemon = client();
    const tools = createMcpToolHandlers(daemon, boundSession);

    await tools.askAgent({
      targetAgentId: 'gemini-sim',
      kind: 'question',
      content: 'Status?',
      retryOf: 'correlation-0',
    });
    expect(daemon.askAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 'source', retryOf: 'correlation-0' }),
      undefined,
    );
    await expect(
      tools.askAgent({
        sourceSessionId: 'forged',
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Status?',
      }),
    ).rejects.toThrow();
  });

  it('claims and responds only as the bound session', async () => {
    const daemon = client();
    const tools = createMcpToolHandlers(daemon, boundSession);
    await tools.inboxNext({ bridgeInstanceId: 'mcp-1', blockMs: 0 });
    await tools.respondToMessage({
      correlationId: 'correlation-1',
      response: {
        status: 'answered',
        answer: 'Simulated.',
        evidence: [],
        verifiedAt: timestamp,
      },
    });

    expect(daemon.claimInbox).toHaveBeenCalledWith(
      'source',
      expect.objectContaining({ bridgeInstanceId: 'mcp-1' }),
    );
    expect(daemon.transitionMessage).toHaveBeenCalledWith(
      'respond',
      'correlation-1',
      'source',
      expect.objectContaining({ status: 'answered' }),
    );
  });

  it('returns only the bound project state and rejects cross-project session reads', async () => {
    const daemon = client();
    daemon.getSession = vi.fn(async () => ({ ...boundSession, projectId: 'project-2' }));
    const tools = createMcpToolHandlers(daemon, boundSession);

    await expect(tools.getProjectState({})).resolves.toMatchObject({
      project: { id: 'project-1' },
      sessions: [expect.objectContaining({ id: 'source' })],
    });
    await expect(tools.getSession({ sessionId: 'other' })).rejects.toMatchObject({
      code: 'BOUND_PROJECT_MISMATCH',
    });
  });

  it('separates a same-project not-participant read from a project mismatch (LRT-P07)', async () => {
    const daemon = client();
    const message = (over: Partial<AgentMessage>): AgentMessage => ({
      id: 'm',
      correlationId: 'c',
      projectId: 'project-1',
      sourceSessionId: 'someone-else',
      sourceAgentId: 'a',
      targetSessionId: 'another',
      targetAgentId: 'b',
      selectionReason: 'x',
      kind: 'question',
      content: 'q',
      evidenceRequirements: [],
      state: 'responded',
      createdAt: timestamp,
      updatedAt: timestamp,
      deadlineAt: timestamp,
      ...over,
    });
    // Same project, bound 'source' is neither source nor target.
    daemon.getMessage = vi.fn(async () => message({}));
    await expect(
      createMcpToolHandlers(daemon, boundSession).getMessage({ correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'BOUND_SESSION_NOT_PARTICIPANT', statusCode: 403 });
    // A different project is still a project mismatch.
    daemon.getMessage = vi.fn(async () => message({ projectId: 'project-2' }));
    await expect(
      createMcpToolHandlers(daemon, boundSession).getMessage({ correlationId: 'c' }),
    ).rejects.toMatchObject({ code: 'BOUND_PROJECT_MISMATCH' });
  });

  it('lists the most recently active sessions first so the cap keeps live workers (LRT-P08)', async () => {
    const daemon = client();
    const at = (iso: string, id: string): SessionView => ({
      ...boundSession,
      id,
      lastHeartbeatAt: iso,
    });
    daemon.listProjectSessions = vi.fn(async () => ({
      sessions: [
        at('2026-07-29T10:00:00.000Z', 'oldest'),
        at('2026-07-29T13:00:00.000Z', 'newest'),
        at('2026-07-29T11:00:00.000Z', 'middle'),
      ],
    }));
    const result = (await createMcpToolHandlers(daemon, boundSession).listSessions({})) as {
      sessions: SessionView[];
    };
    expect(result.sessions.map((session) => session.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('revalidates the bound session before every operation', async () => {
    const daemon = client();
    daemon.verifyBoundSession = vi.fn(async () => {
      throw new Error('bound session is offline');
    });
    const tools = createMcpToolHandlers(daemon, boundSession);

    await expect(
      tools.askAgent({
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Status?',
      }),
    ).rejects.toThrow('bound session is offline');
    expect(daemon.askAgent).not.toHaveBeenCalled();
  });

  it('uses one rotated identity snapshot through an ask-and-wait request', async () => {
    const daemon = client();
    const rotated = { ...boundSession, id: 'source-rotated' };
    daemon.verifyBoundSession = vi.fn(async () => rotated);
    daemon.waitForMessage = vi.fn(async () => ({
      id: 'message-1',
      correlationId: 'correlation-1',
      projectId: rotated.projectId,
      sourceSessionId: rotated.id,
      sourceAgentId: rotated.agentId,
      targetSessionId: 'target',
      targetAgentId: 'gemini-sim',
      selectionReason: 'selected target',
      kind: 'question' as const,
      content: 'Status?',
      evidenceRequirements: [],
      state: 'responded' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      deadlineAt: '2026-07-29T12:02:00.000Z',
    }));
    const tools = createMcpToolHandlers(daemon, boundSession);

    await expect(
      tools.askAgent({
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Status?',
        waitMs: 1,
      }),
    ).resolves.toMatchObject({ state: 'responded' });
    expect(daemon.verifyBoundSession).toHaveBeenCalledTimes(1);
    expect(daemon.askAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceSessionId: rotated.id }),
      undefined,
    );
  });

  it('does not wait on a deferred (turn-based GUI) target, returning delivery immediately', async () => {
    const daemon = client();
    daemon.askAgent = vi.fn(async (body) => ({
      message: {
        id: 'message-1',
        correlationId: 'correlation-1',
        projectId: 'project-1',
        sourceSessionId: body.sourceSessionId,
        sourceAgentId: 'claude-sim',
        targetSessionId: 'gui-1',
        targetAgentId: 'gemini-sim',
        selectionReason: 'selected target',
        kind: body.kind,
        content: body.content,
        evidenceRequirements: body.evidenceRequirements,
        state: 'queued' as const,
        createdAt: timestamp,
        updatedAt: timestamp,
        deadlineAt: '2026-07-29T12:02:00.000Z',
      },
      selectedTargetSessionId: 'gui-1',
      selectedTargetAgentId: 'gemini-sim',
      selectionReason: 'selected target',
      delivery: 'deferred' as const,
      idempotent: false,
    }));
    daemon.waitForMessage = vi.fn();
    const tools = createMcpToolHandlers(daemon, boundSession);

    await expect(
      tools.askAgent({
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Status?',
        waitMs: 5_000,
      }),
    ).resolves.toMatchObject({ delivery: 'deferred', state: 'queued' });
    expect(daemon.waitForMessage).not.toHaveBeenCalled();
  });

  it('resolves a fresh verified session for consecutive operations', async () => {
    const daemon = client();
    const sessions = [
      { ...boundSession, id: 'source-1' },
      { ...boundSession, id: 'source-2' },
    ];
    const resolveBoundSession = vi.fn(async () => sessions.shift() ?? boundSession);
    const tools = createMcpToolHandlers(daemon, boundSession, resolveBoundSession);

    await tools.acquireLease({ path: 'src/one', reason: 'first' });
    await tools.acquireLease({ path: 'src/two', reason: 'second' });

    expect(daemon.acquireLease).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'source-1' }),
    );
    expect(daemon.acquireLease).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'source-2' }),
    );
  });

  it('rejects a rotated session outside the startup project before mutation', async () => {
    const daemon = client();
    const tools = createMcpToolHandlers(daemon, boundSession, async () => ({
      ...boundSession,
      id: 'foreign',
      projectId: 'project-2',
    }));

    await expect(tools.acquireLease({ path: 'src', reason: 'foreign' })).rejects.toMatchObject({
      code: 'BOUND_PROJECT_MISMATCH',
    });
    expect(daemon.acquireLease).not.toHaveBeenCalled();
  });

  it('bounds Phase 3 read tools to the current project and exposes no apply operation', async () => {
    const daemon = client();
    daemon.listAgents = vi.fn(async () => [
      {
        id: 'claude-sim',
        kind: 'claude-code',
        displayName: 'Claude',
        enabled: true,
        adapterId: 'claude-code-native-v1',
        nativeConfigRoots: ['C:/fixture/.claude'],
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      },
      {
        id: 'outside-agent',
        kind: 'other',
        displayName: 'Outside',
        enabled: true,
        adapterId: 'other-v1',
        nativeConfigRoots: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      },
    ]);
    const tools = createMcpToolHandlers(daemon, boundSession);

    await expect(tools.listAgents({})).resolves.toMatchObject({
      agents: [expect.objectContaining({ id: 'claude-sim' })],
    });
    await expect(tools.getAgent({ agentId: 'outside-agent' })).rejects.toMatchObject({
      code: 'BOUND_PROJECT_MISMATCH',
    });
    expect('applyConfig' in tools).toBe(false);
  });

  it('keeps Phase 4 intelligence tools bound and exposes no accept, apply, rebuild, or Git mutation', async () => {
    const daemon = client();
    daemon.getRecentCommits = vi.fn(async () => []);
    daemon.listOptimizationFindings = vi.fn(async () => ({ findings: [], truncated: true }));
    const tools = createMcpToolHandlers(daemon, boundSession);

    await tools.getUsageSummary({ sessionOnly: true });
    await tools.getRecentCommits({ limit: 10 });
    await expect(tools.listOptimizationFindings({ limit: 10 })).resolves.toMatchObject({
      truncated: true,
    });
    await tools.requestOptimizationAnalysis({ minimumSessions: 3 });

    expect(daemon.getUsageSummary).toHaveBeenCalledWith(
      'project-1',
      'source',
      undefined,
      undefined,
    );
    expect(daemon.getRecentCommits).toHaveBeenCalledWith('project-1', 10);
    expect(daemon.listOptimizationFindings).toHaveBeenCalledWith('project-1', 10);
    expect(daemon.requestOptimizationAnalysis).toHaveBeenCalledWith({
      projectId: 'project-1',
      agentId: 'claude-sim',
      minimumSessions: 3,
    });
    expect(Object.keys(tools)).not.toEqual(
      expect.arrayContaining([
        'acceptOptimizationProposal',
        'applyConfigPlan',
        'rebuildGraph',
        'mutateGit',
      ]),
    );
  });
});

describe('work lease tools', () => {
  /**
   * The binding is the whole safety property here. No lease tool takes a
   * session id, so an agent cannot take or drop a hold on another's behalf.
   */
  it('derives the holder and the project from the bound session, never from input', async () => {
    const daemon = client();
    const tools = createMcpToolHandlers(daemon, boundSession);

    await tools.acquireLease({ path: 'apps/daemon/src', reason: 'editing routes' });

    expect(daemon.acquireLease).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'source',
      path: 'apps/daemon/src',
      reason: 'editing routes',
      durationMs: 300_000,
    });
  });

  it('joins as a ready worker, then blocks on its own inbox for the next task', async () => {
    const daemon = client();
    const tools = createMcpToolHandlers(daemon, boundSession);

    const result = (await tools.join({})) as {
      session: SessionView;
      ready: boolean;
      inbox: { items: unknown[] };
    };

    expect(daemon.setSessionStatus).toHaveBeenCalledWith('source', 'idle');
    expect(daemon.claimInbox).toHaveBeenCalledWith(
      'source',
      expect.objectContaining({ bridgeInstanceId: 'gui-join' }),
    );
    expect(result.ready).toBe(true);
    expect(result.session.status).toBe('idle');
    expect(result.inbox.items).toEqual([]);
  });

  it('rejects an acquire that tries to name its own holder', async () => {
    const tools = createMcpToolHandlers(client(), boundSession);

    await expect(
      tools.acquireLease({ path: 'src', reason: 'x', sessionId: 'someone-else' }),
    ).rejects.toThrow();
  });

  it('renews and releases as the bound session', async () => {
    const daemon = client();
    const tools = createMcpToolHandlers(daemon, boundSession);

    await tools.renewLease({ leaseId: 'lease-1', durationMs: 60_000 });
    await tools.releaseLease({ leaseId: 'lease-1' });

    expect(daemon.renewLease).toHaveBeenCalledWith('lease-1', 'source', 60_000);
    expect(daemon.releaseLease).toHaveBeenCalledWith('lease-1', 'source');
  });

  it('lists the bound project by default and only this session with mine', async () => {
    const daemon = client();
    const tools = createMcpToolHandlers(daemon, boundSession);

    await tools.listLeases({});
    expect(daemon.listLeases).toHaveBeenCalledWith({ projectId: 'project-1' }, 100);

    await tools.listLeases({ mine: true });
    expect(daemon.listLeases).toHaveBeenCalledWith({ sessionId: 'source' }, 100);
  });
});

describe('join revival (ADR 0034)', () => {
  const terminal = () => new McpDaemonError('BOUND_SESSION_TERMINAL', 'terminal', 409);

  it('fails closed on a dropped attach session when no reviver is given', async () => {
    const daemon = client();
    const error = terminal();
    const tools = createMcpToolHandlers(daemon, boundSession, async () => {
      throw error;
    });
    await expect(tools.join({})).rejects.toBe(error);
    expect(daemon.setSessionStatus).not.toHaveBeenCalled();
  });

  it('revives a dropped attach session on join, then joins the successor as usual', async () => {
    const daemon = client();
    const revived: SessionView = { ...boundSession, id: 'revived', status: 'starting' };
    const revive = vi.fn(async () => revived);
    const tools = createMcpToolHandlers(
      daemon,
      boundSession,
      async () => {
        throw terminal();
      },
      revive,
    );

    const result = (await tools.join({})) as { session: SessionView; ready: boolean };

    expect(revive).toHaveBeenCalledTimes(1);
    expect(daemon.setSessionStatus).toHaveBeenCalledWith('revived', 'idle');
    expect(daemon.claimInbox).toHaveBeenCalledWith(
      'revived',
      expect.objectContaining({ bridgeInstanceId: 'gui-join' }),
    );
    expect(result.ready).toBe(true);
  });

  it('refuses a successor outside the bound project and leaves other errors alone', async () => {
    const daemon = client();
    const elsewhere = createMcpToolHandlers(
      daemon,
      boundSession,
      async () => {
        throw terminal();
      },
      async () => ({ ...boundSession, id: 'revived', projectId: 'project-2' }),
    );
    await expect(elsewhere.join({})).rejects.toMatchObject({ code: 'BOUND_PROJECT_MISMATCH' });

    const offline = new McpDaemonError('BOUND_SESSION_OFFLINE', 'offline', 409);
    const revive = vi.fn();
    const tools = createMcpToolHandlers(
      daemon,
      boundSession,
      async () => {
        throw offline;
      },
      revive,
    );
    await expect(tools.join({})).rejects.toBe(offline);
    expect(revive).not.toHaveBeenCalled();
  });
});
