import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  createBuiltInAdapters,
  NodeAdapterFileSystem,
  PathExecutableResolver,
  SpawnCommandRunner,
  type AdapterCommandRunner,
  type AdapterExecutableResolver,
  type AdapterFileSystem,
  type AgentAdapter,
  type ProposedNativeFile,
} from '@luwi/adapters';
import {
  agentDefinitionSchema,
  configDriftSchema,
  effectiveAgentConfigurationSchema,
  configOperationReceiptSchema,
  configPlanSchema,
  createRuntimeEvent,
  nativeConfigInspectionSchema,
  type ConfigDrift,
  type AgentDefinition,
  type ConfigOperationReceipt,
  type ConfigPlan,
  type ConfigSnapshot,
  type ContextLoadingMode,
  type NativeConfigInspection,
  type RuntimeEvent,
} from '@luwi/protocol';
import type { ControlPlaneRepository } from '@luwi/redis';
import {
  ApplicationError,
  assertSecretFreeConfiguration,
  reconcileOperation,
  transitionConfigPlan,
} from '@luwi/runtime';

import type { CanonicalStore, StoredConfigPlanArtifact } from './canonical-store.js';
import {
  createConfigFileEngine,
  hashFileContent,
  type ConfigFileEngine,
} from './config-file-engine.js';
import type { ControlPlaneProjectReader, ControlPlaneService } from './control-plane-service.js';

export type ConfigControlServiceOptions = {
  repository: ControlPlaneRepository;
  canonicalStore: CanonicalStore;
  controlPlane: ControlPlaneService;
  projects: ControlPlaneProjectReader;
  workspaceId: string;
  homeDirectory?: string;
  adapters?: AgentAdapter[];
  fileSystem?: AdapterFileSystem;
  executableResolver?: AdapterExecutableResolver;
  commandRunner?: AdapterCommandRunner;
  createFileEngine?: (allowedRoots: string[]) => ConfigFileEngine;
  createId?: () => string;
  createApprovalToken?: () => string;
  onReconciliationRequired?: (error: ApplicationError) => void;
  now?: () => Date;
  planTtlMs?: number;
  snapshotRetentionCount?: number;
  onApplied?: (receipt: ConfigOperationReceipt, plan: ConfigPlan) => Promise<void> | void;
};

export interface ConfigControlService {
  inspect(agentId: string, projectId?: string): Promise<NativeConfigInspection>;
  createRenderPlan(input: {
    agentId: string;
    projectId?: string | undefined;
    previewOverrides?: Record<string, unknown> | undefined;
    adoptUnmanaged?: boolean | undefined;
  }): Promise<ConfigPlan>;
  createImportPlan(input: { agentId: string; projectId?: string | undefined }): Promise<ConfigPlan>;
  createOptimizationPlan(input: {
    proposalId: string;
    projectId: string;
    agentId: string;
    contextSourceId: string;
    loadingMode: ContextLoadingMode;
  }): Promise<ConfigPlan>;
  getPlan(planId: string): Promise<ConfigPlan>;
  listPlans(): Promise<ConfigPlan[]>;
  approvePlan(planId: string): Promise<{ plan: ConfigPlan; approvalToken: string }>;
  applyPlan(planId: string, approvalToken: string): Promise<ConfigOperationReceipt>;
  getSnapshot(snapshotId: string): Promise<ConfigSnapshot>;
  listSnapshots(): Promise<ConfigSnapshot[]>;
  createRollbackPlan(snapshotId: string): Promise<ConfigPlan>;
  listDrift(): Promise<ConfigDrift[]>;
  scanDrift(): Promise<ConfigDrift[]>;
  reconcile(): Promise<ConfigOperationReceipt[]>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function currentHash(path: string): Promise<string | null> {
  try {
    return hashFileContent(await readFile(path));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function secureTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const output = structuredClone(target);
  for (const [key, value] of Object.entries(source)) {
    if (isRecord(value) && isRecord(output[key])) {
      output[key] = mergeSettings(output[key], value);
    } else {
      output[key] = structuredClone(value);
    }
  }
  return output;
}

function configEvent(
  type: RuntimeEvent['type'],
  options: {
    workspaceId: string;
    createId: () => string;
    now: () => Date;
    agentId: string;
    projectId?: string;
    payload: Record<string, unknown>;
  },
): RuntimeEvent {
  return createRuntimeEvent(
    {
      type,
      workspaceId: options.workspaceId,
      agentId: options.agentId,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      payload: options.payload,
    },
    { createId: options.createId, now: options.now },
  );
}

export function createConfigControlService(
  options: ConfigControlServiceOptions,
): ConfigControlService {
  const createId = options.createId ?? randomUUID;
  const createApprovalToken =
    options.createApprovalToken ?? (() => randomBytes(32).toString('base64url'));
  const now = options.now ?? (() => new Date());
  const planTtlMs = options.planTtlMs ?? 900_000;
  const homeDirectory = options.homeDirectory ?? homedir();
  const adapters = options.adapters ?? createBuiltInAdapters();
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const fileSystem = options.fileSystem ?? new NodeAdapterFileSystem();
  const executableResolver = options.executableResolver ?? new PathExecutableResolver();
  const commandRunner = options.commandRunner ?? new SpawnCommandRunner();
  const lockedTargetPaths = new Set<string>();
  const createEngine =
    options.createFileEngine ??
    ((allowedRoots: string[]) =>
      createConfigFileEngine({
        allowedRoots,
        stateRoot: options.canonicalStore.globalRoot,
        ...(options.snapshotRetentionCount === undefined
          ? {}
          : { snapshotRetentionCount: options.snapshotRetentionCount }),
      }));

  const requireProject = async (projectId: string) => {
    const project = await options.projects.get(projectId);
    if (project === null) {
      throw new ApplicationError('PROJECT_NOT_FOUND', 'The project was not found.', 404);
    }
    return project;
  };

  const adapterFor = async (agentId: string, projectId?: string) => {
    const agent = await options.controlPlane.getAgent(agentId);
    const adapter = adapterById.get(agent.adapterId);
    if (adapter === undefined || adapter.kind !== agent.kind) {
      throw new ApplicationError(
        'AGENT_ADAPTER_UNSUPPORTED',
        'The registered native adapter is unavailable.',
        409,
      );
    }
    const project = projectId === undefined ? undefined : await requireProject(projectId);
    return {
      agent,
      adapter,
      project,
      context: {
        homeDirectory,
        ...(project === undefined ? {} : { projectDirectory: project.canonicalPath }),
        agentId,
        ...(projectId === undefined ? {} : { projectId }),
        fileSystem,
        executableResolver,
        commandRunner,
        now,
      },
    };
  };

  const requireNativeConfigRoots = (agent: AgentDefinition): string[] => {
    if (agent.nativeConfigRoots.length === 0) {
      throw new ApplicationError(
        'CONFIG_PLAN_PATH_ESCAPE',
        'The agent definition has no approved native configuration roots.',
        409,
      );
    }
    return [...agent.nativeConfigRoots];
  };

  const assertArtifactMatchesPlan = (
    plan: ConfigPlan,
    artifact: StoredConfigPlanArtifact,
    adapter: AgentAdapter,
    snapshot?: ConfigSnapshot,
  ): void => {
    const fail = (): never => {
      throw new ApplicationError(
        'CONFIG_PLAN_PRECONDITION_FAILED',
        'The stored configuration artifact no longer matches the approved plan.',
        409,
        { planId: plan.id },
      );
    };
    if (artifact.planId !== plan.id || artifact.adapterId !== adapter.id) fail();
    if (plan.kind === 'render' || plan.kind === 'optimization') {
      if (
        artifact.snapshotId !== undefined ||
        artifact.importedSettings !== undefined ||
        artifact.files.length !== plan.changes.length
      ) {
        fail();
      }
      const files = new Map(artifact.files.map((file) => [file.path, file]));
      if (files.size !== artifact.files.length) fail();
      for (const change of plan.changes) {
        const file = files.get(change.path);
        if (
          file === undefined ||
          file.managementMode !== change.managementMode ||
          change.operation === 'delete' ||
          change.afterHash === undefined ||
          hashFileContent(file.content) !== change.afterHash
        ) {
          fail();
        }
      }
      return;
    }
    if (plan.kind === 'import') {
      if (
        artifact.files.length !== 1 ||
        artifact.snapshotId !== undefined ||
        artifact.importedSettings === undefined ||
        plan.changes.length !== 1 ||
        artifact.files[0]?.path !== plan.changes[0]?.path ||
        artifact.files[0]?.managementMode !== plan.changes[0]?.managementMode ||
        plan.changes[0]?.afterHash === undefined ||
        hashFileContent(artifact.files[0]?.content ?? '') !== plan.changes[0]?.afterHash
      ) {
        fail();
      }
      assertSecretFreeConfiguration(artifact.importedSettings);
      return;
    }
    const rollbackSnapshot = snapshot ?? fail();
    if (
      artifact.files.length !== 0 ||
      artifact.importedSettings !== undefined ||
      artifact.snapshotId !== plan.snapshotId ||
      rollbackSnapshot.id !== plan.snapshotId ||
      rollbackSnapshot.agentId !== plan.agentId ||
      rollbackSnapshot.projectId !== plan.projectId ||
      rollbackSnapshot.adapterVersion !== adapter.id ||
      rollbackSnapshot.files.length !== plan.changes.length
    ) {
      fail();
    }
    const changes = new Map(plan.changes.map((change) => [change.path, change]));
    if (changes.size !== plan.changes.length) fail();
    for (const file of rollbackSnapshot.files) {
      const change = changes.get(file.targetPath);
      if (
        change === undefined ||
        change.managementMode !== 'managed-file' ||
        (file.existed ? change.operation !== 'update' : change.operation !== 'delete') ||
        (file.originalHash === null
          ? change.afterHash !== undefined
          : change.afterHash !== file.originalHash)
      ) {
        fail();
      }
    }
  };

  const getPlan = async (planId: string): Promise<ConfigPlan> => {
    const plan = await options.repository.getConfigPlan(planId);
    if (plan === null) {
      throw new ApplicationError(
        'CONFIG_PLAN_NOT_FOUND',
        'The configuration plan was not found.',
        404,
      );
    }
    return plan;
  };

  const persistNewPlan = async (
    plan: ConfigPlan,
    artifact: StoredConfigPlanArtifact,
  ): Promise<ConfigPlan> => {
    await options.canonicalStore.writePlanArtifact(artifact);
    await options.repository.transitionConfigPlan(
      '__missing__',
      plan,
      configEvent('config.plan.created', {
        workspaceId: options.workspaceId,
        createId,
        now,
        agentId: plan.agentId,
        ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
        payload: {
          planId: plan.id,
          kind: plan.kind,
          changeCount: plan.changes.length,
          expiresAt: plan.expiresAt,
        },
      }),
    );
    return plan;
  };

  const buildChanges = async (files: ProposedNativeFile[], planWarnings: string[]) => {
    const preconditionHashes: Record<string, string | null> = {};
    const changes: ConfigPlan['changes'] = [];
    for (const file of files) {
      const beforeHash = await currentHash(file.path);
      const afterHash = hashFileContent(file.content);
      preconditionHashes[file.path] = beforeHash;
      changes.push({
        path: file.path,
        operation: beforeHash === null ? 'create' : 'update',
        managementMode: file.managementMode,
        ...(beforeHash === null ? {} : { beforeHash }),
        afterHash,
        redactedDiff: JSON.stringify(
          {
            operation: beforeHash === null ? 'create' : 'update',
            managementMode: file.managementMode,
            before: { hash: beforeHash },
            after: {
              hash: afterHash,
              sizeBytes: Buffer.byteLength(file.content),
              renderedSettingKeys: file.renderedSettingKeys ?? [],
            },
          },
          null,
          2,
        ),
        warnings: planWarnings,
      });
    }
    return { changes, preconditionHashes };
  };

  const assertManagedOrAdopted = async (
    files: ProposedNativeFile[],
    adoptUnmanaged: boolean,
  ): Promise<void> => {
    const managedTargets = await options.canonicalStore.listManagedTargets();
    for (const file of files) {
      const observedHash = await currentHash(file.path);
      if (observedHash === null) continue;
      const managed = managedTargets.some((target) => target.path === file.path);
      if (!managed && !adoptUnmanaged) {
        throw new ApplicationError(
          'NATIVE_CONFIG_UNMANAGED',
          'An existing native configuration file requires explicit adoption.',
          409,
          { path: file.path },
        );
      }
    }
  };

  const failPlan = async (plan: ConfigPlan, errorCode: string): Promise<void> => {
    const failed = configPlanSchema.parse({ ...plan, state: 'failed' });
    await options.repository
      .transitionConfigPlan(
        plan.state,
        failed,
        configEvent('config.apply.failed', {
          workspaceId: options.workspaceId,
          createId,
          now,
          agentId: plan.agentId,
          ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
          payload: { planId: plan.id, errorCode },
        }),
      )
      .catch(() => undefined);
  };

  return {
    async inspect(agentId, projectId) {
      const inspection = await options.controlPlane.inspectNativeConfiguration(agentId, projectId);
      const managedTargets = await options.canonicalStore.listManagedTargets();
      const classified = nativeConfigInspectionSchema.parse({
        ...inspection,
        files: inspection.files.map((file) => ({
          ...file,
          managementMode: managedTargets.some((target) => target.path === file.canonicalPath)
            ? 'managed-file'
            : 'observed',
        })),
      });
      await options.repository.appendEvent(
        configEvent('config.inspected', {
          workspaceId: options.workspaceId,
          createId,
          now,
          agentId,
          ...(projectId === undefined ? {} : { projectId }),
          payload: {
            adapterId: classified.adapterId,
            fileCount: classified.files.length,
            malformedCount: classified.files.filter(
              ({ parseStatus }) => parseStatus === 'malformed',
            ).length,
            paths: classified.files.map(({ canonicalPath }) => canonicalPath),
          },
        }),
      );
      return classified;
    },

    async createRenderPlan(input) {
      const resolved = await adapterFor(input.agentId, input.projectId);
      const effective =
        input.projectId === undefined
          ? (() => {
              throw new ApplicationError(
                'PROJECT_AGENT_BINDING_NOT_FOUND',
                'Render plans require a project-agent binding in Phase 3.',
                400,
              );
            })()
          : await options.controlPlane.getEffectiveConfiguration(input.projectId, input.agentId);
      if (!effective.valid) {
        throw new ApplicationError(
          'EFFECTIVE_CONFIG_INVALID',
          'The effective configuration has unresolved conflicts.',
          409,
          {
            missingDependencies: effective.missingDependencies.join(','),
            unsupportedCapabilities: effective.unsupportedCapabilities.join(','),
          },
        );
      }
      const previewOverrides = input.previewOverrides ?? {};
      assertSecretFreeConfiguration(previewOverrides);
      const preview = effectiveAgentConfigurationSchema.parse({
        ...effective,
        settings: mergeSettings(effective.settings, previewOverrides),
      });
      const inspection =
        input.projectId === undefined
          ? await resolved.adapter.inspectGlobalConfig(resolved.context)
          : await resolved.adapter.inspectProjectConfig(resolved.context);
      if (inspection.files.some(({ parseStatus }) => parseStatus === 'malformed')) {
        throw new ApplicationError(
          'NATIVE_CONFIG_PARSE_FAILED',
          'Malformed native configuration cannot be rendered safely.',
          409,
        );
      }
      const imported = await resolved.adapter.importConfig(inspection, resolved.context);
      assertSecretFreeConfiguration(imported.settings);
      const nativePlan = await resolved.adapter.createRenderPlan(
        effectiveAgentConfigurationSchema.parse({
          ...preview,
          settings: mergeSettings(imported.settings, preview.settings),
        }),
        resolved.context,
      );
      if (nativePlan.files.length === 0) {
        throw new ApplicationError(
          'AGENT_ADAPTER_UNSUPPORTED',
          'The native adapter does not support rendering in Phase 3.',
          409,
        );
      }
      const inspectionByPath = new Map(inspection.files.map((file) => [file.canonicalPath, file]));
      for (const file of nativePlan.files) {
        const inspected = inspectionByPath.get(await fileSystem.canonicalize(file.path));
        if (inspected !== undefined && inspected.unsupportedFields.length > 0) {
          throw new ApplicationError(
            'NATIVE_CONFIG_UNMANAGED',
            'The native configuration contains fields that the adapter cannot preserve.',
            409,
            {
              path: inspected.canonicalPath,
              unsupportedFields: inspected.unsupportedFields.join(','),
            },
          );
        }
      }
      const validation = await resolved.adapter.validateRenderedFiles(nativePlan.files);
      if (!validation.valid) {
        throw new ApplicationError(
          'NATIVE_CONFIG_PARSE_FAILED',
          'The adapter rendered invalid native configuration.',
          409,
          { invalidPaths: validation.errors.map(({ path }) => path).join(',') },
        );
      }
      await assertManagedOrAdopted(nativePlan.files, input.adoptUnmanaged ?? false);
      const built = await buildChanges(nativePlan.files, nativePlan.warnings);
      const createdAt = now();
      const plan = configPlanSchema.parse({
        id: createId(),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        agentId: input.agentId,
        state: 'prepared',
        kind: 'render',
        changes: built.changes,
        preconditionHashes: built.preconditionHashes,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + planTtlMs).toISOString(),
      });
      return persistNewPlan(plan, {
        schemaVersion: 1,
        planId: plan.id,
        adapterId: resolved.adapter.id,
        files: nativePlan.files,
      });
    },

    async createImportPlan(input) {
      const resolved = await adapterFor(input.agentId, input.projectId);
      const inspection =
        input.projectId === undefined
          ? await resolved.adapter.inspectGlobalConfig(resolved.context)
          : await resolved.adapter.inspectProjectConfig(resolved.context);
      if (inspection.files.some(({ parseStatus }) => parseStatus === 'malformed')) {
        throw new ApplicationError(
          'NATIVE_CONFIG_PARSE_FAILED',
          'Malformed native configuration cannot be imported.',
          409,
        );
      }
      const imported = await resolved.adapter.importConfig(inspection, resolved.context);
      assertSecretFreeConfiguration(imported.settings);
      const createdAt = now();
      const proposed =
        resolved.project === undefined
          ? await options.canonicalStore.renderAgent(
              agentDefinitionSchema.parse({
                ...resolved.agent,
                metadata: {
                  ...resolved.agent.metadata,
                  settings: imported.settings,
                },
                updatedAt: createdAt.toISOString(),
              }),
            )
          : await options.canonicalStore.renderProjectAgentDefaults(
              resolved.project,
              input.agentId,
              imported.settings,
            );
      const beforeHash = await currentHash(proposed.path);
      const afterHash = hashFileContent(proposed.content);
      const plan = configPlanSchema.parse({
        id: createId(),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        agentId: input.agentId,
        state: 'prepared',
        kind: 'import',
        changes: [
          {
            path: proposed.path,
            operation: beforeHash === null ? 'create' : 'update',
            managementMode: 'managed-file',
            ...(beforeHash === null ? {} : { beforeHash }),
            afterHash,
            redactedDiff: JSON.stringify({
              importedFieldCount: Object.keys(imported.settings).length,
              sourcePaths: imported.sourcePaths,
            }),
            warnings: imported.warnings,
          },
        ],
        preconditionHashes: { [proposed.path]: beforeHash },
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + planTtlMs).toISOString(),
      });
      await options.repository.appendEvent(
        configEvent('config.import.planned', {
          workspaceId: options.workspaceId,
          createId,
          now,
          agentId: input.agentId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          payload: {
            planId: plan.id,
            sourcePaths: imported.sourcePaths,
            importedFieldCount: Object.keys(imported.settings).length,
          },
        }),
      );
      return persistNewPlan(plan, {
        schemaVersion: 1,
        planId: plan.id,
        adapterId: resolved.adapter.id,
        files: [
          {
            path: proposed.path,
            content: proposed.content,
            managementMode: 'managed-file',
            renderedSettingKeys: Object.keys(imported.settings).sort(),
          },
        ],
        importedSettings: imported.settings,
      });
    },

    async createOptimizationPlan(input) {
      const resolved = await adapterFor(input.agentId, input.projectId);
      if (resolved.project === undefined) {
        throw new ApplicationError(
          'OPTIMIZATION_CONFIG_PLAN_FAILED',
          'Context optimization requires a registered local project.',
          409,
        );
      }
      const current = await options.canonicalStore.readProjectAgentDefaults(
        resolved.project.canonicalPath,
        input.agentId,
      );
      const currentModes = current['contextLoadingModes'];
      if (
        currentModes !== undefined &&
        (typeof currentModes !== 'object' || currentModes === null || Array.isArray(currentModes))
      ) {
        throw new ApplicationError(
          'OPTIMIZATION_CONFIG_PLAN_FAILED',
          'The canonical context loading-mode map is incompatible.',
          409,
        );
      }
      const settings = {
        ...current,
        contextLoadingModes: {
          ...((currentModes as Record<string, unknown> | undefined) ?? {}),
          [input.contextSourceId]: input.loadingMode,
        },
      };
      assertSecretFreeConfiguration(settings);
      const proposed = await options.canonicalStore.renderProjectAgentDefaults(
        resolved.project,
        input.agentId,
        settings,
      );
      const beforeHash = await currentHash(proposed.path);
      const afterHash = hashFileContent(proposed.content);
      const createdAt = now();
      const plan = configPlanSchema.parse({
        id: createId(),
        projectId: input.projectId,
        agentId: input.agentId,
        state: 'prepared',
        kind: 'optimization',
        changes: [
          {
            path: proposed.path,
            operation: beforeHash === null ? 'create' : 'update',
            managementMode: 'managed-file',
            ...(beforeHash === null ? {} : { beforeHash }),
            afterHash,
            redactedDiff: JSON.stringify({
              proposalId: input.proposalId,
              action: 'change-loading-mode',
              contextSourceId: input.contextSourceId,
              loadingMode: input.loadingMode,
            }),
            warnings: [],
          },
        ],
        preconditionHashes: { [proposed.path]: beforeHash },
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + planTtlMs).toISOString(),
      });
      return persistNewPlan(plan, {
        schemaVersion: 1,
        planId: plan.id,
        adapterId: resolved.adapter.id,
        files: [
          {
            path: proposed.path,
            content: proposed.content,
            managementMode: 'managed-file',
            renderedSettingKeys: ['contextLoadingModes'],
          },
        ],
      });
    },

    getPlan,
    listPlans: () => options.repository.listConfigPlans(),

    async approvePlan(planId) {
      const plan = await getPlan(planId);
      transitionConfigPlan(plan.state, 'approved', now().getTime(), Date.parse(plan.expiresAt));
      const approvalToken = createApprovalToken();
      const approved = configPlanSchema.parse({
        ...plan,
        state: 'approved',
        approvalTokenHash: sha256(approvalToken),
      });
      await options.repository.transitionConfigPlan(
        'prepared',
        approved,
        configEvent('config.plan.approved', {
          workspaceId: options.workspaceId,
          createId,
          now,
          agentId: plan.agentId,
          ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
          payload: { planId: plan.id },
        }),
      );
      return { plan: approved, approvalToken };
    },

    async applyPlan(planId, approvalToken) {
      const plan = await getPlan(planId);
      if (
        plan.state !== 'approved' ||
        plan.approvalTokenHash === undefined ||
        !secureTokenMatches(approvalToken, plan.approvalTokenHash)
      ) {
        throw new ApplicationError(
          'CONFIG_PLAN_NOT_APPROVED',
          'The configuration plan approval token is invalid or already used.',
          409,
        );
      }
      const resolved = await adapterFor(plan.agentId, plan.projectId);
      const artifact = await options.canonicalStore.readPlanArtifact(planId);
      const snapshot =
        plan.kind === 'rollback' && plan.snapshotId !== undefined
          ? await options.canonicalStore.getSnapshot(plan.snapshotId)
          : undefined;
      if (plan.kind === 'rollback' && snapshot === null) {
        throw new ApplicationError(
          'SNAPSHOT_NOT_FOUND',
          'The rollback snapshot was not found.',
          404,
        );
      }
      assertArtifactMatchesPlan(plan, artifact, resolved.adapter, snapshot ?? undefined);
      const targetPaths = [...new Set(plan.changes.map(({ path }) => path))].sort();
      if (targetPaths.length !== plan.changes.length) {
        throw new ApplicationError(
          'CONFIG_PLAN_PRECONDITION_FAILED',
          'The approved configuration plan contains duplicate target paths.',
          409,
        );
      }
      if (targetPaths.some((path) => lockedTargetPaths.has(path))) {
        throw new ApplicationError(
          'CONFIG_APPLY_FAILED',
          'Another configuration operation currently owns a target file.',
          409,
        );
      }
      for (const path of targetPaths) lockedTargetPaths.add(path);
      try {
        transitionConfigPlan(plan.state, 'applying', now().getTime(), Date.parse(plan.expiresAt));
        const applying = configPlanSchema.parse({ ...plan, state: 'applying' });
        const operationId = createId();
        const startedAt = now().toISOString();
        let receipt = configOperationReceiptSchema.parse({
          id: operationId,
          planId,
          agentId: plan.agentId,
          ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
          state: 'prepared',
          targetPaths: plan.changes.map(({ path }) => path),
          expectedHashes: plan.preconditionHashes,
          committedHashes: {},
          startedAt,
          updatedAt: startedAt,
        });
        await options.canonicalStore.writeOperationReceipt(receipt);
        try {
          await options.repository.transitionConfigPlan(
            'approved',
            applying,
            configEvent(
              plan.kind === 'rollback' ? 'config.rollback.started' : 'config.apply.started',
              {
                workspaceId: options.workspaceId,
                createId,
                now,
                agentId: plan.agentId,
                ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
                payload: { planId, operationId },
              },
            ),
          );
        } catch (error) {
          receipt = configOperationReceiptSchema.parse({
            ...receipt,
            state: 'reconciliation_required',
            failureCode: 'REDIS_TRANSITION_UNCERTAIN',
            updatedAt: now().toISOString(),
          });
          await options.canonicalStore.writeOperationReceipt(receipt);
          options.onReconciliationRequired?.(
            new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              'The configuration plan transition outcome requires reconciliation.',
              503,
              { operationId },
            ),
          );
          throw error;
        }
        try {
          if (plan.kind === 'import' || plan.kind === 'optimization') {
            const roots =
              plan.kind === 'optimization'
                ? resolved.project === undefined
                  ? []
                  : [join(resolved.project.canonicalPath, '.luwi')]
                : resolved.project === undefined
                  ? [join(options.canonicalStore.globalRoot, 'agents')]
                  : [join(resolved.project.canonicalPath, '.luwi')];
            const applied = await createEngine(roots).apply({
              operationId,
              planId,
              agentId: plan.agentId,
              ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
              adapterVersion: artifact.adapterId,
              files: artifact.files,
              preconditionHashes: plan.preconditionHashes,
              onProgress: async (progress) => {
                receipt = configOperationReceiptSchema.parse({
                  ...receipt,
                  snapshotId: progress.snapshot.id,
                  state: progress.state,
                  committedHashes: progress.intendedHashes,
                  updatedAt: now().toISOString(),
                });
                await options.canonicalStore.writeOperationReceipt(receipt);
              },
            });
            receipt = configOperationReceiptSchema.parse({
              ...receipt,
              snapshotId: applied.snapshot.id,
              state: 'files_committed',
              committedHashes: applied.committedHashes,
              updatedAt: now().toISOString(),
            });
            if (plan.kind === 'import' && resolved.project === undefined) {
              const importedAgent = await options.canonicalStore.readAgent(plan.agentId);
              if (importedAgent === null) {
                throw new ApplicationError(
                  'CONFIG_RECONCILIATION_REQUIRED',
                  'The imported canonical agent manifest could not be reloaded.',
                  503,
                  { operationId },
                );
              }
              try {
                await options.repository.putAgentDefinition(
                  'update',
                  importedAgent,
                  configEvent('agent.definition.updated', {
                    workspaceId: options.workspaceId,
                    createId,
                    now,
                    agentId: importedAgent.id,
                    payload: { agentId: importedAgent.id, imported: true },
                  }),
                );
              } catch {
                throw new ApplicationError(
                  'CONFIG_RECONCILIATION_REQUIRED',
                  'The imported agent projection requires reconciliation.',
                  503,
                  { operationId },
                );
              }
            }
          } else if (plan.kind === 'rollback') {
            if (plan.snapshotId === undefined) {
              throw new ApplicationError(
                'SNAPSHOT_NOT_FOUND',
                'The rollback plan does not reference a snapshot.',
                409,
              );
            }
            if (snapshot === undefined || snapshot === null) {
              throw new ApplicationError(
                'SNAPSHOT_NOT_FOUND',
                'The rollback snapshot was not found.',
                404,
              );
            }
            const roots = [
              ...requireNativeConfigRoots(resolved.agent),
              join(options.canonicalStore.globalRoot, 'agents'),
              ...(resolved.project === undefined
                ? []
                : [join(resolved.project.canonicalPath, '.luwi')]),
            ];
            const restored = await createEngine(roots).rollback({
              sourceSnapshot: snapshot,
              operationId,
              planId,
              agentId: plan.agentId,
              ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
              adapterVersion: artifact.adapterId,
              expectedCurrentHashes: plan.preconditionHashes,
              onProgress: async (progress) => {
                receipt = configOperationReceiptSchema.parse({
                  ...receipt,
                  snapshotId: progress.snapshot.id,
                  state: progress.state,
                  committedHashes: progress.intendedHashes,
                  updatedAt: now().toISOString(),
                });
                await options.canonicalStore.writeOperationReceipt(receipt);
              },
            });
            receipt = configOperationReceiptSchema.parse({
              ...receipt,
              snapshotId: restored.snapshot.id,
              state: 'files_committed',
              committedHashes: restored.committedHashes,
              updatedAt: now().toISOString(),
            });
            const canonicalAgentPath = join(
              options.canonicalStore.globalRoot,
              'agents',
              `${encodeURIComponent(plan.agentId)}.json`,
            );
            if (receipt.targetPaths.includes(canonicalAgentPath)) {
              const restoredAgent = await options.canonicalStore.readAgent(plan.agentId);
              if (restoredAgent === null) {
                throw new ApplicationError(
                  'CONFIG_RECONCILIATION_REQUIRED',
                  'The restored canonical agent manifest could not be reloaded.',
                  503,
                  { operationId },
                );
              }
              try {
                await options.repository.putAgentDefinition(
                  'update',
                  restoredAgent,
                  configEvent('agent.definition.updated', {
                    workspaceId: options.workspaceId,
                    createId,
                    now,
                    agentId: restoredAgent.id,
                    payload: { agentId: restoredAgent.id, rollback: true },
                  }),
                );
              } catch {
                throw new ApplicationError(
                  'CONFIG_RECONCILIATION_REQUIRED',
                  'The restored agent projection requires reconciliation.',
                  503,
                  { operationId },
                );
              }
            }
          } else {
            const roots = requireNativeConfigRoots(resolved.agent);
            const applied = await createEngine(roots).apply({
              operationId,
              planId,
              agentId: plan.agentId,
              ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
              adapterVersion: artifact.adapterId,
              files: artifact.files,
              preconditionHashes: plan.preconditionHashes,
              onProgress: async (progress) => {
                receipt = configOperationReceiptSchema.parse({
                  ...receipt,
                  snapshotId: progress.snapshot.id,
                  state: progress.state,
                  committedHashes: progress.intendedHashes,
                  updatedAt: now().toISOString(),
                });
                await options.canonicalStore.writeOperationReceipt(receipt);
              },
            });
            receipt = configOperationReceiptSchema.parse({
              ...receipt,
              snapshotId: applied.snapshot.id,
              state: 'files_committed',
              committedHashes: applied.committedHashes,
              updatedAt: now().toISOString(),
            });
          }
          await options.canonicalStore.writeOperationReceipt(receipt);
          const completed =
            receipt.state === 'completed'
              ? receipt
              : configOperationReceiptSchema.parse({
                  ...receipt,
                  state: 'completed',
                  updatedAt: now().toISOString(),
                });
          const successType = plan.kind === 'rollback' ? 'config.rolled_back' : 'config.applied';
          const successEvent = configEvent(successType, {
            workspaceId: options.workspaceId,
            createId,
            now,
            agentId: plan.agentId,
            ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
            payload: {
              planId,
              operationId,
              snapshotId: completed.snapshotId ?? null,
              targetPaths: completed.targetPaths,
              committedHashes: completed.committedHashes,
            },
          });
          await options.canonicalStore.writeManagedTargets(completed);
          try {
            await options.repository.completeConfigPlan(
              'applying',
              configPlanSchema.parse({
                ...applying,
                state: 'applied',
                operationId,
                ...(completed.snapshotId === undefined ? {} : { snapshotId: completed.snapshotId }),
              }),
              completed,
              successEvent,
            );
          } catch {
            const reconciliation = configOperationReceiptSchema.parse({
              ...completed,
              state: 'reconciliation_required',
              failureCode: 'REDIS_PROJECTION_FAILED',
              updatedAt: now().toISOString(),
            });
            receipt = reconciliation;
            await options.canonicalStore.writeOperationReceipt(reconciliation);
            const reconciliationError = new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              'Files were committed but Redis projections require reconciliation.',
              503,
              { operationId },
            );
            options.onReconciliationRequired?.(reconciliationError);
            throw reconciliationError;
          }
          await options.canonicalStore.writeOperationReceipt(completed);
          await options.onApplied?.(completed, plan);
          return completed;
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.code === 'CONFIG_RECONCILIATION_REQUIRED'
          ) {
            if (receipt.state !== 'reconciliation_required') {
              receipt = configOperationReceiptSchema.parse({
                ...receipt,
                state: 'reconciliation_required',
                failureCode: error.code,
                updatedAt: now().toISOString(),
              });
              await options.canonicalStore.writeOperationReceipt(receipt);
              options.onReconciliationRequired?.(error);
            }
            throw error;
          }
          if (receipt.state === 'files_committed' || receipt.state === 'redis_pending') {
            const reconciliation = configOperationReceiptSchema.parse({
              ...receipt,
              state: 'reconciliation_required',
              failureCode:
                error instanceof ApplicationError ? error.code : 'FILESYSTEM_COMMIT_UNCERTAIN',
              updatedAt: now().toISOString(),
            });
            await options.canonicalStore.writeOperationReceipt(reconciliation);
            const reconciliationError = new ApplicationError(
              'CONFIG_RECONCILIATION_REQUIRED',
              'Files were committed but operation completion requires reconciliation.',
              503,
              { operationId },
            );
            options.onReconciliationRequired?.(reconciliationError);
            throw reconciliationError;
          }
          const code = error instanceof ApplicationError ? error.code : 'CONFIG_APPLY_FAILED';
          await failPlan(applying, code);
          const failed = configOperationReceiptSchema.parse({
            ...receipt,
            state: 'failed',
            failureCode: code,
            updatedAt: now().toISOString(),
          });
          await options.canonicalStore.writeOperationReceipt(failed);
          if (error instanceof ApplicationError) throw error;
          throw new ApplicationError(
            'CONFIG_APPLY_FAILED',
            'The configuration plan could not be applied.',
            500,
          );
        }
      } finally {
        for (const path of targetPaths) lockedTargetPaths.delete(path);
      }
    },

    async getSnapshot(snapshotId) {
      const snapshot = await options.canonicalStore.getSnapshot(snapshotId);
      if (snapshot === null) {
        throw new ApplicationError(
          'SNAPSHOT_NOT_FOUND',
          'The configuration snapshot was not found.',
          404,
        );
      }
      return snapshot;
    },
    listSnapshots: () => options.canonicalStore.listSnapshots(),

    async createRollbackPlan(snapshotId) {
      const snapshot = await options.canonicalStore.getSnapshot(snapshotId);
      if (snapshot === null) {
        throw new ApplicationError(
          'SNAPSHOT_NOT_FOUND',
          'The configuration snapshot was not found.',
          404,
        );
      }
      const preconditionHashes: Record<string, string | null> = {};
      const changes: ConfigPlan['changes'] = [];
      for (const file of snapshot.files) {
        const beforeHash = await currentHash(file.targetPath);
        preconditionHashes[file.targetPath] = beforeHash;
        changes.push({
          path: file.targetPath,
          operation: file.existed ? 'update' : 'delete',
          managementMode: 'managed-file',
          ...(beforeHash === null ? {} : { beforeHash }),
          ...(file.originalHash === null ? {} : { afterHash: file.originalHash }),
          redactedDiff: JSON.stringify({
            operation: file.existed ? 'restore' : 'delete',
            beforeHash,
            afterHash: file.originalHash,
          }),
          warnings: [],
        });
      }
      const createdAt = now();
      const plan = configPlanSchema.parse({
        id: createId(),
        ...(snapshot.projectId === undefined ? {} : { projectId: snapshot.projectId }),
        agentId: snapshot.agentId,
        state: 'prepared',
        kind: 'rollback',
        changes,
        preconditionHashes,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + planTtlMs).toISOString(),
        snapshotId,
      });
      return persistNewPlan(plan, {
        schemaVersion: 1,
        planId: plan.id,
        adapterId: snapshot.adapterVersion,
        files: [],
        snapshotId,
      });
    },

    listDrift: () => options.repository.listConfigDrifts(),

    async scanDrift() {
      const managedTargets = await options.canonicalStore.listManagedTargets();
      const existing = new Map(
        (await options.repository.listConfigDrifts()).map((drift) => [drift.id, drift]),
      );
      const drifts: ConfigDrift[] = [];
      const activeIds = new Set<string>();
      for (const target of [...managedTargets].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        const expectedHash = target.expectedHash;
        const observedHash = await currentHash(target.path);
        if (expectedHash === observedHash) continue;
        const id = `drift:${sha256(
          `${target.agentId}\0${target.projectId ?? ''}\0${target.path}`,
        ).slice(0, 24)}`;
        activeIds.add(id);
        const drift = configDriftSchema.parse({
          id,
          agentId: target.agentId,
          ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
          path: target.path,
          expectedHash,
          observedHash,
          severity: 'warning',
          resolution: 'manual',
          detectedAt: existing.get(id)?.detectedAt ?? now().toISOString(),
        });
        await options.repository.putConfigDrift(
          existing.has(id) ? 'update' : 'create',
          drift,
          configEvent('config.drift.detected', {
            workspaceId: options.workspaceId,
            createId,
            now,
            agentId: drift.agentId,
            ...(drift.projectId === undefined ? {} : { projectId: drift.projectId }),
            payload: {
              driftId: id,
              path: target.path,
              expectedHash,
              observedHash,
              severity: drift.severity,
            },
          }),
        );
        drifts.push(drift);
      }
      for (const drift of existing.values()) {
        if (activeIds.has(drift.id)) continue;
        await options.repository.deleteConfigDrift(
          drift,
          configEvent('config.drift.resolved', {
            workspaceId: options.workspaceId,
            createId,
            now,
            agentId: drift.agentId,
            ...(drift.projectId === undefined ? {} : { projectId: drift.projectId }),
            payload: { driftId: drift.id, path: drift.path },
          }),
        );
      }
      return drifts;
    },

    async reconcile() {
      const receipts = await options.canonicalStore.listOperationReceipts();
      const reconciled: ConfigOperationReceipt[] = [];
      const ambiguousOperationIds: string[] = [];
      for (const receipt of receipts.filter(
        ({ state }) =>
          state === 'prepared' ||
          state === 'snapshotted' ||
          state === 'reconciliation_required' ||
          state === 'redis_pending' ||
          state === 'files_committed' ||
          state === 'writing',
      )) {
        const observedHashes = Object.fromEntries(
          await Promise.all(
            receipt.targetPaths.map(async (path) => [path, await currentHash(path)]),
          ),
        );
        const [plan, projectedOperation] = await Promise.all([
          options.repository.getConfigPlan(receipt.planId),
          options.repository.getConfigOperation(receipt.id),
        ]);
        const markAmbiguous = async (failureCode: string): Promise<void> => {
          const ambiguous = configOperationReceiptSchema.parse({
            ...receipt,
            state: 'reconciliation_required',
            failureCode,
            updatedAt: now().toISOString(),
          });
          await options.canonicalStore.writeOperationReceipt(ambiguous);
          ambiguousOperationIds.push(receipt.id);
        };
        if (plan === null) {
          await markAmbiguous('REDIS_PROJECTION_INCONSISTENT');
          continue;
        }
        const unchanged = receipt.targetPaths.every(
          (path) => (receipt.expectedHashes[path] ?? null) === (observedHashes[path] ?? null),
        );
        if (
          (receipt.state === 'prepared' ||
            receipt.state === 'snapshotted' ||
            receipt.state === 'writing' ||
            receipt.failureCode === 'REDIS_TRANSITION_UNCERTAIN') &&
          unchanged
        ) {
          if (
            projectedOperation !== null ||
            (plan.state !== 'applying' && plan.state !== 'approved')
          ) {
            await markAmbiguous('REDIS_PROJECTION_INCONSISTENT');
            continue;
          }
          const failed = configOperationReceiptSchema.parse({
            ...receipt,
            state: 'failed',
            failureCode: 'INTERRUPTED_BEFORE_FILE_COMMIT',
            updatedAt: now().toISOString(),
          });
          try {
            if (plan.state === 'applying') {
              await options.repository.transitionConfigPlan(
                'applying',
                configPlanSchema.parse({ ...plan, state: 'failed' }),
                configEvent('config.apply.failed', {
                  workspaceId: options.workspaceId,
                  createId,
                  now,
                  agentId: receipt.agentId,
                  ...(receipt.projectId === undefined ? {} : { projectId: receipt.projectId }),
                  payload: {
                    planId: receipt.planId,
                    operationId: receipt.id,
                    errorCode: failed.failureCode,
                  },
                }),
              );
            }
            await options.canonicalStore.writeOperationReceipt(failed);
            reconciled.push(failed);
          } catch {
            await markAmbiguous('REDIS_PROJECTION_INCONSISTENT');
          }
          continue;
        }
        const decision = reconcileOperation({
          state: receipt.state,
          expectedHashes: receipt.committedHashes,
          observedHashes,
        });
        if (decision.action !== 'rebuild-redis') {
          await markAmbiguous('AMBIGUOUS_FILESYSTEM_STATE');
          continue;
        }
        const completed = configOperationReceiptSchema.parse({
          ...receipt,
          state: 'completed',
          failureCode: undefined,
          updatedAt: now().toISOString(),
        });
        if (plan.state === 'applying' && projectedOperation === null) {
          await options.repository.completeConfigPlan(
            'applying',
            configPlanSchema.parse({
              ...plan,
              state: 'applied',
              operationId: completed.id,
              ...(completed.snapshotId === undefined ? {} : { snapshotId: completed.snapshotId }),
            }),
            completed,
            configEvent('config.reconciled', {
              workspaceId: options.workspaceId,
              createId,
              now,
              agentId: completed.agentId,
              ...(completed.projectId === undefined ? {} : { projectId: completed.projectId }),
              payload: { operationId: completed.id, action: decision.action },
            }),
          );
        } else if (plan.state !== 'applied' || projectedOperation?.id !== completed.id) {
          await markAmbiguous('REDIS_PROJECTION_INCONSISTENT');
          continue;
        }
        await options.canonicalStore.writeManagedTargets(completed);
        await options.canonicalStore.writeOperationReceipt(completed);
        reconciled.push(completed);
      }
      if (ambiguousOperationIds.length > 0) {
        throw new ApplicationError(
          'CONFIG_RECONCILIATION_REQUIRED',
          'One or more configuration operations require human review.',
          503,
          {
            operationIds: ambiguousOperationIds.join(','),
            operationCount: ambiguousOperationIds.length,
          },
        );
      }
      return reconciled;
    },
  };
}
