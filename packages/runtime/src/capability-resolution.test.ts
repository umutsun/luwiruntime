import type { CapabilityPackage, CapabilityProfile, ContextFootprint } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { compileEffectiveConfiguration, type CapabilityLayer } from './capability-resolution.js';

const timestamp = '2026-07-29T20:00:00.000Z';
const footprint: ContextFootprint = {
  projectId: 'project-1',
  agentId: 'codex-main',
  source: 'estimated',
  method: 'generic-character-estimate',
  totalBytes: 0,
  totalLines: 0,
  estimatedTokens: 0,
  categories: {},
  exactDuplicateGroups: [],
  measuredAt: timestamp,
};

function capability(id: string, overrides: Partial<CapabilityPackage> = {}): CapabilityPackage {
  return {
    id,
    kind: 'skill',
    name: id,
    scope: 'global',
    source: 'luwi-global',
    checksum: 'a'.repeat(64),
    compatibleAgentKinds: ['codex'],
    requiredCapabilityIds: [],
    requiredMcpIds: [],
    enabled: true,
    manifest: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('effective capability compilation', () => {
  it('applies deterministic precedence and explicit disable tombstones with provenance', () => {
    const layers: CapabilityLayer[] = [
      {
        precedence: 4,
        sourceScope: 'global-capability',
        sourceId: 'global',
        sourceFile: 'C:/home/.luwi/manifest.json',
        capabilities: [{ capabilityId: 'typescript-development', enabled: true }],
        settings: { review: { strict: false }, model: 'global' },
      },
      {
        precedence: 7,
        sourceScope: 'project-capability',
        sourceId: 'project-1',
        sourceFile: 'C:/project/.luwi/manifest.json',
        capabilities: [{ capabilityId: 'typescript-development', enabled: false }],
        settings: { review: { strict: true } },
      },
      {
        precedence: 8,
        sourceScope: 'project-agent',
        sourceId: 'project-1:codex-main',
        capabilities: [{ capabilityId: 'git-safety', enabled: true }],
        settings: { model: 'project' },
      },
    ];

    const result = compileEffectiveConfiguration({
      projectId: 'project-1',
      agentId: 'codex-main',
      agentKind: 'codex',
      catalog: [capability('typescript-development'), capability('git-safety')],
      profiles: [],
      layers,
      footprint,
    });

    expect(result.capabilities.map(({ id }) => id)).toEqual(['git-safety']);
    expect(result.settings).toEqual({ model: 'project', review: { strict: true } });
    expect(result.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'settings.model',
          sourceScope: 'project-agent',
          precedence: 8,
        }),
        expect.objectContaining({
          key: 'capability.typescript-development',
          sourceScope: 'project-capability',
          precedence: 7,
          overrideReason: 'Explicit disable tombstone',
        }),
      ]),
    );
  });

  it('expands profiles and reports missing dependencies and incompatible kinds', () => {
    const profile: CapabilityProfile = {
      id: 'backend',
      name: 'Backend',
      scope: 'global',
      capabilityIds: ['redis-development', 'claude-only'],
      policyIds: [],
      disabledCapabilityIds: [],
      adapterSettings: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const result = compileEffectiveConfiguration({
      projectId: 'project-1',
      agentId: 'codex-main',
      agentKind: 'codex',
      catalog: [
        capability('redis-development', { requiredCapabilityIds: ['git-safety'] }),
        capability('claude-only', { compatibleAgentKinds: ['claude-code'] }),
      ],
      profiles: [profile],
      layers: [
        {
          precedence: 3,
          sourceScope: 'global-profile',
          sourceId: 'backend',
          profileIds: ['backend'],
          capabilities: [],
          settings: {},
        },
      ],
      footprint,
    });

    expect(result.valid).toBe(false);
    expect(result.profileIds).toEqual(['backend']);
    expect(result.missingDependencies).toEqual(['git-safety']);
    expect(result.unsupportedCapabilities).toEqual(['claude-only']);
    expect(result.conflicts.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['CAPABILITY_DEPENDENCY_MISSING', 'CAPABILITY_INCOMPATIBLE']),
    );
  });

  it('rejects ambiguous versions rather than depending on input order', () => {
    const result = compileEffectiveConfiguration({
      projectId: 'project-1',
      agentId: 'codex-main',
      agentKind: 'codex',
      catalog: [
        capability('redis-development', { version: '1.0.0' }),
        capability('redis-development', { version: '2.0.0', checksum: 'b'.repeat(64) }),
      ],
      profiles: [],
      layers: [
        {
          precedence: 7,
          sourceScope: 'project-capability',
          sourceId: 'project-1',
          capabilities: [{ capabilityId: 'redis-development', enabled: true }],
          settings: {},
        },
      ],
      footprint,
    });
    expect(result.valid).toBe(false);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ code: 'CAPABILITY_CONFLICT', capabilityId: 'redis-development' }),
    ]);
  });

  it('reports capability kinds that the selected native adapter cannot represent', () => {
    const result = compileEffectiveConfiguration({
      projectId: 'project-1',
      agentId: 'codex-main',
      agentKind: 'codex',
      catalog: [capability('native-plugin', { kind: 'plugin' })],
      profiles: [],
      layers: [
        {
          precedence: 7,
          sourceScope: 'project-capability',
          sourceId: 'project-1',
          capabilities: [{ capabilityId: 'native-plugin', enabled: true }],
          settings: {},
        },
      ],
      footprint,
      unsupportedCapabilityKinds: ['plugin'],
      adapterCapabilitySupport: { plugin: 'unsupported' },
    });

    expect(result.valid).toBe(false);
    expect(result.unsupportedCapabilities).toEqual(['native-plugin']);
    expect(result.nativeCapabilitySupport).toEqual([
      {
        capabilityId: 'native-plugin',
        capabilityKind: 'plugin',
        supportLevel: 'unsupported',
      },
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        code: 'CAPABILITY_INCOMPATIBLE',
        capabilityId: 'native-plugin',
      }),
    ]);
  });

  it('rejects assigned disabled packages and treats them as unavailable dependencies', () => {
    const result = compileEffectiveConfiguration({
      projectId: 'project-1',
      agentId: 'codex-main',
      agentKind: 'codex',
      catalog: [
        capability('disabled-base', { enabled: false }),
        capability('dependent', { requiredCapabilityIds: ['disabled-base'] }),
      ],
      profiles: [],
      layers: [
        {
          precedence: 7,
          sourceScope: 'project-capability',
          sourceId: 'project-1',
          capabilities: [
            { capabilityId: 'disabled-base', enabled: true },
            { capabilityId: 'dependent', enabled: true },
          ],
          settings: {},
        },
      ],
      footprint,
    });

    expect(result.valid).toBe(false);
    expect(result.capabilities.map(({ id }) => id)).toEqual(['dependent']);
    expect(result.unsupportedCapabilities).toContain('disabled-base');
    expect(result.missingDependencies).toContain('disabled-base');
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'CAPABILITY_CONFLICT',
          capabilityId: 'disabled-base',
        }),
        expect.objectContaining({
          code: 'CAPABILITY_DEPENDENCY_MISSING',
          capabilityId: 'dependent',
          relatedCapabilityId: 'disabled-base',
        }),
      ]),
    );
  });
});
