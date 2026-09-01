import { describe, expect, it } from 'vitest';

import { runCli, type CliDependencies, type HttpResponseLike } from './cli.js';

function response(body: unknown, status = 200): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function dependencies(
  handler: CliDependencies['fetch'],
  output: { value: string },
): Partial<CliDependencies> {
  return {
    fetch: handler,
    stdout: { write: (text) => (output.value += text) },
  };
}

describe('Phase 4 intelligence CLI', () => {
  it('ingests labelled usage through the daemon', async () => {
    const requested: Array<{ url: string; method?: string; body?: unknown }> = [];
    const output = { value: '' };
    const record = {
      id: 'usage-1',
      projectId: 'project-1',
      agentId: 'codex-sim',
      sessionId: 'session-1',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      source: 'agent-exact',
      confidence: 'exact',
      observedAt: '2026-07-30T10:00:00.000Z',
      metadata: {},
      createdAt: '2026-07-30T10:00:00.000Z',
    };

    await runCli(
      [
        'usage',
        'ingest',
        '--body',
        JSON.stringify({
          projectId: record.projectId,
          agentId: record.agentId,
          sessionId: record.sessionId,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          source: 'agent-exact',
          confidence: 'exact',
          observedAt: record.observedAt,
        }),
      ],
      dependencies(async (url, init) => {
        requested.push({
          url,
          method: init?.method,
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
        });
        return response(record, 201);
      }, output),
    );

    expect(requested).toEqual([
      {
        url: 'http://127.0.0.1:4782/api/v1/usage',
        method: 'POST',
        body: expect.objectContaining({ source: 'agent-exact', totalTokens: 15 }),
      },
    ]);
    expect(output.value).toContain('"measurementLabel": "exact"');
  });

  it('queries context intelligence and preserves unknown observations', async () => {
    const output = { value: '' };
    const body = {
      summary: {
        projectId: 'project-1',
        agentId: 'codex-sim',
        contributionCount: 1,
        assignedCount: 1,
        effectiveCount: 1,
        observedLoadedCount: 0,
        observedInvokedCount: 0,
        unknownLoadedCount: 1,
        sourceComposition: { 'effective-config': 1 },
        measuredAt: '2026-07-30T10:00:00.000Z',
      },
      contributions: [
        {
          id: 'contribution-1',
          projectId: 'project-1',
          agentId: 'codex-sim',
          contextSourceId: 'agents-root',
          loadingMode: 'always',
          assigned: true,
          effective: true,
          loaded: 'unknown',
          invoked: 'unknown',
          source: 'effective-config',
          confidence: 'medium',
          observedAt: '2026-07-30T10:00:00.000Z',
          evidenceIds: ['config-1'],
          metadata: {},
        },
      ],
      findings: [],
    };

    await runCli(
      ['context', 'intelligence', '--project', 'project-1', '--agent', 'codex-sim'],
      dependencies(async (url) => {
        expect(url).toBe(
          'http://127.0.0.1:4782/api/v1/projects/project-1/agents/codex-sim/context-intelligence',
        );
        return response(body);
      }, output),
    );

    expect(output.value).toContain('"loaded": "unknown"');
    expect(output.value).toContain('"observationLabel": "unknown"');
  });

  it('uses read-only Git and graph routes for inspection commands', async () => {
    const requested: string[] = [];
    const output = { value: '' };
    const node = {
      id: 'project:project-1',
      kind: 'project',
      entityId: 'project-1',
      projectId: 'project-1',
      observedAt: '2026-07-30T10:00:00.000Z',
      provenance: 'project-record',
      confidence: 'high',
      evidenceIds: ['project-1'],
      metadata: {},
    };

    await runCli(
      ['graph', 'neighbors', 'project', 'project-1', '--direction', 'out', '--limit', '5'],
      dependencies(async (url) => {
        requested.push(url);
        return response({ node, edges: [], nodes: [], truncated: false });
      }, output),
    );

    expect(requested[0]).toBe(
      'http://127.0.0.1:4782/api/v1/graph/nodes/project/project-1/out?limit=5',
    );
    expect(output.value).toContain('"provenance": "project-record"');
  });

  it('marks an empty Git scan POST as JSON so the daemon accepts the origin-less CLI request', async () => {
    const output = { value: '' };
    const observedAt = '2026-07-30T10:00:00.000Z';

    await runCli(
      ['git', 'scan', '--project', 'project-1'],
      dependencies(async (url, init) => {
        expect(url).toBe('http://127.0.0.1:4782/api/v1/projects/project-1/git/scan');
        expect(init).toEqual({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        return response({
          id: 'git-1',
          projectId: 'project-1',
          repositoryRoot: 'C:/sandbox',
          branch: 'main',
          headSha: 'a'.repeat(40),
          clean: true,
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 0,
          branches: ['main'],
          tags: [],
          worktrees: [],
          recentCommits: [],
          observedAt,
          repositoryStateHash: 'b'.repeat(64),
        });
      }, output),
    );

    expect(output.value).toContain('"repositoryRoot": "C:/sandbox"');
  });

  it('accepts a proposal without applying configuration and creates a plan separately', async () => {
    const requested: Array<{ url: string; body?: unknown }> = [];
    const output = { value: '' };
    const proposal = {
      id: 'proposal-1',
      projectId: 'project-1',
      findingIds: ['finding-1'],
      title: 'Use conditional loading',
      summary: 'A structural recommendation.',
      proposedActions: [
        {
          kind: 'change-loading-mode',
          contextSourceId: 'agents-root',
          loadingMode: 'conditional',
        },
      ],
      evidenceWindow: {
        startedAt: '2026-07-29T10:00:00.000Z',
        endedAt: '2026-07-30T10:00:00.000Z',
        sessionCount: 3,
      },
      confidence: 'medium',
      state: 'accepted',
      createdAt: '2026-07-30T10:00:00.000Z',
      updatedAt: '2026-07-30T10:00:00.000Z',
    };

    await runCli(
      ['optimize', 'accept', 'proposal-1'],
      dependencies(async (url, init) => {
        requested.push({
          url,
          body: init?.body === undefined ? undefined : JSON.parse(init.body),
        });
        return response(proposal);
      }, output),
    );

    expect(requested).toEqual([
      {
        url: 'http://127.0.0.1:4782/api/v1/optimization/proposals/proposal-1/accept',
        body: { accepted: true },
      },
    ]);
    expect(output.value).toContain('"state": "accepted"');
    expect(output.value).toContain('"configurationApplied": false');
  });
});
