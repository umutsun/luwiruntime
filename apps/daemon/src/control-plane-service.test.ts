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
