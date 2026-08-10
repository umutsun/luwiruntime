import type { SessionView } from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createMcpToolHandlers, type McpDaemonClient } from './index.js';

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
    });
    expect(daemon.askAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: 'source' }),
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
