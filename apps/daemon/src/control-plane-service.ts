import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';

import {
  createCapabilityObserver,
  createBuiltInAdapters,
  NodeAdapterFileSystem,
  PathExecutableResolver,
  SpawnCommandRunner,
  type AdapterCommandRunner,
  type AdapterExecutableResolver,
  type AdapterFileSystem,
  type AgentAdapter,
  type CapabilityObservationRoot,
  type CapabilityObserver,
} from '@luwi/adapters';
import {
  agentDefinitionSchema,
  capabilityBindingSchema,
  capabilityPackageSchema,
  capabilityProfileSchema,
  capabilityScanResponseSchema,
  contextSourceSchema,
  createRuntimeEvent,
  projectAgentBindingSchema,
  type AgentDefinition,
  type AgentDefinitionCreateRequest,
  type AgentDefinitionPatchRequest,
  type CapabilityAssignmentRequest,
  type CapabilityBinding,
  type CapabilityListQuery,
  type CapabilityPackage,
  type CapabilityPackageCreateRequest,
  type CapabilityPackagePatchRequest,
  type CapabilityProfile,
  type CapabilityProfileCreateRequest,
  type CapabilityProfilePatchRequest,
  type CapabilityScanResponse,
  type ContextFootprint,
  type ContextSource,
  type DetectedAgentInstallation,
  type EffectiveAgentConfiguration,
  type NativeConfigInspection,
  type Project,
  type ProjectAgentBinding,
  type ProjectAgentBindingCreateRequest,
  type ProjectAgentBindingPatchRequest,
  type RuntimeEvent,
} from '@luwi/protocol';
import type { ControlPlaneRepository } from '@luwi/redis';
import {
  ApplicationError,
  assertSecretFreeConfiguration,
  compileEffectiveConfiguration,
  estimateContextFootprint,
  type CapabilityLayer,
} from '@luwi/runtime';

import type { CanonicalStore } from './canonical-store.js';

export type ControlPlaneProjectReader = {
  get(projectId: string): Promise<Project | null>;
  list?(): Promise<Project[]>;
};

export type ControlPlaneServiceOptions = {
  repository: ControlPlaneRepository;
  canonicalStore: CanonicalStore;
  projects: ControlPlaneProjectReader;
  workspaceId: string;
  homeDirectory?: string;
  adapters?: AgentAdapter[];
  fileSystem?: AdapterFileSystem;
  executableResolver?: AdapterExecutableResolver;
  commandRunner?: AdapterCommandRunner;
  capabilityRoots?: string[];
  capabilityObserver?: CapabilityObserver;
  createId?: () => string;
  now?: () => Date;
};

export interface ControlPlaneService {
  detectAgents(projectId?: string): Promise<DetectedAgentInstallation[]>;
  createAgent(request: AgentDefinitionCreateRequest): Promise<AgentDefinition>;
  updateAgent(agentId: string, request: AgentDefinitionPatchRequest): Promise<AgentDefinition>;
  getAgent(agentId: string): Promise<AgentDefinition>;
  listAgents(): Promise<AgentDefinition[]>;
  bindProjectAgent(
    projectId: string,
    request: ProjectAgentBindingCreateRequest,
  ): Promise<ProjectAgentBinding>;
  updateProjectAgentBinding(
    projectId: string,
    bindingId: string,
    request: ProjectAgentBindingPatchRequest,
  ): Promise<ProjectAgentBinding>;
  unbindProjectAgent(projectId: string, bindingId: string): Promise<ProjectAgentBinding>;
  getProjectAgentBinding(projectId: string, bindingId: string): Promise<ProjectAgentBinding>;
  listProjectAgentBindings(projectId: string): Promise<ProjectAgentBinding[]>;
  createCapability(request: CapabilityPackageCreateRequest): Promise<CapabilityPackage>;
  updateCapability(
    capabilityId: string,
    request: CapabilityPackagePatchRequest,
  ): Promise<CapabilityPackage>;
  getCapability(capabilityId: string): Promise<CapabilityPackage>;
  listCapabilities(query?: Partial<CapabilityListQuery>): Promise<CapabilityPackage[]>;
  scanCapabilities(): Promise<CapabilityScanResponse>;
  assignCapability(
    capabilityId: string,
    request: CapabilityAssignmentRequest,
  ): Promise<CapabilityBinding>;
  unassignCapability(
    capabilityId: string,
    request: CapabilityAssignmentRequest,
  ): Promise<CapabilityBinding>;
  createProfile(request: CapabilityProfileCreateRequest): Promise<CapabilityProfile>;
  updateProfile(
    profileId: string,
    request: CapabilityProfilePatchRequest,
  ): Promise<CapabilityProfile>;
  getProfile(profileId: string): Promise<CapabilityProfile>;
  listProfiles(): Promise<CapabilityProfile[]>;
  getEffectiveConfiguration(
    projectId: string,
    agentId: string,
  ): Promise<EffectiveAgentConfiguration>;
  inspectNativeConfiguration(agentId: string, projectId?: string): Promise<NativeConfigInspection>;
  scanContext(
    agentId: string,
    projectId?: string,
  ): Promise<{ sources: NativeConfigInspection['contextSources']; footprint: ContextFootprint }>;
  listContextSources(): ReturnType<ControlPlaneRepository['listContextSources']>;
  getContextFootprint(projectId: string, agentId: string): Promise<ContextFootprint>;
  reconcileCanonicalState(): Promise<{ rebuilt: number; removed: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function lineCount(content: string | Buffer): number {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content;
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function isWithin(root: string, target: string): boolean {
  const result = relative(root, target);
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

async function hashCapabilityTree(root: string): Promise<string> {
  const rootCanonical = await realpath(root);
  const hash = createHash('sha256');
  let count = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      const canonical = await realpath(path);
      if (!isWithin(rootCanonical, canonical)) {
        throw new ApplicationError(
          'CAPABILITY_PATH_INVALID',
          'A capability package contains a path escape.',
          400,
        );
      }
      if (entry.isDirectory()) {
        await walk(canonical);
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      const metadata = await stat(canonical);
      bytes += metadata.size;
      if (count > 1000 || bytes > 10_485_760) {
        throw new ApplicationError(
          'CAPABILITY_PATH_INVALID',
          'A capability package exceeds the inspection limit.',
          413,
        );
      }
      const relativePath = relative(rootCanonical, canonical).replaceAll('\\', '/');
      hash.update(relativePath);
      hash.update('\0');
      hash.update(await readFile(canonical));
      hash.update('\0');
    }
  };
  await walk(rootCanonical);
  return hash.digest('hex');
}

function event(
  type: RuntimeEvent['type'],
  input: {
    workspaceId: string;
    createId: () => string;
    now: () => Date;
    projectId?: string;
    agentId?: string;
    payload: Record<string, unknown>;
  },
): RuntimeEvent {
  return createRuntimeEvent(
    {
      type,
      workspaceId: input.workspaceId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      payload: input.payload,
    },
    { createId: input.createId, now: input.now },
  );
}

export function createControlPlaneService(
  options: ControlPlaneServiceOptions,
): ControlPlaneService {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const homeDirectory = options.homeDirectory ?? homedir();
  const adapters = options.adapters ?? createBuiltInAdapters();
  const fileSystem = options.fileSystem ?? new NodeAdapterFileSystem();
  const executableResolver = options.executableResolver ?? new PathExecutableResolver();
  const commandRunner = options.commandRunner ?? new SpawnCommandRunner();
  const capabilityObserver = options.capabilityObserver ?? createCapabilityObserver();
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  let serialized = Promise.resolve();

  const serializeWrite = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const previous = serialized;
    let release = (): void => undefined;
    serialized = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const requireProject = async (projectId: string): Promise<Project> => {
    const project = await options.projects.get(projectId);
    if (project === null) {
      throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
    }
    return project;
  };

  const requireAgent = async (agentId: string): Promise<AgentDefinition> => {
    const agent = await options.repository.getAgentDefinition(agentId);
    if (agent === null) {
      throw new ApplicationError(
        'AGENT_DEFINITION_NOT_FOUND',
        'The agent definition was not found.',
        404,
      );
    }
    return agent;
  };

  const requireCapability = async (capabilityId: string): Promise<CapabilityPackage> => {
    const capability = await options.repository.getCapability(capabilityId);
    if (capability === null) {
      throw new ApplicationError('CAPABILITY_NOT_FOUND', 'The capability was not found.', 404);
    }
    return capability;
  };

  const isObservedCapability = (capability: CapabilityPackage): boolean =>
    capability.id.startsWith('observed:') &&
    (capability.source === 'agent-native' || capability.source === 'local-path') &&
    capability.manifest['managementMode'] === 'observed' &&
    isRecord(capability.manifest['observation']);

  const assertDeclaredManifest = (manifest: Record<string, unknown>): void => {
    if (manifest['managementMode'] === 'observed') {
      throw new ApplicationError(
        'CAPABILITY_PROVENANCE_RESERVED',
        'Observed capability provenance is reserved for passive scanning.',
        409,
      );
    }
  };

  const capabilityObservationRoots = async (): Promise<CapabilityObservationRoot[]> => {
    const nativeRoots = [
      {
        directory: '.claude',
        adapterId: 'claude-code-native-v1',
        kind: 'claude-code' as const,
      },
      { directory: '.codex', adapterId: 'codex-native-v1', kind: 'codex' as const },
      {
        directory: '.gemini',
        adapterId: 'gemini-cli-native-v1',
        kind: 'gemini-cli' as const,
      },
    ];
    const roots: CapabilityObservationRoot[] = nativeRoots.map((native) => ({
      path: resolve(homeDirectory, native.directory, 'skills'),
      scope: 'global',
      source: 'agent-native',
      adapterId: native.adapterId,
      compatibleAgentKinds: [native.kind],
    }));
    const projects = (await options.projects.list?.()) ?? [];
    for (const project of projects.toSorted((left, right) => left.id.localeCompare(right.id))) {
      for (const native of nativeRoots) {
        roots.push({
          path: resolve(project.canonicalPath, native.directory, 'skills'),
          scope: 'project',
          projectId: project.id,
          source: 'agent-native',
          adapterId: native.adapterId,
          compatibleAgentKinds: [native.kind],
        });
      }
    }
    for (const path of options.capabilityRoots ?? []) {
      roots.push({
        path,
        scope: 'global',
        source: 'local-path',
        adapterId: 'luwi-configured-roots-v1',
        compatibleAgentKinds: ['claude-code', 'codex', 'gemini-cli'],
      });
    }
    return roots;
  };

  const projectRootForScope = async (
    scope: 'global' | 'project',
    projectId?: string,
  ): Promise<string | undefined> => {
    if (scope === 'global') return undefined;
    if (projectId === undefined) {
      throw new ApplicationError(
        'CAPABILITY_PATH_INVALID',
        'Project scope requires a project identifier.',
        400,
      );
    }
    const project = await requireProject(projectId);
    await options.canonicalStore.trackProject(project);
    return project.canonicalPath;
  };

  const canonicalCapabilityPath = async (
    path: string,
    scope: 'global' | 'project',
    projectRoot?: string,
  ): Promise<string> => {
    const canonicalPath = await realpath(path);
    const allowedRoot =
      scope === 'project'
        ? resolve(projectRoot as string, '.luwi', 'capabilities')
        : resolve(options.canonicalStore.globalRoot, 'capabilities');
    if (!isWithin(allowedRoot, canonicalPath)) {
      throw new ApplicationError(
        'CAPABILITY_PATH_INVALID',
        'The capability path is outside its allowed canonical root.',
        400,
      );
    }
    return canonicalPath;
  };

  const adapterContext = async (agentId?: string, projectId?: string) => {
    const project = projectId === undefined ? undefined : await requireProject(projectId);
    return {
      homeDirectory,
      ...(project === undefined ? {} : { projectDirectory: project.canonicalPath }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(projectId === undefined ? {} : { projectId }),
      fileSystem,
      executableResolver,
      commandRunner,
      now,
    };
  };

  const adapterForAgent = async (
    agentId: string,
  ): Promise<{ adapter: AgentAdapter; agent: AgentDefinition }> => {
    const agent = await requireAgent(agentId);
    const adapter = adapterById.get(agent.adapterId);
    if (adapter === undefined || adapter.kind !== agent.kind) {
      throw new ApplicationError(
        'AGENT_ADAPTER_UNSUPPORTED',
        'The registered native adapter is unavailable.',
        409,
      );
    }
    return { adapter, agent };
  };

  const capabilityContextSources = async (
    agent: AgentDefinition,
    project: Project,
    capabilities: CapabilityPackage[],
  ): Promise<ContextSource[]> => {
    const sources: ContextSource[] = [];
    const sourceTypes: Partial<Record<CapabilityPackage['kind'], ContextSource['sourceType']>> = {
      skill: 'skill',
      plugin: 'plugin-manifest',
      hook: 'hook-definition',
      mcp: 'mcp-definition',
      policy: 'policy',
      instruction: 'instruction',
    };
    const addSource = async (
      capability: CapabilityPackage,
      path: string,
      content: string | Buffer,
      managementMode: ContextSource['managementMode'],
    ): Promise<void> => {
      const type = sourceTypes[capability.kind];
      if (type === undefined) return;
      const canonicalPath = await realpath(path).catch(() => resolve(path));
      const contentHash = sha256(content);
      const identity = sha256(
        `${agent.id}\0${project.id}\0${capability.id}\0${canonicalPath}`,
      ).slice(0, 24);
      const loadingPolicy = capability.manifest['loadingPolicy'];
      const loadingMode =
        loadingPolicy === 'automatic' ||
        loadingPolicy === 'conditional' ||
        loadingPolicy === 'manual'
          ? loadingPolicy
          : 'unknown';
      const byteCount = Buffer.byteLength(content);
      sources.push(
        contextSourceSchema.parse({
          id: `context:capability:${identity}`,
          projectId: project.id,
          agentId: agent.id,
          capabilityId: capability.id,
          agentKind: agent.kind,
          sourceType: type,
          path: canonicalPath,
          byteCount,
          lineCount: lineCount(content),
          hash: contentHash,
          loadingScope: capability.scope,
          loadingMode,
          managementMode,
          estimatedTokenCount: Math.ceil(byteCount / 4),
          estimationSource: 'estimated',
          estimationMethod: 'generic-character-estimate',
          measuredAt: now().toISOString(),
        }),
      );
    };
    for (const capability of capabilities.toSorted((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const canonicalRoot =
        capability.scope === 'global'
          ? options.canonicalStore.globalRoot
          : resolve(project.canonicalPath, '.luwi');
      const manifestPath = resolve(
        canonicalRoot,
        'capabilities',
        (
          {
            skill: 'skills',
            plugin: 'plugins',
            hook: 'hooks',
            mcp: 'mcp',
            policy: 'policies',
            profile: 'profiles',
            instruction: 'instructions',
          } as const
        )[capability.kind],
        `${encodeURIComponent(capability.id)}.json`,
      );
      await addSource(capability, manifestPath, await readFile(manifestPath), 'managed-file');
      if (capability.path === undefined) continue;
      const packageRoot = await realpath(capability.path);
      const packageStat = await stat(packageRoot);
      const candidates: string[] = [];
      if (packageStat.isFile()) {
        candidates.push(packageRoot);
      } else if (packageStat.isDirectory()) {
        const walk = async (directory: string): Promise<void> => {
          for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
            (left, right) => left.name.localeCompare(right.name),
          )) {
            const path = await realpath(resolve(directory, entry.name));
            if (!isWithin(packageRoot, path)) {
              throw new ApplicationError(
                'CAPABILITY_PATH_INVALID',
                'A capability context source escapes its package root.',
                400,
              );
            }
            if (entry.isDirectory()) {
              await walk(path);
            } else if (
              entry.isFile() &&
              (basename(path) === 'SKILL.md' ||
                basename(path) === 'luwi.json' ||
                basename(path) === 'manifest.json' ||
                basename(path) === 'package.json' ||
                /\.(?:md|json)$/i.test(path))
            ) {
              candidates.push(path);
            }
            if (candidates.length > 1000) {
              throw new ApplicationError(
                'CONTEXT_SCAN_FAILED',
                'A capability context package exceeds the inventory limit.',
                413,
              );
            }
          }
        };
        await walk(packageRoot);
      }
      for (const path of candidates.toSorted()) {
        const content = await readFile(path);
        if (content.byteLength > 1_048_576) {
          throw new ApplicationError(
            'CONTEXT_SCAN_FAILED',
            'A capability context file exceeds the inventory limit.',
            413,
            { path },
          );
        }
        await addSource(capability, path, content, 'observed');
      }
    }
    return sources;
  };

  const assignmentId = (capabilityId: string, request: CapabilityAssignmentRequest): string =>
    `binding:${capabilityId}:${sha256(
      JSON.stringify({
        scope: request.scope,
        projectId: request.projectId ?? '',
        agentId: request.agentId ?? '',
      }),
    ).slice(0, 20)}`;

  return {
    async detectAgents(projectId) {
      const context = await adapterContext(undefined, projectId);
      return (await Promise.all(adapters.map((adapter) => adapter.detectInstallations(context))))
        .flat()
        .sort(
          (left, right) =>
            left.kind.localeCompare(right.kind) ||
            (left.executable ?? '').localeCompare(right.executable ?? ''),
        );
    },

    createAgent: (request) =>
      serializeWrite(async () => {
        if ((await options.repository.getAgentDefinition(request.id)) !== null) {
          throw new ApplicationError(
            'AGENT_DEFINITION_CONFLICT',
            'An agent definition with this ID already exists.',
            409,
          );
        }
        assertSecretFreeConfiguration(request.metadata);
        const timestamp = now().toISOString();
        const agent = agentDefinitionSchema.parse({
          ...request,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await options.canonicalStore.writeAgent(agent);
        await options.repository.putAgentDefinition(
          'create',
          agent,
          event('agent.definition.registered', {
            workspaceId: options.workspaceId,
            createId,
            now,
            agentId: agent.id,
            payload: {
              agentId: agent.id,
              kind: agent.kind,
              adapterId: agent.adapterId,
            },
          }),
        );
        return agent;
      }),

    updateAgent: (agentId, request) =>
      serializeWrite(async () => {
        const current = await requireAgent(agentId);
        if (request.metadata !== undefined) assertSecretFreeConfiguration(request.metadata);
        const agent = agentDefinitionSchema.parse({
          ...current,
          ...request,
          id: current.id,
          kind: current.kind,
          updatedAt: now().toISOString(),
        });
        await options.canonicalStore.writeAgent(agent);
        await options.repository.putAgentDefinition(
          'update',
          agent,
          event(
            current.enabled && !agent.enabled
              ? 'agent.definition.disabled'
              : 'agent.definition.updated',
            {
              workspaceId: options.workspaceId,
              createId,
              now,
              agentId: agent.id,
              payload: { agentId: agent.id, enabled: agent.enabled },
            },
          ),
        );
        return agent;
      }),

    getAgent: requireAgent,
    listAgents: () => options.repository.listAgentDefinitions(),

    bindProjectAgent: (projectId, request) =>
      serializeWrite(async () => {
        const [project, agent, existing] = await Promise.all([
          requireProject(projectId),
          requireAgent(request.agentId),
          options.repository.listProjectAgentBindings(projectId),
        ]);
        await options.canonicalStore.trackProject(project);
        if (existing.some((binding) => binding.agentId === request.agentId)) {
          throw new ApplicationError(
            'PROJECT_AGENT_BINDING_CONFLICT',
            'This agent is already bound to the project.',
            409,
          );
        }
        assertSecretFreeConfiguration(request.overrides);
        const timestamp = now().toISOString();
        const binding = projectAgentBindingSchema.parse({
          ...request,
          id: createId(),
          projectId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await options.canonicalStore.writeProjectBindings(project.canonicalPath, [
          ...existing,
          binding,
        ]);
        await options.repository.putProjectAgentBinding(
          'create',
          binding,
          event('project.agent.bound', {
            workspaceId: options.workspaceId,
            createId,
            now,
            projectId,
            agentId: agent.id,
            payload: {
              bindingId: binding.id,
              agentId: agent.id,
              role: binding.role ?? null,
            },
          }),
        );
        for (const profileId of binding.profileIds.toSorted()) {
          await options.repository.appendEvent(
            event('profile.assigned', {
              workspaceId: options.workspaceId,
              createId,
              now,
              projectId,
              agentId: agent.id,
              payload: { bindingId: binding.id, profileId },
            }),
          );
        }
        return binding;
      }),

    updateProjectAgentBinding: (projectId, bindingId, request) =>
      serializeWrite(async () => {
        const project = await requireProject(projectId);
        const current = await options.repository.getProjectAgentBinding(bindingId);
        if (current === null || current.projectId !== projectId) {
          throw new ApplicationError(
            'PROJECT_AGENT_BINDING_NOT_FOUND',
            'The project-agent binding was not found.',
            404,
          );
        }
        if (request.overrides !== undefined) assertSecretFreeConfiguration(request.overrides);
        const updated = projectAgentBindingSchema.parse({
          ...current,
          ...request,
          id: current.id,
          projectId: current.projectId,
          agentId: current.agentId,
          updatedAt: now().toISOString(),
        });
        const all = await options.repository.listProjectAgentBindings(projectId);
        await options.canonicalStore.writeProjectBindings(
          project.canonicalPath,
          all.map((binding) => (binding.id === updated.id ? updated : binding)),
        );
        await options.repository.putProjectAgentBinding(
          'update',
          updated,
          event('project.agent.updated', {
            workspaceId: options.workspaceId,
            createId,
            now,
            projectId,
            agentId: updated.agentId,
            payload: { bindingId, enabled: updated.enabled },
          }),
        );
        const newlyAssignedProfiles = updated.profileIds.filter(
          (profileId) => !current.profileIds.includes(profileId),
        );
        for (const profileId of newlyAssignedProfiles.toSorted()) {
          await options.repository.appendEvent(
            event('profile.assigned', {
              workspaceId: options.workspaceId,
              createId,
              now,
              projectId,
              agentId: updated.agentId,
              payload: { bindingId: updated.id, profileId },
            }),
          );
        }
        return updated;
      }),

    unbindProjectAgent: (projectId, bindingId) =>
      serializeWrite(async () => {
        const project = await requireProject(projectId);
        const current = await options.repository.getProjectAgentBinding(bindingId);
        if (current === null || current.projectId !== projectId) {
          throw new ApplicationError(
            'PROJECT_AGENT_BINDING_NOT_FOUND',
            'The project-agent binding was not found.',
            404,
          );
        }
        const all = await options.repository.listProjectAgentBindings(projectId);
        await options.canonicalStore.writeProjectBindings(
          project.canonicalPath,
          all.filter((binding) => binding.id !== bindingId),
        );
        await options.repository.deleteProjectAgentBinding(
          current,
          event('project.agent.unbound', {
            workspaceId: options.workspaceId,
            createId,
            now,
            projectId,
            agentId: current.agentId,
            payload: { bindingId },
          }),
        );
        return current;
      }),

    async getProjectAgentBinding(projectId, bindingId) {
      await requireProject(projectId);
      const binding = await options.repository.getProjectAgentBinding(bindingId);
      if (binding === null || binding.projectId !== projectId) {
        throw new ApplicationError(
          'PROJECT_AGENT_BINDING_NOT_FOUND',
          'The project-agent binding was not found.',
          404,
        );
      }
      return binding;
    },
    async listProjectAgentBindings(projectId) {
      await requireProject(projectId);
      return options.repository.listProjectAgentBindings(projectId);
    },

    createCapability: (request) =>
      serializeWrite(async () => {
        if ((await options.repository.getCapability(request.id)) !== null) {
          throw new ApplicationError(
            'CAPABILITY_CONFLICT',
            'A capability with this ID already exists.',
            409,
          );
        }
        assertDeclaredManifest(request.manifest);
        assertSecretFreeConfiguration(request.manifest);
        const projectRoot = await projectRootForScope(request.scope, request.projectId);
        let canonicalPath: string | undefined;
        let checksum: string;
        if (request.path !== undefined) {
          canonicalPath = await canonicalCapabilityPath(request.path, request.scope, projectRoot);
          checksum = await hashCapabilityTree(canonicalPath);
        } else {
          checksum = sha256(JSON.stringify(request.manifest));
        }
        const timestamp = now().toISOString();
        const capability = capabilityPackageSchema.parse({
          ...request,
          ...(canonicalPath === undefined ? {} : { path: canonicalPath }),
          checksum,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await options.canonicalStore.writeCapability(capability, projectRoot);
        await options.repository.putCapability(
          'create',
          capability,
          event('capability.registered', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(capability.projectId === undefined ? {} : { projectId: capability.projectId }),
            payload: {
              capabilityId: capability.id,
              kind: capability.kind,
              checksum: capability.checksum,
            },
          }),
        );
        return capability;
      }),

    updateCapability: (capabilityId, request) =>
      serializeWrite(async () => {
        const current = await requireCapability(capabilityId);
        if (isObservedCapability(current)) {
          throw new ApplicationError(
            'CAPABILITY_OBSERVED_READ_ONLY',
            'Observed capabilities can only be refreshed by passive scanning.',
            409,
          );
        }
        if (request.manifest !== undefined) {
          assertDeclaredManifest(request.manifest);
          assertSecretFreeConfiguration(request.manifest);
        }
        const projectRoot = await projectRootForScope(current.scope, current.projectId);
        const path =
          request.path === undefined
            ? current.path
            : await canonicalCapabilityPath(request.path, current.scope, projectRoot);
        const checksum =
          path === undefined
            ? sha256(JSON.stringify(request.manifest ?? current.manifest))
            : await hashCapabilityTree(await realpath(path));
        const capability = capabilityPackageSchema.parse({
          ...current,
          ...request,
          id: current.id,
          kind: current.kind,
          scope: current.scope,
          projectId: current.projectId,
          source: current.source,
          checksum,
          updatedAt: now().toISOString(),
        });
        await options.canonicalStore.writeCapability(capability, projectRoot);
        await options.repository.putCapability(
          'update',
          capability,
          event(
            current.enabled && !capability.enabled ? 'capability.disabled' : 'capability.updated',
            {
              workspaceId: options.workspaceId,
              createId,
              now,
              ...(capability.projectId === undefined ? {} : { projectId: capability.projectId }),
              payload: {
                capabilityId: capability.id,
                checksum: capability.checksum,
                enabled: capability.enabled,
              },
            },
          ),
        );
        return capability;
      }),

    getCapability: requireCapability,
    async listCapabilities(query = {}) {
      const bindings =
        query.agentId === undefined ? [] : await options.repository.listCapabilityBindings();
      const assignedIds = new Set(
        bindings
          .filter(
            (binding) =>
              binding.agentId === query.agentId &&
              (query.projectId === undefined || binding.projectId === query.projectId),
          )
          .map((binding) => binding.capabilityId),
      );
      return (await options.repository.listCapabilities(100_001))
        .filter(
          (capability) =>
            (query.kind === undefined || capability.kind === query.kind) &&
            (query.scope === undefined || capability.scope === query.scope) &&
            (query.projectId === undefined || capability.projectId === query.projectId) &&
            (query.enabled === undefined || capability.enabled === query.enabled) &&
            (query.agentId === undefined || assignedIds.has(capability.id)),
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, query.limit ?? 100);
    },

    scanCapabilities: () =>
      serializeWrite(async () => {
        const observed = await capabilityObserver.scan(await capabilityObservationRoots());
        const capabilities: CapabilityPackage[] = [];
        let conflictsSkipped = 0;
        for (const observation of observed.capabilities) {
          const current = await options.repository.getCapability(observation.id);
          if (current !== null && !isObservedCapability(current)) {
            conflictsSkipped += 1;
            continue;
          }
          const timestamp = now().toISOString();
          const capability = capabilityPackageSchema.parse({
            ...observation,
            requiredCapabilityIds: [],
            requiredMcpIds: [],
            enabled: true,
            createdAt: current?.createdAt ?? timestamp,
            updatedAt: timestamp,
          });
          await options.repository.putCapability(
            current === null ? 'create' : 'update',
            capability,
            event(current === null ? 'capability.registered' : 'capability.updated', {
              workspaceId: options.workspaceId,
              createId,
              now,
              ...(capability.projectId === undefined ? {} : { projectId: capability.projectId }),
              payload: {
                capabilityId: capability.id,
                kind: capability.kind,
                checksum: capability.checksum,
                managementMode: 'observed',
                adapterId: observation.manifest.observation.adapterId,
              },
            }),
          );
          capabilities.push(capability);
        }
        return capabilityScanResponseSchema.parse({
          capabilities,
          diagnostics: {
            ...observed.diagnostics,
            conflictsSkipped,
          },
        });
      }),

    assignCapability: (capabilityId, request) =>
      serializeWrite(async () => {
        const capability = await requireCapability(capabilityId);
        if (
          capability.scope === 'project' &&
          (request.scope !== 'project' || request.projectId !== capability.projectId)
        ) {
          throw new ApplicationError(
            'CAPABILITY_CONFLICT',
            'A project capability can only be assigned inside its owning project.',
            409,
          );
        }
        const projectRoot = await projectRootForScope(request.scope, request.projectId);
        if (request.agentId !== undefined) await requireAgent(request.agentId);
        assertSecretFreeConfiguration(request.settings);
        const timestamp = now().toISOString();
        const binding = capabilityBindingSchema.parse({
          ...request,
          id: assignmentId(capabilityId, request),
          capabilityId,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const existing = (await options.repository.listCapabilityBindings()).find(
          ({ id }) => id === binding.id,
        );
        await options.canonicalStore.writeCapabilityBinding(binding, projectRoot);
        await options.repository.putCapabilityBinding(
          existing === undefined ? 'create' : 'update',
          binding,
          event('capability.assigned', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(binding.projectId === undefined ? {} : { projectId: binding.projectId }),
            ...(binding.agentId === undefined ? {} : { agentId: binding.agentId }),
            payload: {
              bindingId: binding.id,
              capabilityId: capability.id,
              enabled: binding.enabled,
            },
          }),
        );
        return binding;
      }),

    unassignCapability: (capabilityId, request) =>
      serializeWrite(async () => {
        await requireCapability(capabilityId);
        const id = assignmentId(capabilityId, request);
        const binding = (await options.repository.listCapabilityBindings()).find(
          (candidate) => candidate.id === id && candidate.capabilityId === capabilityId,
        );
        if (binding === undefined) {
          throw new ApplicationError(
            'CAPABILITY_NOT_FOUND',
            'The capability assignment was not found.',
            404,
          );
        }
        const projectRoot = await projectRootForScope(binding.scope, binding.projectId);
        await options.canonicalStore.removeCapabilityBinding(binding, projectRoot);
        await options.repository.deleteCapabilityBinding(
          binding,
          event('capability.unassigned', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(binding.projectId === undefined ? {} : { projectId: binding.projectId }),
            ...(binding.agentId === undefined ? {} : { agentId: binding.agentId }),
            payload: { bindingId: binding.id, capabilityId },
          }),
        );
        return binding;
      }),

    createProfile: (request) =>
      serializeWrite(async () => {
        if ((await options.repository.getProfile(request.id)) !== null) {
          throw new ApplicationError(
            'PROFILE_CONFLICT',
            'A profile with this ID already exists.',
            409,
          );
        }
        assertSecretFreeConfiguration(request.adapterSettings);
        const projectRoot = await projectRootForScope(request.scope, request.projectId);
        const timestamp = now().toISOString();
        const profile = capabilityProfileSchema.parse({
          ...request,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await options.canonicalStore.writeProfile(profile, projectRoot);
        await options.repository.putProfile(
          'create',
          profile,
          event('profile.registered', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(profile.projectId === undefined ? {} : { projectId: profile.projectId }),
            payload: { profileId: profile.id },
          }),
        );
        return profile;
      }),

    updateProfile: (profileId, request) =>
      serializeWrite(async () => {
        const current = await options.repository.getProfile(profileId);
        if (current === null) {
          throw new ApplicationError('PROFILE_NOT_FOUND', 'The profile was not found.', 404);
        }
        if (request.adapterSettings !== undefined) {
          assertSecretFreeConfiguration(request.adapterSettings);
        }
        const profile = capabilityProfileSchema.parse({
          ...current,
          ...request,
          id: current.id,
          scope: current.scope,
          projectId: current.projectId,
          updatedAt: now().toISOString(),
        });
        const projectRoot = await projectRootForScope(profile.scope, profile.projectId);
        await options.canonicalStore.writeProfile(profile, projectRoot);
        await options.repository.putProfile(
          'update',
          profile,
          event('profile.updated', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(profile.projectId === undefined ? {} : { projectId: profile.projectId }),
            payload: { profileId: profile.id },
          }),
        );
        return profile;
      }),

    async getProfile(profileId) {
      const profile = await options.repository.getProfile(profileId);
      if (profile === null) {
        throw new ApplicationError('PROFILE_NOT_FOUND', 'The profile was not found.', 404);
      }
      return profile;
    },
    listProfiles: () => options.repository.listProfiles(),

    async getEffectiveConfiguration(projectId, agentId) {
      const [project, agent, catalog, profiles, assignments, projectBindings, storedFootprint] =
        await Promise.all([
          requireProject(projectId),
          requireAgent(agentId),
          options.repository.listCapabilities(),
          options.repository.listProfiles(),
          options.repository.listCapabilityBindings(),
          options.repository.listProjectAgentBindings(projectId),
          options.repository.getContextFootprint(projectId, agentId),
        ]);
      const projectDefaults = await options.canonicalStore.readProjectAgentDefaults(
        project.canonicalPath,
        agentId,
      );
      const binding = projectBindings.find((candidate) => candidate.agentId === agentId);
      if (binding === undefined || !binding.enabled) {
        throw new ApplicationError(
          'PROJECT_AGENT_BINDING_NOT_FOUND',
          'The agent is not actively bound to the project.',
          404,
        );
      }
      const relevantCatalog = catalog.filter(
        (capability) => capability.scope === 'global' || capability.projectId === projectId,
      );
      const relevantProfiles = profiles.filter(
        (profile) => profile.scope === 'global' || profile.projectId === projectId,
      );
      const layers: CapabilityLayer[] = [
        {
          precedence: 1,
          sourceScope: 'runtime-default',
          capabilities: [],
          settings: {},
        },
      ];
      const agentSettings = isRecord(agent.metadata['settings']) ? agent.metadata['settings'] : {};
      layers.push({
        precedence: 2,
        sourceScope: 'agent-default',
        sourceId: agent.id,
        capabilities: [],
        settings: agentSettings,
      });
      const globalAssignments = assignments.filter(
        (assignment) =>
          assignment.scope === 'global' &&
          (assignment.agentId === undefined || assignment.agentId === agentId),
      );
      layers.push({
        precedence: 4,
        sourceScope: 'global-capability',
        sourceId: agent.id,
        capabilities: globalAssignments.map((assignment) => ({
          capabilityId: assignment.capabilityId,
          enabled: assignment.enabled,
        })),
        settings: Object.assign({}, ...globalAssignments.map(({ settings }) => settings)),
      });
      layers.push({
        precedence: 5,
        sourceScope: 'project-default',
        sourceId: projectId,
        sourceFile: resolve(project.canonicalPath, '.luwi', 'manifest.json'),
        capabilities: [],
        settings: projectDefaults,
      });
      const globalProfileIds = binding.profileIds.filter(
        (profileId) =>
          relevantProfiles.find((profile) => profile.id === profileId)?.scope === 'global',
      );
      const projectProfileIds = binding.profileIds.filter(
        (profileId) =>
          relevantProfiles.find((profile) => profile.id === profileId)?.scope === 'project',
      );
      const missingProfileIds = binding.profileIds.filter(
        (profileId) => !relevantProfiles.some((profile) => profile.id === profileId),
      );
      layers.push({
        precedence: 3,
        sourceScope: 'global-profile',
        sourceId: binding.id,
        profileIds: globalProfileIds,
        capabilities: [],
        settings: {},
      });
      layers.push({
        precedence: 6,
        sourceScope: 'project-profile',
        sourceId: binding.id,
        profileIds: [...projectProfileIds, ...missingProfileIds],
        capabilities: [],
        settings: {},
      });
      const projectAssignments = assignments.filter(
        (assignment) =>
          assignment.scope === 'project' &&
          assignment.projectId === projectId &&
          (assignment.agentId === undefined || assignment.agentId === agentId) &&
          binding.capabilityBindingIds.includes(assignment.id),
      );
      layers.push({
        precedence: 7,
        sourceScope: 'project-capability',
        sourceId: binding.id,
        capabilities: projectAssignments.map((assignment) => ({
          capabilityId: assignment.capabilityId,
          enabled: assignment.enabled,
        })),
        settings: Object.assign({}, ...projectAssignments.map(({ settings }) => settings)),
      });
      layers.push({
        precedence: 8,
        sourceScope: 'project-agent',
        sourceId: binding.id,
        capabilities: [],
        settings: binding.overrides,
      });
      const footprint =
        storedFootprint ??
        estimateContextFootprint({
          projectId,
          agentId,
          measuredAt: now().toISOString(),
          sources: [],
        });
      const adapterSupport = adapterById.get(agent.adapterId)?.describeCapabilities();
      return compileEffectiveConfiguration({
        projectId,
        agentId,
        agentKind: agent.kind,
        catalog: relevantCatalog,
        profiles: relevantProfiles,
        layers,
        footprint,
        unsupportedCapabilityKinds:
          adapterSupport === undefined
            ? []
            : Object.entries(adapterSupport.capabilityKinds)
                .filter(([, support]) => support === 'unsupported')
                .map(([kind]) => kind as CapabilityPackage['kind']),
        ...(adapterSupport === undefined
          ? {}
          : {
              adapterCapabilitySupport: adapterSupport.capabilityKinds,
              policyMode: adapterSupport.policyMode,
            }),
      });
    },

    async inspectNativeConfiguration(agentId, projectId) {
      const { adapter } = await adapterForAgent(agentId);
      const context = await adapterContext(agentId, projectId);
      const inspection =
        projectId === undefined
          ? await adapter.inspectGlobalConfig(context)
          : await adapter.inspectProjectConfig(context);
      return inspection;
    },

    async scanContext(agentId, projectId) {
      const { adapter, agent } = await adapterForAgent(agentId);
      const context = await adapterContext(agentId, projectId);
      const inspections = [await adapter.inspectGlobalConfig(context)];
      if (projectId !== undefined) {
        inspections.push(await adapter.inspectProjectConfig(context));
      }
      const sources = inspections.flatMap(({ contextSources }) => contextSources);
      if (projectId !== undefined) {
        const project = await requireProject(projectId);
        const effective = await this.getEffectiveConfiguration(projectId, agentId);
        sources.push(...(await capabilityContextSources(agent, project, effective.capabilities)));
      }
      const previous = new Map(
        (await options.repository.listContextSources()).map((source) => [source.id, source]),
      );
      for (const source of sources) {
        await options.repository.putContextSource(
          previous.has(source.id) ? 'update' : 'create',
          source,
          event(previous.has(source.id) ? 'context.source.updated' : 'context.source.detected', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
            ...(source.agentId === undefined ? {} : { agentId: source.agentId }),
            payload: {
              sourceId: source.id,
              sourceType: source.sourceType,
              path: source.path,
              hash: source.hash,
              byteCount: source.byteCount,
            },
          }),
        );
      }
      const activeIds = new Set(sources.map(({ id }) => id));
      for (const source of previous.values()) {
        const belongsToScan =
          source.agentId === agentId &&
          (projectId === undefined
            ? source.projectId === undefined
            : source.projectId === undefined || source.projectId === projectId);
        if (!belongsToScan || activeIds.has(source.id)) continue;
        await options.repository.deleteContextSource(
          source,
          event('context.source.updated', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
            agentId,
            payload: {
              sourceId: source.id,
              sourceType: source.sourceType,
              path: source.path,
              action: 'removed',
            },
          }),
        );
      }
      const footprint = estimateContextFootprint({
        ...(projectId === undefined ? {} : { projectId }),
        agentId,
        measuredAt: now().toISOString(),
        sources,
      });
      if (projectId !== undefined) {
        await options.repository.putContextFootprint(
          footprint,
          event('context.footprint.measured', {
            workspaceId: options.workspaceId,
            createId,
            now,
            projectId,
            agentId,
            payload: {
              totalBytes: footprint.totalBytes,
              totalLines: footprint.totalLines,
              estimatedTokens: footprint.estimatedTokens,
              sourceCount: sources.length,
              estimationSource: footprint.source,
              estimationMethod: footprint.method,
            },
          }),
        );
      }
      return { sources, footprint };
    },

    listContextSources: () => options.repository.listContextSources(),

    async getContextFootprint(projectId, agentId) {
      await Promise.all([requireProject(projectId), requireAgent(agentId)]);
      const footprint = await options.repository.getContextFootprint(projectId, agentId);
      if (footprint === null) {
        return estimateContextFootprint({
          projectId,
          agentId,
          measuredAt: now().toISOString(),
          sources: [],
        });
      }
      return footprint;
    },

    async reconcileCanonicalState() {
      const state = await options.canonicalStore.loadControlPlaneState();
      let rebuilt = 0;
      let removed = 0;
      const same = (left: unknown, right: unknown): boolean =>
        JSON.stringify(left) === JSON.stringify(right);
      for (const agent of state.agents) {
        const current = await options.repository.getAgentDefinition(agent.id);
        if (current !== null && same(current, agent)) continue;
        await options.repository.putAgentDefinition(
          current === null ? 'create' : 'update',
          agent,
          event('config.reconciled', {
            workspaceId: options.workspaceId,
            createId,
            now,
            agentId: agent.id,
            payload: { entityType: 'agent-definition', entityId: agent.id },
          }),
        );
        rebuilt += 1;
      }
      for (const capability of state.capabilities) {
        const current = await options.repository.getCapability(capability.id);
        if (current !== null && same(current, capability)) continue;
        await options.repository.putCapability(
          current === null ? 'create' : 'update',
          capability,
          event('config.reconciled', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(capability.projectId === undefined ? {} : { projectId: capability.projectId }),
            payload: { entityType: 'capability', entityId: capability.id },
          }),
        );
        rebuilt += 1;
      }
      for (const profile of state.profiles) {
        const current = await options.repository.getProfile(profile.id);
        if (current !== null && same(current, profile)) continue;
        await options.repository.putProfile(
          current === null ? 'create' : 'update',
          profile,
          event('config.reconciled', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(profile.projectId === undefined ? {} : { projectId: profile.projectId }),
            payload: { entityType: 'profile', entityId: profile.id },
          }),
        );
        rebuilt += 1;
      }
      const projectedCapabilityBindings = await options.repository.listCapabilityBindings();
      const projectedCapabilityBindingsById = new Map(
        projectedCapabilityBindings.map((binding) => [binding.id, binding]),
      );
      for (const binding of state.capabilityBindings) {
        const current = projectedCapabilityBindingsById.get(binding.id);
        if (current !== undefined && same(current, binding)) continue;
        await options.repository.putCapabilityBinding(
          current === undefined ? 'create' : 'update',
          binding,
          event('config.reconciled', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(binding.projectId === undefined ? {} : { projectId: binding.projectId }),
            ...(binding.agentId === undefined ? {} : { agentId: binding.agentId }),
            payload: { entityType: 'capability-binding', entityId: binding.id },
          }),
        );
        rebuilt += 1;
      }
      const canonicalCapabilityBindingIds = new Set(state.capabilityBindings.map(({ id }) => id));
      for (const binding of projectedCapabilityBindings) {
        if (canonicalCapabilityBindingIds.has(binding.id)) continue;
        await options.repository.deleteCapabilityBinding(
          binding,
          event('config.reconciled', {
            workspaceId: options.workspaceId,
            createId,
            now,
            ...(binding.projectId === undefined ? {} : { projectId: binding.projectId }),
            ...(binding.agentId === undefined ? {} : { agentId: binding.agentId }),
            payload: {
              entityType: 'capability-binding',
              entityId: binding.id,
              action: 'removed-stale-projection',
            },
          }),
        );
        removed += 1;
      }
      const canonicalProjectBindingIds = new Set(state.projectAgentBindings.map(({ id }) => id));
      for (const binding of state.projectAgentBindings) {
        const current = await options.repository.getProjectAgentBinding(binding.id);
        if (current !== null && same(current, binding)) continue;
        await options.repository.putProjectAgentBinding(
          current === null ? 'create' : 'update',
          binding,
          event('config.reconciled', {
            workspaceId: options.workspaceId,
            createId,
            now,
            projectId: binding.projectId,
            agentId: binding.agentId,
            payload: { entityType: 'project-agent-binding', entityId: binding.id },
          }),
        );
        rebuilt += 1;
      }
      for (const project of state.projects) {
        const projected = await options.repository.listProjectAgentBindings(project.id);
        for (const binding of projected) {
          if (canonicalProjectBindingIds.has(binding.id)) continue;
          await options.repository.deleteProjectAgentBinding(
            binding,
            event('config.reconciled', {
              workspaceId: options.workspaceId,
              createId,
              now,
              projectId: binding.projectId,
              agentId: binding.agentId,
              payload: {
                entityType: 'project-agent-binding',
                entityId: binding.id,
                action: 'removed-stale-projection',
              },
            }),
          );
          removed += 1;
        }
      }
      return { rebuilt, removed };
    },
  };
}
