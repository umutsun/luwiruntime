import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  agentDefinitionSchema,
  capabilityBindingSchema,
  capabilityPackageSchema,
  capabilityProfileSchema,
  configOperationReceiptSchema,
  configSnapshotSchema,
  projectSchema,
  projectAgentBindingSchema,
  type AgentDefinition,
  type AutopilotPolicy,
  type CapabilityBinding,
  type CapabilityPackage,
  type CapabilityProfile,
  type ConfigOperationReceipt,
  type ConfigSnapshot,
  type Project,
  type ProjectAgentBinding,
} from '@luwi/protocol';
import type { ProposedNativeFile } from '@luwi/adapters';
import { ApplicationError } from '@luwi/runtime';

export type CanonicalManifest<Value> = {
  schemaVersion: 1;
  id: string;
  scope: 'global' | 'project';
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  data: Value;
};

export type StoredConfigPlanArtifact = {
  schemaVersion: 1;
  planId: string;
  adapterId: string;
  files: ProposedNativeFile[];
  snapshotId?: string;
  importedSettings?: Record<string, unknown>;
};

export type ManagedConfigTarget = {
  schemaVersion: 1;
  path: string;
  agentId: string;
  projectId?: string;
  operationId: string;
  expectedHash: string | null;
  updatedAt: string;
};

export type CanonicalControlPlaneState = {
  projects: Project[];
  agents: AgentDefinition[];
  capabilities: CapabilityPackage[];
  profiles: CapabilityProfile[];
  capabilityBindings: CapabilityBinding[];
  projectAgentBindings: ProjectAgentBinding[];
};

export interface CanonicalStore {
  readonly globalRoot: string;
  trackProject(project: Project): Promise<void>;
  /** The mirror of `trackProject`: a project unregistered from the runtime must leave the manifest too, or the next start re-registers it. Idempotent. */
  untrackProject(projectId: string): Promise<void>;
  loadTrackedProjects(): Promise<Project[]>;
  loadControlPlaneState(): Promise<CanonicalControlPlaneState>;
  writeAgent(agent: AgentDefinition): Promise<CanonicalManifest<AgentDefinition>>;
  readAgent(agentId: string): Promise<AgentDefinition | null>;
  renderAgent(agent: AgentDefinition): Promise<{ path: string; content: string }>;
  readProjectAgentDefaults(projectRoot: string, agentId: string): Promise<Record<string, unknown>>;
  /** The `data.autopilot` block of the project manifest, unvalidated; `undefined` when absent. */
  readProjectAutopilotPolicy(projectRoot: string): Promise<unknown | undefined>;
  /** Writes `data.autopilot`, keeping the manifest's other blocks (ADR 0035). */
  writeProjectAutopilotPolicy(project: Project, policy: AutopilotPolicy): Promise<void>;
  renderProjectAgentDefaults(
    project: Project,
    agentId: string,
    settings: Record<string, unknown>,
  ): Promise<{ path: string; content: string }>;
  writeCapability(
    capability: CapabilityPackage,
    projectRoot?: string,
  ): Promise<CanonicalManifest<CapabilityPackage>>;
  writeProfile(
    profile: CapabilityProfile,
    projectRoot?: string,
  ): Promise<CanonicalManifest<CapabilityProfile>>;
  writeCapabilityBinding(
    binding: CapabilityBinding,
    projectRoot?: string,
  ): Promise<CanonicalManifest<CapabilityBinding>>;
  removeCapabilityBinding(binding: CapabilityBinding, projectRoot?: string): Promise<void>;
  writeProjectBindings(
    projectRoot: string,
    bindings: ProjectAgentBinding[],
  ): Promise<CanonicalManifest<{ bindings: ProjectAgentBinding[] }>>;
  writePlanArtifact(artifact: StoredConfigPlanArtifact): Promise<void>;
  readPlanArtifact(planId: string): Promise<StoredConfigPlanArtifact>;
  writeOperationReceipt(receipt: ConfigOperationReceipt): Promise<void>;
  readOperationReceipt(operationId: string): Promise<ConfigOperationReceipt | null>;
  listOperationReceipts(): Promise<ConfigOperationReceipt[]>;
  writeManagedTargets(receipt: ConfigOperationReceipt): Promise<void>;
  listManagedTargets(): Promise<ManagedConfigTarget[]>;
  getSnapshot(snapshotId: string): Promise<ConfigSnapshot | null>;
  listSnapshots(): Promise<ConfigSnapshot[]>;
}

export type CanonicalStoreOptions = {
  globalRoot: string;
  now?: () => Date;
};

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function manifestText<Value>(manifest: CanonicalManifest<Value>): string {
  return `${JSON.stringify(sorted(manifest), null, 2)}\n`;
}

function manifestFileName(id: string): string {
  return `${encodeURIComponent(id)}.json`;
}

function capabilityDirectory(kind: CapabilityPackage['kind']): string {
  return (
    {
      skill: 'skills',
      plugin: 'plugins',
      hook: 'hooks',
      mcp: 'mcp',
      policy: 'policies',
      profile: 'profiles',
      instruction: 'instructions',
    } as const
  )[kind];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePlanArtifact(value: unknown, planId: string): StoredConfigPlanArtifact {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['planId'] !== planId ||
    typeof value['adapterId'] !== 'string' ||
    value['adapterId'].trim().length === 0 ||
    !Array.isArray(value['files'])
  ) {
    throw new ApplicationError(
      'CONFIG_PLAN_PRECONDITION_FAILED',
      'The local configuration plan artifact is incompatible.',
      409,
    );
  }
  const files: ProposedNativeFile[] = [];
  for (const candidate of value['files']) {
    if (
      !isRecord(candidate) ||
      typeof candidate['path'] !== 'string' ||
      candidate['path'].length === 0 ||
      typeof candidate['content'] !== 'string' ||
      (candidate['managementMode'] !== 'managed-file' &&
        candidate['managementMode'] !== 'managed-fragment') ||
      (candidate['renderedSettingKeys'] !== undefined &&
        (!Array.isArray(candidate['renderedSettingKeys']) ||
          candidate['renderedSettingKeys'].some((key) => typeof key !== 'string')))
    ) {
      throw new ApplicationError(
        'CONFIG_PLAN_PRECONDITION_FAILED',
        'The local configuration plan artifact is incompatible.',
        409,
      );
    }
    files.push({
      path: candidate['path'],
      content: candidate['content'],
      managementMode: candidate['managementMode'],
      ...(candidate['renderedSettingKeys'] === undefined
        ? {}
        : { renderedSettingKeys: candidate['renderedSettingKeys'] as string[] }),
    });
  }
  const snapshotId = value['snapshotId'];
  const importedSettings = value['importedSettings'];
  if (
    (snapshotId !== undefined && typeof snapshotId !== 'string') ||
    (importedSettings !== undefined && !isRecord(importedSettings))
  ) {
    throw new ApplicationError(
      'CONFIG_PLAN_PRECONDITION_FAILED',
      'The local configuration plan artifact is incompatible.',
      409,
    );
  }
  return {
    schemaVersion: 1,
    planId,
    adapterId: value['adapterId'],
    files,
    ...(snapshotId === undefined ? {} : { snapshotId }),
    ...(importedSettings === undefined ? {} : { importedSettings }),
  };
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID().replaceAll('-', '')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(sorted(value), null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function createCanonicalStore(options: CanonicalStoreOptions): CanonicalStore {
  const now = options.now ?? (() => new Date());

  const createManifest = async <Value>(
    path: string,
    id: string,
    scope: 'global' | 'project',
    data: Value,
  ): Promise<CanonicalManifest<Value>> => {
    const previous = await readJson(path);
    const previousCreatedAt =
      previous !== undefined &&
      typeof previous === 'object' &&
      previous !== null &&
      'createdAt' in previous &&
      typeof previous.createdAt === 'string'
        ? previous.createdAt
        : now().toISOString();
    return {
      schemaVersion: 1,
      id,
      scope,
      contentHash: hash(data),
      createdAt: previousCreatedAt,
      updatedAt: now().toISOString(),
      data,
    };
  };

  const writeManifest = async <Value>(
    path: string,
    id: string,
    scope: 'global' | 'project',
    data: Value,
  ): Promise<CanonicalManifest<Value>> => {
    const manifest = await createManifest(path, id, scope, data);
    await atomicJson(path, manifest);
    return manifest;
  };

  const readManifest = async <Value>(
    path: string,
    expectedId: string,
    schema: { safeParse(value: unknown): { success: true; data: Value } | { success: false } },
  ): Promise<Value | null> => {
    const value = await readJson(path);
    if (value === undefined) return null;
    if (
      !isRecord(value) ||
      value['schemaVersion'] !== 1 ||
      value['id'] !== expectedId ||
      typeof value['contentHash'] !== 'string' ||
      !('data' in value)
    ) {
      throw new ApplicationError(
        'CONFIG_RECONCILIATION_REQUIRED',
        'A canonical LUWI manifest is incompatible.',
        503,
        { path },
      );
    }
    const parsed = schema.safeParse(value['data']);
    if (!parsed.success || hash(parsed.data) !== value['contentHash']) {
      throw new ApplicationError(
        'CONFIG_RECONCILIATION_REQUIRED',
        'A canonical LUWI manifest failed validation.',
        503,
        { path },
      );
    }
    return parsed.data;
  };

  const readManifestDirectory = async <Value>(
    root: string,
    schema: { safeParse(value: unknown): { success: true; data: Value } | { success: false } },
  ): Promise<Value[]> => {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const values: Value[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
      let expectedId: string;
      try {
        expectedId = decodeURIComponent(name.slice(0, -'.json'.length));
      } catch {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'A canonical LUWI manifest filename is incompatible.',
          503,
          { path: join(root, name) },
        );
      }
      const value = await readManifest(join(root, name), expectedId, schema);
      if (value !== null) values.push(value);
    }
    return values;
  };

  const rootManifestPath = join(options.globalRoot, 'manifest.json');
  const readTrackedProjects = async (): Promise<Project[]> => {
    const value = await readJson(rootManifestPath);
    if (value === undefined) return [];
    if (
      !isRecord(value) ||
      value['schemaVersion'] !== 1 ||
      value['id'] !== 'luwi-root' ||
      typeof value['contentHash'] !== 'string' ||
      !isRecord(value['data']) ||
      !Array.isArray(value['data']['projects']) ||
      hash(value['data']) !== value['contentHash']
    ) {
      throw new ApplicationError(
        'CONFIG_RECONCILIATION_REQUIRED',
        'The root LUWI manifest failed validation.',
        503,
        { path: rootManifestPath },
      );
    }
    const projects: Project[] = [];
    for (const candidate of value['data']['projects']) {
      if (
        !isRecord(candidate) ||
        typeof candidate['id'] !== 'string' ||
        typeof candidate['name'] !== 'string' ||
        typeof candidate['localPath'] !== 'string' ||
        typeof candidate['canonicalPath'] !== 'string' ||
        typeof candidate['createdAt'] !== 'string' ||
        typeof candidate['updatedAt'] !== 'string'
      ) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'A tracked project in the root LUWI manifest is incompatible.',
          503,
          { path: rootManifestPath },
        );
      }
      const parsed = projectSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'A tracked project in the root LUWI manifest is incompatible.',
          503,
          { path: rootManifestPath },
        );
      }
      projects.push(parsed.data);
    }
    return projects.sort((left, right) => left.id.localeCompare(right.id));
  };

  const operationsRoot = join(options.globalRoot, 'operations');
  const snapshotsRoot = join(options.globalRoot, 'snapshots');
  const managedTargetsRoot = join(options.globalRoot, 'state', 'managed-targets');

  return {
    globalRoot: options.globalRoot,

    loadTrackedProjects: readTrackedProjects,

    async trackProject(project) {
      const projects = await readTrackedProjects();
      const current = projects.findIndex(({ id }) => id === project.id);
      if (current === -1) projects.push(project);
      else projects[current] = project;
      await writeManifest(rootManifestPath, 'luwi-root', 'global', {
        projects: projects.sort((left, right) => left.id.localeCompare(right.id)),
      });
    },

    async untrackProject(projectId) {
      const projects = await readTrackedProjects();
      const remaining = projects.filter(({ id }) => id !== projectId);
      if (remaining.length === projects.length) return;
      await writeManifest(rootManifestPath, 'luwi-root', 'global', { projects: remaining });
    },

    async loadControlPlaneState() {
      const projects = await readTrackedProjects();
      const capabilityKinds = ['skill', 'plugin', 'hook', 'mcp', 'policy', 'instruction'] as const;
      const agents = await readManifestDirectory(
        join(options.globalRoot, 'agents'),
        agentDefinitionSchema,
      );
      const capabilities: CapabilityPackage[] = [];
      const profiles: CapabilityProfile[] = [];
      const capabilityBindings: CapabilityBinding[] = [];
      const projectAgentBindings: ProjectAgentBinding[] = [];
      for (const root of [
        options.globalRoot,
        ...projects.map(({ canonicalPath }) => join(canonicalPath, '.luwi')),
      ]) {
        for (const kind of capabilityKinds) {
          capabilities.push(
            ...(await readManifestDirectory(
              join(root, 'capabilities', kind),
              capabilityPackageSchema,
            )),
          );
        }
        for (const kind of capabilityKinds) {
          const legacyDirectory = kind;
          const canonicalDirectory = capabilityDirectory(kind);
          if (legacyDirectory === canonicalDirectory) continue;
          capabilities.push(
            ...(await readManifestDirectory(
              join(root, 'capabilities', canonicalDirectory),
              capabilityPackageSchema,
            )),
          );
        }
        profiles.push(
          ...(await readManifestDirectory(
            join(root, 'capabilities', 'profiles'),
            capabilityProfileSchema,
          )),
        );
        capabilityBindings.push(
          ...(await readManifestDirectory(
            join(root, 'state', 'capability-bindings'),
            capabilityBindingSchema,
          )),
        );
      }
      for (const project of projects) {
        const path = join(project.canonicalPath, '.luwi', 'agent-bindings.json');
        const value = await readJson(path);
        if (value === undefined) continue;
        if (
          !isRecord(value) ||
          value['schemaVersion'] !== 1 ||
          value['id'] !== 'project-agent-bindings' ||
          typeof value['contentHash'] !== 'string' ||
          !isRecord(value['data']) ||
          !Array.isArray(value['data']['bindings']) ||
          hash(value['data']) !== value['contentHash']
        ) {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'A canonical project binding manifest failed validation.',
            503,
            { path },
          );
        }
        for (const candidate of value['data']['bindings']) {
          const parsed = projectAgentBindingSchema.safeParse(candidate);
          if (!parsed.success || parsed.data.projectId !== project.id) {
            throw new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              'A canonical project binding is incompatible.',
              503,
              { path },
            );
          }
          projectAgentBindings.push(parsed.data);
        }
      }
      const unique = <Value extends { id: string }>(values: Value[], label: string): Value[] => {
        const byId = new Map<string, Value>();
        for (const value of values) {
          const existing = byId.get(value.id);
          if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) {
            throw new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              `Conflicting canonical ${label} manifests share one ID.`,
              503,
              { id: value.id },
            );
          }
          byId.set(value.id, value);
        }
        return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
      };
      return {
        projects,
        agents: unique(agents, 'agent'),
        capabilities: unique(capabilities, 'capability'),
        profiles: unique(profiles, 'profile'),
        capabilityBindings: unique(capabilityBindings, 'capability binding'),
        projectAgentBindings: unique(projectAgentBindings, 'project-agent binding'),
      };
    },

    writeAgent: (agent) =>
      writeManifest(
        join(options.globalRoot, 'agents', manifestFileName(agent.id)),
        agent.id,
        'global',
        agent,
      ),
    readAgent: (agentId) =>
      readManifest(
        join(options.globalRoot, 'agents', manifestFileName(agentId)),
        agentId,
        agentDefinitionSchema,
      ),
    async renderAgent(agent) {
      const path = join(options.globalRoot, 'agents', manifestFileName(agent.id));
      return {
        path,
        content: manifestText(await createManifest(path, agent.id, 'global', agent)),
      };
    },
    async readProjectAgentDefaults(projectRoot, agentId) {
      const path = join(projectRoot, '.luwi', 'manifest.json');
      const value = await readJson(path);
      if (value === undefined) return {};
      if (
        !isRecord(value) ||
        value['schemaVersion'] !== 1 ||
        value['id'] !== 'project-manifest' ||
        !isRecord(value['data']) ||
        typeof value['contentHash'] !== 'string' ||
        hash(value['data']) !== value['contentHash']
      ) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'The project LUWI manifest failed validation.',
          503,
          { path },
        );
      }
      const agentDefaults = value['data']['agentDefaults'];
      if (agentDefaults === undefined) return {};
      if (!isRecord(agentDefaults)) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'The project agent defaults are incompatible.',
          503,
          { path },
        );
      }
      const settings = agentDefaults[agentId];
      if (settings === undefined) return {};
      if (!isRecord(settings)) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'The project agent defaults are incompatible.',
          503,
          { path },
        );
      }
      return structuredClone(settings);
    },
    async readProjectAutopilotPolicy(projectRoot) {
      const path = join(projectRoot, '.luwi', 'manifest.json');
      const value = await readJson(path);
      if (value === undefined) return undefined;
      if (
        !isRecord(value) ||
        value['schemaVersion'] !== 1 ||
        value['id'] !== 'project-manifest' ||
        !isRecord(value['data']) ||
        typeof value['contentHash'] !== 'string' ||
        hash(value['data']) !== value['contentHash']
      ) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'The project LUWI manifest failed validation.',
          503,
          { path },
        );
      }
      return value['data']['autopilot'];
    },
    async writeProjectAutopilotPolicy(project, policy) {
      const path = join(project.canonicalPath, '.luwi', 'manifest.json');
      const current = await readJson(path);
      let data: Record<string, unknown> = {
        projectId: project.id,
        canonicalPath: project.canonicalPath,
        agentDefaults: {},
      };
      if (current !== undefined) {
        if (
          !isRecord(current) ||
          current['schemaVersion'] !== 1 ||
          current['id'] !== 'project-manifest' ||
          !isRecord(current['data']) ||
          typeof current['contentHash'] !== 'string' ||
          hash(current['data']) !== current['contentHash']
        ) {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'The project LUWI manifest failed validation.',
            503,
            { path },
          );
        }
        data = structuredClone(current['data']);
      }
      data['autopilot'] = structuredClone(policy);
      await atomicJson(path, await createManifest(path, 'project-manifest', 'project', data));
    },
    async renderProjectAgentDefaults(project, agentId, settings) {
      const path = join(project.canonicalPath, '.luwi', 'manifest.json');
      const current = await readJson(path);
      let agentDefaults: Record<string, unknown> = {};
      if (current !== undefined) {
        if (
          !isRecord(current) ||
          current['schemaVersion'] !== 1 ||
          current['id'] !== 'project-manifest' ||
          !isRecord(current['data']) ||
          typeof current['contentHash'] !== 'string' ||
          hash(current['data']) !== current['contentHash']
        ) {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'The project LUWI manifest failed validation.',
            503,
            { path },
          );
        }
        if (
          current['data']['agentDefaults'] !== undefined &&
          !isRecord(current['data']['agentDefaults'])
        ) {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'The project agent defaults are incompatible.',
            503,
            { path },
          );
        }
        agentDefaults = structuredClone(
          (current['data']['agentDefaults'] as Record<string, unknown> | undefined) ?? {},
        );
      }
      agentDefaults[agentId] = structuredClone(settings);
      const data = {
        projectId: project.id,
        canonicalPath: project.canonicalPath,
        agentDefaults,
      };
      return {
        path,
        content: manifestText(await createManifest(path, 'project-manifest', 'project', data)),
      };
    },

    writeCapability(capability, projectRoot) {
      const root =
        capability.scope === 'project'
          ? join(
              projectRoot ??
                (() => {
                  throw new ApplicationError(
                    'CAPABILITY_PATH_INVALID',
                    'A project capability requires its project root.',
                    400,
                  );
                })(),
              '.luwi',
            )
          : options.globalRoot;
      return writeManifest(
        join(
          root,
          'capabilities',
          capabilityDirectory(capability.kind),
          manifestFileName(capability.id),
        ),
        capability.id,
        capability.scope,
        capability,
      );
    },

    writeProfile(profile, projectRoot) {
      const root =
        profile.scope === 'project'
          ? join(
              projectRoot ??
                (() => {
                  throw new ApplicationError(
                    'PROFILE_CONFLICT',
                    'A project profile requires its project root.',
                    400,
                  );
                })(),
              '.luwi',
            )
          : options.globalRoot;
      return writeManifest(
        join(root, 'capabilities', 'profiles', manifestFileName(profile.id)),
        profile.id,
        profile.scope,
        profile,
      );
    },

    writeCapabilityBinding(binding, projectRoot) {
      const root =
        binding.scope === 'project'
          ? join(
              projectRoot ??
                (() => {
                  throw new ApplicationError(
                    'CAPABILITY_PATH_INVALID',
                    'A project capability binding requires its project root.',
                    400,
                  );
                })(),
              '.luwi',
            )
          : options.globalRoot;
      return writeManifest(
        join(root, 'state', 'capability-bindings', manifestFileName(binding.id)),
        binding.id,
        binding.scope,
        binding,
      );
    },

    async removeCapabilityBinding(binding, projectRoot) {
      const root =
        binding.scope === 'project'
          ? join(
              projectRoot ??
                (() => {
                  throw new ApplicationError(
                    'CAPABILITY_PATH_INVALID',
                    'A project capability binding requires its project root.',
                    400,
                  );
                })(),
              '.luwi',
            )
          : options.globalRoot;
      await rm(join(root, 'state', 'capability-bindings', manifestFileName(binding.id)), {
        force: true,
      });
    },

    writeProjectBindings: (projectRoot, bindings) =>
      writeManifest(
        join(projectRoot, '.luwi', 'agent-bindings.json'),
        'project-agent-bindings',
        'project',
        { bindings: [...bindings].sort((left, right) => left.id.localeCompare(right.id)) },
      ),

    writePlanArtifact: (artifact) =>
      atomicJson(
        join(operationsRoot, `${encodeURIComponent(artifact.planId)}.plan.json`),
        artifact,
      ),

    async readPlanArtifact(planId) {
      const value = await readJson(join(operationsRoot, `${encodeURIComponent(planId)}.plan.json`));
      if (value === undefined) {
        throw new ApplicationError(
          'CONFIG_PLAN_NOT_FOUND',
          'The configuration plan artifact was not found.',
          404,
        );
      }
      return parsePlanArtifact(value, planId);
    },

    writeOperationReceipt: (receipt) =>
      atomicJson(join(operationsRoot, `${encodeURIComponent(receipt.id)}.receipt.json`), receipt),

    async readOperationReceipt(operationId) {
      const value = await readJson(
        join(operationsRoot, `${encodeURIComponent(operationId)}.receipt.json`),
      );
      if (value === undefined) return null;
      const parsed = configOperationReceiptSchema.safeParse(value);
      if (!parsed.success) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'A local configuration receipt is incompatible.',
          409,
        );
      }
      return parsed.data;
    },

    async listOperationReceipts() {
      let names: string[];
      try {
        names = await readdir(operationsRoot);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
      const receipts: ConfigOperationReceipt[] = [];
      for (const name of names.filter((name) => name.endsWith('.receipt.json')).sort()) {
        const value = await readJson(join(operationsRoot, name));
        const parsed = configOperationReceiptSchema.safeParse(value);
        if (!parsed.success) {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'A local configuration receipt is incompatible.',
            503,
            { receiptFile: name },
          );
        }
        receipts.push(parsed.data);
      }
      return receipts;
    },

    async writeManagedTargets(receipt) {
      if (receipt.state !== 'completed') {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'Only completed operations can own managed targets.',
          409,
        );
      }
      await Promise.all(
        receipt.targetPaths.map((path) =>
          atomicJson(join(managedTargetsRoot, `${hash(path)}.json`), {
            schemaVersion: 1,
            path,
            agentId: receipt.agentId,
            ...(receipt.projectId === undefined ? {} : { projectId: receipt.projectId }),
            operationId: receipt.id,
            expectedHash: receipt.committedHashes[path] ?? null,
            updatedAt: receipt.updatedAt,
          } satisfies ManagedConfigTarget),
        ),
      );
    },

    async listManagedTargets() {
      let names: string[];
      try {
        names = await readdir(managedTargetsRoot);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
      const targets: ManagedConfigTarget[] = [];
      for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
        const value = await readJson(join(managedTargetsRoot, name));
        if (
          !isRecord(value) ||
          value['schemaVersion'] !== 1 ||
          typeof value['path'] !== 'string' ||
          typeof value['agentId'] !== 'string' ||
          (value['projectId'] !== undefined && typeof value['projectId'] !== 'string') ||
          typeof value['operationId'] !== 'string' ||
          (value['expectedHash'] !== null &&
            (typeof value['expectedHash'] !== 'string' ||
              !/^[a-f0-9]{64}$/.test(value['expectedHash']))) ||
          typeof value['updatedAt'] !== 'string'
        ) {
          throw new ApplicationError(
            'CONFIG_RECONCILIATION_REQUIRED',
            'A managed-target ownership record is incompatible.',
            503,
            { targetFile: name },
          );
        }
        targets.push({
          schemaVersion: 1,
          path: value['path'],
          agentId: value['agentId'],
          ...(value['projectId'] === undefined ? {} : { projectId: value['projectId'] }),
          operationId: value['operationId'],
          expectedHash: value['expectedHash'],
          updatedAt: value['updatedAt'],
        });
      }
      return targets;
    },

    async getSnapshot(snapshotId) {
      const value = await readJson(join(snapshotsRoot, snapshotId, 'manifest.json'));
      if (value === undefined) return null;
      const parsed = configSnapshotSchema.safeParse(value);
      if (!parsed.success) {
        throw new ApplicationError(
          'SNAPSHOT_NOT_FOUND',
          'The snapshot manifest is incompatible.',
          404,
        );
      }
      return parsed.data;
    },

    async listSnapshots() {
      let names: string[];
      try {
        names = await readdir(snapshotsRoot);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
      const snapshots: ConfigSnapshot[] = [];
      for (const name of names.sort()) {
        const value = await readJson(join(snapshotsRoot, name, 'manifest.json'));
        const parsed = configSnapshotSchema.safeParse(value);
        if (parsed.success) snapshots.push(parsed.data);
      }
      return snapshots;
    },
  };
}
