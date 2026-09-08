import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentDefinition,
  CapabilityBinding,
  CapabilityPackage,
  CapabilityProfile,
  ProjectAgentBinding,
} from '@luwi/protocol';
import type { ControlPlaneRepository } from '@luwi/redis';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanonicalStore } from './canonical-store.js';
import { createControlPlaneService } from './control-plane-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function memoryRepository(): {
  repository: ControlPlaneRepository;
  agents: AgentDefinition[];
  bindings: ProjectAgentBinding[];
  capabilities: CapabilityPackage[];
  capabilityBindings: CapabilityBinding[];
  profiles: CapabilityProfile[];
} {
  const agents: AgentDefinition[] = [];
  const bindings: ProjectAgentBinding[] = [];
  const capabilities: CapabilityPackage[] = [];
  const capabilityBindings: CapabilityBinding[] = [];
  const profiles: CapabilityProfile[] = [];
  const replace = <Value extends { id: string }>(items: Value[], value: Value): void => {
    const index = items.findIndex(({ id }) => id === value.id);
    if (index === -1) items.push(value);
    else items[index] = value;
  };
  const repository = {
    appendEvent: async () => undefined,
    putAgentDefinition: async (_mode: string, value: AgentDefinition) => replace(agents, value),
    getAgentDefinition: async (id: string) => agents.find(({ id: item }) => item === id) ?? null,
    listAgentDefinitions: async () => [...agents],
    putProjectAgentBinding: async (_mode: string, value: ProjectAgentBinding) =>
      replace(bindings, value),
    deleteProjectAgentBinding: async (value: ProjectAgentBinding) => {
      const index = bindings.findIndex(({ id }) => id === value.id);
      if (index >= 0) bindings.splice(index, 1);
    },
    getProjectAgentBinding: async (id: string) =>
      bindings.find(({ id: item }) => item === id) ?? null,
    listProjectAgentBindings: async (projectId: string) =>
      bindings.filter((binding) => binding.projectId === projectId),
    putCapability: async (_mode: string, value: CapabilityPackage) => replace(capabilities, value),
    getCapability: async (id: string) => capabilities.find(({ id: item }) => item === id) ?? null,
    listCapabilities: async () => [...capabilities],
    putCapabilityBinding: async (_mode: string, value: CapabilityBinding) =>
      replace(capabilityBindings, value),
    deleteCapabilityBinding: async (value: CapabilityBinding) => {
      const index = capabilityBindings.findIndex(({ id }) => id === value.id);
      if (index >= 0) capabilityBindings.splice(index, 1);
    },
    listCapabilityBindings: async () => [...capabilityBindings],
    putProfile: async (_mode: string, value: CapabilityProfile) => replace(profiles, value),
    getProfile: async (id: string) => profiles.find(({ id: item }) => item === id) ?? null,
    listProfiles: async () => [...profiles],
    getContextFootprint: async () => null,
  } as unknown as ControlPlaneRepository;
  return { repository, agents, bindings, capabilities, capabilityBindings, profiles };
}

async function serviceFixture(
  overrides: Partial<Parameters<typeof createControlPlaneService>[0]> = {},
) {
  const globalRoot = await mkdtemp(join(tmpdir(), 'luwi-control-global-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'luwi-control-project-'));
  roots.push(globalRoot, projectRoot);
  const memory = memoryRepository();
  const canonicalStore = createCanonicalStore({
    globalRoot,
    now: () => new Date('2026-07-29T12:00:00.000Z'),
  });
  const service = createControlPlaneService({
    repository: memory.repository,
    canonicalStore,
    workspaceId: 'local',
    homeDirectory: join(globalRoot, 'fake-home'),
    projects: {
      get: async (projectId) =>
        projectId === 'project-1'
          ? {
              id: projectId,
              name: 'Fixture',
              localPath: projectRoot,
              canonicalPath: projectRoot,
              createdAt: '2026-07-29T12:00:00.000Z',
              updatedAt: '2026-07-29T12:00:00.000Z',
            }
          : null,
      list: async () => [
        {
          id: 'project-1',
          name: 'Fixture',
          localPath: projectRoot,
          canonicalPath: projectRoot,
          createdAt: '2026-07-29T12:00:00.000Z',
          updatedAt: '2026-07-29T12:00:00.000Z',
        },
      ],
    },
    createId: (() => {
      let index = 0;
      return () => `generated-${String(++index)}`;
    })(),
    now: () => new Date('2026-07-29T12:00:00.000Z'),
    ...overrides,
  });
  return { ...memory, service, canonicalStore, globalRoot, projectRoot };
}

describe('control-plane service', () => {
  it('projects observed native skills with explicit provenance and bounded diagnostics', async () => {
    const scannedRoots: unknown[] = [];
    const { service, capabilities, projectRoot, globalRoot } = await serviceFixture({
      capabilityRoots: ['C:/custom/skills'],
      capabilityObserver: {
        scan: async (roots) => {
          scannedRoots.push(...roots);
          return {
            capabilities: [
              {
                id: 'observed:1234567890abcdef12345678',
                kind: 'skill',
                name: 'Review',
                scope: 'global',
                source: 'agent-native',
                path: 'C:/native/review',
                checksum: 'a'.repeat(64),
                compatibleAgentKinds: ['claude-code'],
                manifest: {
                  managementMode: 'observed',
                  description: 'Review changes.',
                  observation: {
                    adapterId: 'claude-code',
                    root: 'C:/native',
                    manifestPath: 'C:/native/review/SKILL.md',
                    observedAt: '2026-08-24T12:00:00.000Z',
                  },
                },
              },
            ],
            diagnostics: {
              rootsScanned: 1,
              rootsUnavailable: 6,
              malformedManifests: 2,
              ignoredEntries: 3,
              truncated: false,
            },
          };
        },
      },
    });

    const result = await service.scanCapabilities();

    expect(scannedRoots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(globalRoot, 'fake-home', '.claude', 'skills'),
          adapterId: 'claude-code-native-v1',
          scope: 'global',
        }),
        expect.objectContaining({
          path: join(projectRoot, '.codex', 'skills'),
          adapterId: 'codex-native-v1',
          scope: 'project',
          projectId: 'project-1',
        }),
        expect.objectContaining({
          path: 'C:/custom/skills',
          source: 'local-path',
          compatibleAgentKinds: ['claude-code', 'codex', 'gemini-cli'],
        }),
      ]),
    );
    expect(capabilities).toEqual([
      expect.objectContaining({
        id: 'observed:1234567890abcdef12345678',
        createdAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
      }),
    ]);
    expect(result).toEqual({
      capabilities,
      diagnostics: {
        rootsScanned: 1,
        rootsUnavailable: 6,
        malformedManifests: 2,
        ignoredEntries: 3,
        conflictsSkipped: 0,
        truncated: false,
      },
    });
    await expect(
      service.updateCapability('observed:1234567890abcdef12345678', { name: 'Manual edit' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_OBSERVED_READ_ONLY' });
  });

  it('never overwrites a declared capability when an observed stable ID collides', async () => {
    const fixture = await serviceFixture({
      capabilityObserver: {
        scan: async () => ({
          capabilities: [
            {
              id: 'observed:collision00000000000000',
              kind: 'skill',
              name: 'Observed replacement',
              scope: 'global',
              source: 'agent-native',
              path: 'C:/native/collision',
              checksum: 'b'.repeat(64),
              compatibleAgentKinds: ['codex'],
              manifest: {
                managementMode: 'observed',
                description: 'Must not replace declaration.',
                observation: {
                  adapterId: 'codex',
                  root: 'C:/native',
                  manifestPath: 'C:/native/collision/SKILL.md',
                  observedAt: '2026-08-24T12:00:00.000Z',
                },
              },
            },
          ],
          diagnostics: {
            rootsScanned: 1,
            rootsUnavailable: 0,
            malformedManifests: 0,
            ignoredEntries: 0,
            truncated: false,
          },
        }),
      },
    });
    await fixture.service.createCapability({
      id: 'observed:collision00000000000000',
      kind: 'skill',
      name: 'Declared owner',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {},
    });

    const result = await fixture.service.scanCapabilities();

    expect(fixture.capabilities[0]?.name).toBe('Declared owner');
    expect(result.capabilities).toEqual([]);
    expect(result.diagnostics.conflictsSkipped).toBe(1);
  });

  it('reserves observed provenance for the passive scanner', async () => {
    const { service } = await serviceFixture();

    await expect(
      service.createCapability({
        id: 'forged-observation',
        kind: 'skill',
        name: 'Forged',
        scope: 'global',
        source: 'local-path',
        compatibleAgentKinds: ['codex'],
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
        manifest: { managementMode: 'observed' },
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_PROVENANCE_RESERVED' });
  });

  it('keeps sibling detections when one native command-runner promise rejects', async () => {
    const { service } = await serviceFixture({
      executableResolver: {
        resolve: async (name) => `C:/fake/${name}.exe`,
      },
      commandRunner: {
        run: async (executable) => {
          if (executable.endsWith('/codex.exe')) throw new Error('spawn EINVAL');
          return { exitCode: 0, stdout: '1.2.3\n', stderr: '' };
        },
      },
    });

    const installations = await service.detectAgents();

    expect(installations.map(({ kind }) => kind)).toEqual(['claude-code', 'gemini-cli', 'kimi']);
  });

  it('keeps one detection for its age limit so the agents list never spawns executables per read', async () => {
    let runs = 0;
    let clock = Date.parse('2026-09-03T10:00:00.000Z');
    const { service } = await serviceFixture({
      now: () => new Date(clock),
      executableResolver: { resolve: async (name) => `C:/fake/${name}.exe` },
      commandRunner: {
        run: async () => {
          runs += 1;
          return { exitCode: 0, stdout: '1.2.3\n', stderr: '' };
        },
      },
    });

    const first = await service.detectAgentsCached(60_000);
    expect(first.some(({ detectedVersion }) => detectedVersion === '1.2.3')).toBe(true);
    const runsAfterFirst = runs;
    expect(runsAfterFirst).toBeGreaterThan(0);

    // Within the age limit the same result comes back and nothing is run.
    expect(await service.detectAgentsCached(60_000)).toBe(first);
    expect(runs).toBe(runsAfterFirst);

    clock += 61_000;
    await service.detectAgentsCached(60_000);
    expect(runs).toBeGreaterThan(runsAfterFirst);
  });

  it('registers an agent in canonical filesystem state before projecting it to Redis', async () => {
    const { service, agents, globalRoot } = await serviceFixture();

    const registered = await service.createAgent({
      id: 'codex-main',
      kind: 'codex',
      displayName: 'Codex',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['/fake/.codex'],
      metadata: {},
    });

    expect(agents).toEqual([registered]);
    await expect(
      readFile(join(globalRoot, 'agents', 'codex-main.json'), 'utf8'),
    ).resolves.toContain('"contentHash"');
  });

  it('binds one registered agent without affecting opaque historical session identities', async () => {
    const { service } = await serviceFixture();
    await service.createAgent({
      id: 'claude-main',
      kind: 'claude-code',
      displayName: 'Claude',
      enabled: true,
      adapterId: 'claude-code-native-v1',
      nativeConfigRoots: ['/fake/.claude'],
      metadata: {},
    });

    const binding = await service.bindProjectAgent('project-1', {
      agentId: 'claude-main',
      enabled: true,
      role: 'reviewer',
      profileIds: [],
      capabilityBindingIds: [],
      overrides: {},
    });

    expect(binding).toMatchObject({
      projectId: 'project-1',
      agentId: 'claude-main',
      role: 'reviewer',
    });
  });

  it('compiles deterministic effective configuration with project-agent overrides last', async () => {
    const { service } = await serviceFixture();
    await service.createAgent({
      id: 'codex-main',
      kind: 'codex',
      displayName: 'Codex',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['/fake/.codex'],
      metadata: { settings: { model: 'global', nested: { a: 1 } } },
    });
    await service.createCapability({
      id: 'redis-skill',
      kind: 'skill',
      name: 'Redis',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {},
    });
    const assignment = await service.assignCapability('redis-skill', {
      scope: 'project',
      projectId: 'project-1',
      agentId: 'codex-main',
      enabled: true,
      settings: { nested: { b: 2 } },
    });
    await service.bindProjectAgent('project-1', {
      agentId: 'codex-main',
      enabled: true,
      profileIds: [],
      capabilityBindingIds: [assignment.id],
      overrides: { model: 'project', nested: { c: 3 } },
    });

    const effective = await service.getEffectiveConfiguration('project-1', 'codex-main');

    expect(effective.valid).toBe(true);
    expect(effective.capabilities.map(({ id }) => id)).toEqual(['redis-skill']);
    expect(effective.settings).toEqual({
      model: 'project',
      nested: { a: 1, b: 2, c: 3 },
    });
    expect(effective.provenance.find(({ key }) => key === 'settings.nested.c')).toMatchObject({
      sourceScope: 'project-agent',
      precedence: 8,
    });
  });

  it('honors binding-selected project assignments and profile scope precedence', async () => {
    const { service } = await serviceFixture();
    await service.createAgent({
      id: 'codex-main',
      kind: 'codex',
      displayName: 'Codex',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['/fake/.codex'],
      metadata: {},
    });
    for (const id of ['selected-skill', 'unselected-skill']) {
      await service.createCapability({
        id,
        kind: 'skill',
        name: id,
        scope: 'global',
        source: 'bundled',
        compatibleAgentKinds: ['codex'],
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
        manifest: {},
      });
    }
    await service.createProfile({
      id: 'global-profile',
      name: 'Global',
      scope: 'global',
      capabilityIds: ['selected-skill'],
      policyIds: [],
      disabledCapabilityIds: [],
      adapterSettings: { profileSetting: 'global' },
    });
    const selected = await service.assignCapability('selected-skill', {
      scope: 'project',
      projectId: 'project-1',
      agentId: 'codex-main',
      enabled: false,
      settings: {},
    });
    await service.assignCapability('unselected-skill', {
      scope: 'project',
      projectId: 'project-1',
      agentId: 'codex-main',
      enabled: true,
      settings: {},
    });
    await service.bindProjectAgent('project-1', {
      agentId: 'codex-main',
      enabled: true,
      profileIds: ['global-profile'],
      capabilityBindingIds: [selected.id],
      overrides: {},
    });

    const effective = await service.getEffectiveConfiguration('project-1', 'codex-main');

    expect(effective.capabilities).toEqual([]);
    expect(effective.profileIds).toEqual(['global-profile']);
    expect(effective.provenance.find(({ key }) => key === 'settings.profileSetting')).toMatchObject(
      {
        sourceScope: 'global-profile',
        precedence: 3,
      },
    );
    expect(
      effective.provenance.find(({ key }) => key === 'capability.selected-skill'),
    ).toMatchObject({
      sourceScope: 'project-capability',
      precedence: 7,
      overrideReason: 'Explicit disable tombstone',
    });
    expect(
      effective.provenance.find(({ key }) => key === 'capability.unselected-skill'),
    ).toBeUndefined();
  });

  it('marks adapter-unsupported capability kinds invalid instead of emulating them', async () => {
    const { service } = await serviceFixture();
    await service.createAgent({
      id: 'codex-main',
      kind: 'codex',
      displayName: 'Codex',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['/fake/.codex'],
      metadata: {},
    });
    await service.createCapability({
      id: 'native-plugin',
      kind: 'plugin',
      name: 'Native plugin',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {},
    });
    const assignment = await service.assignCapability('native-plugin', {
      scope: 'project',
      projectId: 'project-1',
      agentId: 'codex-main',
      enabled: true,
      settings: {},
    });
    await service.bindProjectAgent('project-1', {
      agentId: 'codex-main',
      enabled: true,
      profileIds: [],
      capabilityBindingIds: [assignment.id],
      overrides: {},
    });

    const effective = await service.getEffectiveConfiguration('project-1', 'codex-main');

    expect(effective.valid).toBe(false);
    expect(effective.unsupportedCapabilities).toEqual(['native-plugin']);
    expect(effective.conflicts).toContainEqual(
      expect.objectContaining({
        code: 'CAPABILITY_INCOMPATIBLE',
        capabilityId: 'native-plugin',
      }),
    );
  });

  it('rejects a canonical capability root that is redirected outside by a junction', async () => {
    const { service, globalRoot } = await serviceFixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), 'luwi-capability-outside-'));
    roots.push(outsideRoot);
    const capabilityRoot = join(globalRoot, 'capabilities');
    const packageRoot = join(outsideRoot, 'escaped-package');
    await mkdir(packageRoot);
    try {
      await symlink(outsideRoot, capabilityRoot, 'junction');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        return;
      }
      throw error;
    }

    await expect(
      service.createCapability({
        id: 'escaped-capability',
        kind: 'skill',
        name: 'Escaped',
        scope: 'global',
        source: 'local-path',
        path: packageRoot,
        compatibleAgentKinds: [],
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
        manifest: {},
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_PATH_INVALID' });
  });

  it('does not allow a project capability to escape its owning project', async () => {
    const { service } = await serviceFixture();
    await service.createCapability({
      id: 'project-only',
      kind: 'skill',
      name: 'Project only',
      scope: 'project',
      projectId: 'project-1',
      source: 'luwi-project',
      compatibleAgentKinds: [],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {},
    });

    await expect(
      service.assignCapability('project-only', {
        scope: 'global',
        enabled: true,
        settings: {},
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CONFLICT' });
  });

  it('filters capabilities before applying the requested result limit', async () => {
    const { service } = await serviceFixture();
    for (const [id, kind] of [
      ['a-skill', 'skill'],
      ['z-hook', 'hook'],
    ] as const) {
      await service.createCapability({
        id,
        kind,
        name: id,
        scope: 'global',
        source: 'bundled',
        compatibleAgentKinds: [],
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
        manifest: {},
      });
    }

    await expect(service.listCapabilities({ kind: 'hook', limit: 1 })).resolves.toMatchObject([
      { id: 'z-hook' },
    ]);
  });

  it('rebuilds Redis control-plane projections from validated canonical manifests', async () => {
    const fixture = await serviceFixture();
    const { service, agents, bindings, capabilities, capabilityBindings, profiles } = fixture;
    await service.createAgent({
      id: 'codex-rebuild',
      kind: 'codex',
      displayName: 'Codex rebuild',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['/fake/.codex'],
      metadata: {},
    });
    await service.createCapability({
      id: 'rebuild-skill',
      kind: 'skill',
      name: 'Rebuild skill',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {},
    });
    const assignment = await service.assignCapability('rebuild-skill', {
      scope: 'project',
      projectId: 'project-1',
      agentId: 'codex-rebuild',
      enabled: true,
      settings: {},
    });
    await service.createProfile({
      id: 'rebuild-profile',
      name: 'Rebuild profile',
      scope: 'global',
      capabilityIds: ['rebuild-skill'],
      policyIds: [],
      disabledCapabilityIds: [],
      adapterSettings: {},
    });
    await service.bindProjectAgent('project-1', {
      agentId: 'codex-rebuild',
      enabled: true,
      profileIds: ['rebuild-profile'],
      capabilityBindingIds: [assignment.id],
      overrides: {},
    });
    agents.splice(0);
    bindings.splice(0);
    capabilities.splice(0);
    capabilityBindings.splice(0);
    profiles.splice(0);

    await expect(service.reconcileCanonicalState()).resolves.toMatchObject({
      rebuilt: 5,
      removed: 0,
    });
    expect(agents.map(({ id }) => id)).toEqual(['codex-rebuild']);
    expect(bindings.map(({ agentId }) => agentId)).toEqual(['codex-rebuild']);
    expect(capabilities.map(({ id }) => id)).toEqual(['rebuild-skill']);
    expect(capabilityBindings.map(({ capabilityId }) => capabilityId)).toEqual(['rebuild-skill']);
    expect(profiles.map(({ id }) => id)).toEqual(['rebuild-profile']);
  });

  it('applies project manifest defaults at precedence five', async () => {
    const { service, canonicalStore, projectRoot } = await serviceFixture();
    await service.createAgent({
      id: 'codex-project-default',
      kind: 'codex',
      displayName: 'Codex project default',
      enabled: true,
      adapterId: 'codex-native-v1',
      nativeConfigRoots: ['/fake/.codex'],
      metadata: { settings: { model: 'global', approval_policy: 'global' } },
    });
    await service.bindProjectAgent('project-1', {
      agentId: 'codex-project-default',
      enabled: true,
      profileIds: [],
      capabilityBindingIds: [],
      overrides: { model: 'binding' },
    });
    const project = {
      id: 'project-1',
      name: 'Fixture',
      localPath: projectRoot,
      canonicalPath: projectRoot,
      createdAt: '2026-07-29T12:00:00.000Z',
      updatedAt: '2026-07-29T12:00:00.000Z',
    };
    const rendered = await canonicalStore.renderProjectAgentDefaults(
      project,
      'codex-project-default',
      { model: 'project-import', approval_policy: 'project-import' },
    );
    await mkdir(join(projectRoot, '.luwi'), { recursive: true });
    await writeFile(rendered.path, rendered.content);

    const effective = await service.getEffectiveConfiguration('project-1', 'codex-project-default');

    expect(effective.settings).toMatchObject({
      model: 'binding',
      approval_policy: 'project-import',
    });
    expect(
      effective.provenance.find(({ key }) => key === 'settings.approval_policy'),
    ).toMatchObject({ sourceScope: 'project-default', precedence: 5 });
  });
});
