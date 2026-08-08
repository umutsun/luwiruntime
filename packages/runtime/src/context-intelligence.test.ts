import { describe, expect, it } from 'vitest';

import type { ContextContribution, ContextSource } from '@luwi/protocol';

import {
  contextContributionFromStaticSource,
  summarizeContextContributions,
} from './context-intelligence.js';

const measuredAt = '2026-07-30T00:00:00.000Z';

const source: ContextSource = {
  id: 'source-1',
  projectId: 'project-1',
  agentId: 'codex',
  sourceType: 'instruction',
  path: 'C:/repo/AGENTS.md',
  byteCount: 4000,
  lineCount: 100,
  hash: 'a'.repeat(64),
  loadingScope: 'project',
  loadingMode: 'automatic',
  managementMode: 'observed',
  estimatedTokenCount: 1000,
  estimationSource: 'estimated',
  estimationMethod: 'generic-character-estimate',
  measuredAt,
};

describe('context intelligence', () => {
  it('turns a static Phase 3 source into an estimated contribution without claiming load', () => {
    expect(
      contextContributionFromStaticSource(source, {
        sessionId: 'session-1',
        assigned: true,
        effective: true,
      }),
    ).toMatchObject({
      loadingMode: 'always',
      assigned: true,
      effective: true,
      loaded: 'unknown',
      invoked: 'unknown',
      estimatedBytes: 4000,
      estimatedTokens: 1000,
      source: 'estimated',
      method: 'generic-character-estimate',
    });
  });

  it('keeps assigned, effective, loaded, and invoked counts distinct', () => {
    const contribution = (
      id: string,
      values: Partial<ContextContribution>,
    ): ContextContribution => ({
      id,
      projectId: 'project-1',
      agentId: 'codex',
      contextSourceId: `source-${id}`,
      loadingMode: 'conditional',
      assigned: false,
      effective: false,
      loaded: 'unknown',
      invoked: 'unknown',
      source: 'session-reported',
      confidence: 'medium',
      observedAt: measuredAt,
      evidenceIds: [],
      metadata: {},
      ...values,
    });

    const summary = summarizeContextContributions([
      contribution('one', {
        assigned: true,
        effective: true,
        loaded: true,
        invoked: false,
        reportedTokens: 500,
      }),
      contribution('two', {
        assigned: true,
        effective: false,
        loaded: 'unknown',
        invoked: true,
        estimatedBytes: 1000,
        estimatedTokens: 250,
        source: 'estimated',
      }),
    ]);

    expect(summary).toMatchObject({
      assignedCount: 2,
      effectiveCount: 1,
      observedLoadedCount: 1,
      observedInvokedCount: 1,
      unknownLoadedCount: 1,
      staticEstimatedBytes: 1000,
      staticEstimatedTokens: 250,
      reportedContextTokens: 500,
      sourceComposition: { 'session-reported': 1, estimated: 1 },
    });
  });
});
