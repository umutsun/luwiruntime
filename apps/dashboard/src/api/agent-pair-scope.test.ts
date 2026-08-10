import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { agentPairResourcesForEvent, loadAgentPairScope } from './agent-pair-scope.js';
import type { DaemonClient, ResourceResult } from './client.js';

const footprint = {
  projectId: 'proj-1',
  agentId: 'agent-1',
  source: 'estimated',
  method: 'generic-character-estimate',
  totalBytes: 4_200,
  totalLines: 120,
  estimatedTokens: 602,
  categories: {
    skill: { bytes: 3_000, lines: 90, estimatedTokens: 480, sourceCount: 2 },
    mcp: { bytes: 1_200, lines: 30, estimatedTokens: 122, sourceCount: 1 },
  },
  exactDuplicateGroups: [['context:a', 'context:b']],
  measuredAt: '2026-08-10T00:00:00.000Z',
};

const effective = {
  projectId: 'proj-1',
  agentId: 'agent-1',
  agentKind: 'codex',
  valid: false,
  capabilities: [
    {
      id: 'cap-review',
      kind: 'skill',
      name: 'Code review',
      scope: 'global',
      source: 'luwi-global',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {},
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    },
  ],
  profileIds: ['profile-reviewer'],
  settings: {},
  provenance: [
    {
      key: 'model',
      sourceScope: 'global-profile',
      precedence: 3,
      overrideReason: 'profile default',
    },
  ],
  conflicts: [
    {
      code: 'CAPABILITY_INCOMPATIBLE',
      message: 'Not supported by this adapter.',
      capabilityId: 'cap-migrate',
    },
  ],
  missingDependencies: [],
  unsupportedCapabilities: ['cap-migrate'],
  nativeCapabilitySupport: [
    {
      capabilityId: 'cap-review',
      capabilityKind: 'skill',
      supportLevel: 'full',
      policyMode: 'enforced-native',
    },
  ],
  estimatedContextFootprint: footprint,
};

const summary = {
  projectId: 'proj-1',
  agentId: 'agent-1',
  contributionCount: 6,
  assignedCount: 4,
  effectiveCount: 3,
  observedLoadedCount: 2,
  observedInvokedCount: 1,
  unknownLoadedCount: 2,
  sourceComposition: {},
  measuredAt: '2026-08-10T00:00:00.000Z',
};

function stubClient(bodies: Record<string, unknown>) {
  const paths: string[] = [];
  const client: DaemonClient = {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<ResourceResult<T>> {
      paths.push(path);
      const key = Object.keys(bodies).find((prefix) => path.startsWith(prefix));
      if (key === undefined) return { state: 'unavailable', reason: 'transport' };
      return {
        state: 'ready',
        data: schema.parse(bodies[key]),
        httpStatus: 200,
        receivedAt: '2026-08-10T00:00:00.000Z',
      };
    },
  };
  return { client, paths };
}

const allReady = {
  '/api/v1/projects/proj-1/agents/agent-1/effective-config': effective,
  '/api/v1/projects/proj-1/agents/agent-1/context-footprint': footprint,
  '/api/v1/context/summary': summary,
};

describe('loadAgentPairScope', () => {
  it('maps an invalid effective configuration without softening it', async () => {
    const { client } = stubClient(allReady);

    const result = await loadAgentPairScope(client, 'proj-1', 'agent-1', ['effectiveConfig']);

    expect(result.effectiveConfig).toMatchObject({
      state: 'ready',
      data: {
        valid: false,
        agentKind: 'codex',
        unsupportedCapabilities: ['cap-migrate'],
        profileIds: ['profile-reviewer'],
        provenanceCount: 1,
        estimatedTokens: 602,
        conflicts: [{ code: 'CAPABILITY_INCOMPATIBLE', capabilityId: 'cap-migrate' }],
      },
    });
  });

  it('orders footprint categories by weight and keeps duplicate groups intact', async () => {
    const { client } = stubClient(allReady);

    const result = await loadAgentPairScope(client, 'proj-1', 'agent-1', ['contextFootprint']);
    const data =
      result.contextFootprint?.state === 'ready' ? result.contextFootprint.data : undefined;

    expect(data?.categories.map((category) => category.name)).toEqual(['skill', 'mcp']);
    expect(data?.exactDuplicateGroups).toEqual([['context:a', 'context:b']]);
  });

  it('keeps the pair-scoped context counts independent of one another', async () => {
    const { client } = stubClient(allReady);

    const result = await loadAgentPairScope(client, 'proj-1', 'agent-1', ['contextSummary']);

    expect(result.contextSummary).toMatchObject({
      data: { assignedCount: 4, effectiveCount: 3, observedLoadedCount: 2, unknownLoadedCount: 2 },
    });
  });

  it('encodes both ids so neither can escape its path segment', async () => {
    const { client, paths } = stubClient({});

    await loadAgentPairScope(client, '../health', 'a/b', ['effectiveConfig', 'contextSummary']);

    expect(paths).toContain('/api/v1/projects/..%2Fhealth/agents/a%2Fb/effective-config');
    expect(paths).toContain('/api/v1/context/summary?projectId=..%2Fhealth&agentId=a%2Fb');
  });

  it('keeps siblings readable when one pair read fails', async () => {
    const { client } = stubClient({
      '/api/v1/projects/proj-1/agents/agent-1/effective-config': effective,
    });

    const result = await loadAgentPairScope(client, 'proj-1', 'agent-1', [
      'effectiveConfig',
      'contextSummary',
      'contextFootprint',
    ]);

    expect(result.effectiveConfig?.state).toBe('ready');
    expect(result.contextSummary).toEqual({ state: 'unavailable' });
    expect(result.contextFootprint).toEqual({ state: 'unavailable' });
  });

  it('forwards the abort signal to every pair read', async () => {
    const controller = new AbortController();
    const get = vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'transport' });

    await loadAgentPairScope(
      { get } as unknown as DaemonClient,
      'proj-1',
      'agent-1',
      agentPairKeys(),
      { signal: controller.signal },
    );

    expect(get).toHaveBeenCalledTimes(3);
    for (const call of get.mock.calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });
});

function agentPairKeys() {
  return ['effectiveConfig', 'contextSummary', 'contextFootprint'] as const;
}

describe('agentPairResourcesForEvent', () => {
  it('re-resolves the effective configuration when what is bound changes', () => {
    for (const type of [
      'capability.created',
      'profile.updated',
      'project.agent.bound',
      'agent.definition.updated',
    ]) {
      expect(agentPairResourcesForEvent(type)).toEqual(['effectiveConfig']);
    }
  });

  it('refreshes both context reads together, because they measure the same thing', () => {
    expect(agentPairResourcesForEvent('context.source.detected')).toEqual([
      'contextSummary',
      'contextFootprint',
    ]);
  });

  it('ignores families no pair panel renders', () => {
    for (const type of ['git.observed', 'message.requested', 'usage.reported']) {
      expect(agentPairResourcesForEvent(type)).toEqual([]);
    }
  });
});
