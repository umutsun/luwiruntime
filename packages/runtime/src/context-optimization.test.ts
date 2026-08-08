import { describe, expect, it } from 'vitest';

import type {
  CapabilityPackage,
  ContextContribution,
  ContextSource,
  OptimizationProposal,
} from '@luwi/protocol';

import {
  analyzeStructuralContext,
  createOptimizationProposals,
  evaluateOptimization,
  transitionOptimizationProposal,
} from './context-optimization.js';

const now = '2026-07-30T12:00:00.000Z';

function source(id: string, overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    id,
    projectId: 'project-1',
    agentId: 'codex',
    sourceType: 'instruction',
    path: `C:/repo/${id}.md`,
    byteCount: 16_000,
    lineCount: 300,
    hash: 'a'.repeat(64),
    loadingScope: 'project',
    loadingMode: 'automatic',
    managementMode: 'observed',
    estimatedTokenCount: 4000,
    estimationSource: 'estimated',
    estimationMethod: 'generic-character-estimate',
    measuredAt: now,
    ...overrides,
  };
}

function contribution(
  id: string,
  overrides: Partial<ContextContribution> = {},
): ContextContribution {
  return {
    id,
    projectId: 'project-1',
    agentId: 'codex',
    sessionId: `session-${id}`,
    contextSourceId: 'source-1',
    loadingMode: 'always',
    assigned: true,
    effective: true,
    loaded: true,
    invoked: false,
    source: 'session-reported',
    confidence: 'medium',
    observedAt: now,
    evidenceIds: [`event-${id}`],
    metadata: {},
    ...overrides,
  };
}

function capability(id: string, overrides: Partial<CapabilityPackage> = {}): CapabilityPackage {
  return {
    id,
    kind: 'skill',
    name: id,
    scope: 'global',
    source: 'bundled',
    checksum: 'c'.repeat(64),
    compatibleAgentKinds: [],
    requiredCapabilityIds: [],
    requiredMcpIds: [],
    enabled: true,
    manifest: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('context optimization policy', () => {
  it('detects structural oversized and exact-duplicate findings with evidence windows', () => {
    const findings = analyzeStructuralContext({
      projectId: 'project-1',
      agentId: 'codex',
      contextSources: [source('source-1'), source('source-2')],
      contributions: [contribution('1'), contribution('2'), contribution('3')],
      now,
      minimumSessions: 3,
      oversizedTokenThreshold: 3000,
    });

    expect(findings.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        'oversized-always-loaded-source',
        'exact-duplicate-content',
        'capability-loaded-not-observed-invoked',
      ]),
    );
    expect(findings.every(({ evidenceWindow }) => evidenceWindow.sessionCount === 3)).toBe(true);
    expect(findings.find(({ kind }) => kind.includes('not-observed'))?.summary).not.toMatch(
      /\bunused\b/i,
    );
  });

  it('does not make usage-based findings before the minimum session window', () => {
    const findings = analyzeStructuralContext({
      projectId: 'project-1',
      agentId: 'codex',
      contextSources: [source('source-1')],
      contributions: [contribution('1')],
      now,
      minimumSessions: 3,
      oversizedTokenThreshold: 3000,
    });

    expect(findings.map(({ kind }) => kind)).toContain('oversized-always-loaded-source');
    expect(findings.map(({ kind }) => kind)).not.toContain(
      'capability-loaded-not-observed-invoked',
    );
  });

  it('requires explicit cross-project evidence for project-only global use and broad MCP use', () => {
    const contributions = [
      contribution('1', {
        capabilityId: 'global-project-only',
        projectId: 'project-1',
        loaded: true,
        invoked: true,
      }),
      contribution('2', {
        capabilityId: 'global-project-only',
        projectId: 'project-2',
        loaded: false,
        invoked: false,
      }),
      contribution('3', {
        capabilityId: 'broad-mcp',
        loaded: true,
        invoked: true,
        metadata: { toolName: 'status' },
      }),
      contribution('4', {
        capabilityId: 'broad-mcp',
        loaded: true,
        invoked: false,
      }),
    ];
    const findings = analyzeStructuralContext({
      projectId: 'project-1',
      agentId: 'codex',
      contextSources: [source('source-1')],
      contributions,
      allContributions: contributions,
      capabilities: [
        capability('global-project-only'),
        capability('broad-mcp', {
          kind: 'mcp',
          manifest: { tools: Array.from({ length: 40 }, (_, index) => `tool-${index}`) },
        }),
      ],
      now,
      minimumSessions: 1,
      oversizedTokenThreshold: 3000,
    });

    expect(findings.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['global-source-single-project', 'mcp-broad-low-observed-use']),
    );

    const unknownOnly = analyzeStructuralContext({
      projectId: 'project-1',
      agentId: 'codex',
      contextSources: [source('source-1')],
      contributions: [
        contribution('unknown', {
          capabilityId: 'global-project-only',
          loaded: 'unknown',
          invoked: 'unknown',
        }),
      ],
      capabilities: [capability('global-project-only')],
      now,
      minimumSessions: 1,
      oversizedTokenThreshold: 3000,
    });
    expect(unknownOnly.map(({ kind }) => kind)).not.toContain('global-source-single-project');
  });

  it('creates deterministic proposals and enforces the proposal state machine', () => {
    const findings = analyzeStructuralContext({
      projectId: 'project-1',
      agentId: 'codex',
      contextSources: [source('source-1')],
      contributions: [contribution('1'), contribution('2'), contribution('3')],
      now,
      minimumSessions: 3,
      oversizedTokenThreshold: 3000,
    });
    const proposal = createOptimizationProposals(findings, now)[0]!;
    expect(proposal).toMatchObject({
      projectId: 'project-1',
      state: 'ready',
      proposedActions: [{ kind: 'convert-source-to-reference-only', contextSourceId: 'source-1' }],
    });
    expect(transitionOptimizationProposal(proposal, 'accepted', now).state).toBe('accepted');
    expect(() => transitionOptimizationProposal(proposal, 'verified', now)).toThrow(/transition/i);
  });

  it('evaluates observed footprint reduction without claiming model-quality causation', () => {
    const proposal: OptimizationProposal = {
      id: 'proposal-1',
      projectId: 'project-1',
      findingIds: ['finding-1'],
      title: 'Reduce always-loaded context',
      summary: 'Structural context proposal.',
      proposedActions: [{ kind: 'convert-source-to-reference-only', contextSourceId: 'source-1' }],
      evidenceWindow: {
        startedAt: '2026-07-29T00:00:00.000Z',
        endedAt: now,
        sessionCount: 3,
      },
      confidence: 'medium',
      state: 'evaluating',
      createdAt: now,
      updatedAt: now,
    };
    const evaluation = evaluateOptimization({
      proposal,
      baseline: { sessionCount: 3, usageRecordCount: 3, estimatedContextTokens: 5000 },
      postChange: { sessionCount: 3, usageRecordCount: 3, estimatedContextTokens: 3500 },
      minimumPostSessions: 3,
      startedAt: now,
      completedAt: now,
    });

    expect(evaluation).toMatchObject({
      state: 'verified',
      causalClaim: false,
      summary: 'Observed context footprint decreased after the change.',
    });
    expect(evaluation.summary).not.toMatch(/made the agent better/i);
  });
});
