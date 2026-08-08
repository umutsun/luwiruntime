import { randomUUID } from 'node:crypto';

import {
  agentDefinitionSchema,
  capabilityBindingSchema,
  capabilityPackageSchema,
  capabilityProfileSchema,
  configDriftSchema,
  configOperationReceiptSchema,
  configPlanSchema,
  contextFootprintSchema,
  contextSourceSchema,
  createRuntimeEvent,
  type AgentDefinition,
} from '@luwi/protocol';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createControlPlaneRepository,
  createFunctionRegistry,
  createRedisKeys,
  type ControlPlaneRepository,
  type RedisCommandClient,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'control-plane Redis Functions',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let repository: ControlPlaneRepository;

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      repository = createControlPlaneRepository({
        client: commandClient,
        keys,
        functions: registry,
      });
    });

    afterAll(async () => {
      if (client?.isOpen) {
        let cursor = '0';
        do {
          const reply = (await commandClient.sendCommand([
            'SCAN',
            cursor,
            'MATCH',
            `${namespace}:*`,
            'COUNT',
            '100',
          ])) as [string, string[]];
          cursor = reply[0];
          if (reply[1].length > 0) await commandClient.sendCommand(['DEL', ...reply[1]]);
        } while (cursor !== '0');
        await commandClient.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]);
        await client.quit();
      }
    });

    const agent = (): AgentDefinition =>
      agentDefinitionSchema.parse({
        id: 'codex-main',
        kind: 'codex',
        displayName: 'Codex',
        enabled: true,
        adapterId: 'codex-native-v1',
        nativeConfigRoots: ['C:/fake/.codex'],
        createdAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        metadata: {},
      });

    const event = (id: string) =>
      createRuntimeEvent(
        {
          type: 'agent.definition.registered',
          workspaceId: 'local',
          agentId: 'codex-main',
          payload: { agentId: 'codex-main' },
        },
        { createId: () => id, now: () => new Date('2026-07-29T12:00:00.000Z') },
      );

    it('enforces create uniqueness atomically and emits one persisted event', async () => {
      const outcomes = await Promise.allSettled([
        repository.putAgentDefinition('create', agent(), event('event-1')),
        repository.putAgentDefinition('create', agent(), event('event-2')),
      ]);

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      await expect(repository.getAgentDefinition('codex-main')).resolves.toEqual(agent());
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(1);
    });

    it('atomically completes one plan and operation with one success event', async () => {
      const timestamp = '2026-07-29T12:00:00.000Z';
      const prepared = configPlanSchema.parse({
        id: 'plan-atomic',
        agentId: 'codex-main',
        state: 'prepared',
        kind: 'render',
        changes: [
          {
            path: 'C:/fixture/config.toml',
            operation: 'create',
            managementMode: 'managed-file',
            afterHash: 'a'.repeat(64),
            redactedDiff: '{"operation":"create"}',
            warnings: [],
          },
        ],
        preconditionHashes: { 'C:/fixture/config.toml': null },
        createdAt: timestamp,
        expiresAt: '2026-07-29T12:15:00.000Z',
      });
      const planEvent = (type: 'config.plan.created' | 'config.apply.started' | 'config.applied') =>
        createRuntimeEvent(
          {
            type,
            workspaceId: 'local',
            agentId: 'codex-main',
            payload: { planId: prepared.id },
          },
          { createId: randomUUID, now: () => new Date(timestamp) },
        );
      await repository.transitionConfigPlan(
        '__missing__',
        prepared,
        planEvent('config.plan.created'),
      );
      const applying = configPlanSchema.parse({ ...prepared, state: 'applying' });
      await repository.transitionConfigPlan(
        'prepared',
        applying,
        planEvent('config.apply.started'),
      );
      const operation = configOperationReceiptSchema.parse({
        id: 'operation-atomic',
        planId: prepared.id,
        agentId: 'codex-main',
        state: 'completed',
        targetPaths: ['C:/fixture/config.toml'],
        expectedHashes: { 'C:/fixture/config.toml': null },
        committedHashes: { 'C:/fixture/config.toml': 'a'.repeat(64) },
        startedAt: timestamp,
        updatedAt: timestamp,
      });
      const completed = configPlanSchema.parse({
        ...applying,
        state: 'applied',
        operationId: operation.id,
      });
      const beforeCompletion = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));

      await repository.completeConfigPlan(
        'applying',
        completed,
        operation,
        planEvent('config.applied'),
      );

      await expect(repository.getConfigPlan(prepared.id)).resolves.toEqual(completed);
      await expect(repository.getConfigOperation(operation.id)).resolves.toEqual(operation);
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        beforeCompletion + 1,
      );
      await expect(
        repository.completeConfigPlan(
          'applying',
          completed,
          operation,
          planEvent('config.applied'),
        ),
      ).rejects.toBeDefined();
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        beforeCompletion + 1,
      );
    });

    it('projects separate capability indexes, drift, context, and footprint metadata', async () => {
      const timestamp = '2026-07-29T12:00:00.000Z';
      const runtimeEvent = (
        type:
          | 'capability.registered'
          | 'capability.assigned'
          | 'profile.registered'
          | 'config.drift.detected'
          | 'config.drift.resolved'
          | 'context.source.detected'
          | 'context.source.updated'
          | 'context.footprint.measured',
        id: string,
      ) =>
        createRuntimeEvent(
          {
            type,
            workspaceId: 'local',
            projectId: 'project-1',
            agentId: 'codex-main',
            payload: { id },
          },
          { createId: () => id, now: () => new Date(timestamp) },
        );
      const capability = capabilityPackageSchema.parse({
        id: 'redis-development',
        kind: 'skill',
        name: 'Redis development',
        scope: 'project',
        projectId: 'project-1',
        source: 'luwi-project',
        checksum: 'a'.repeat(64),
        compatibleAgentKinds: ['codex'],
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
        manifest: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const binding = capabilityBindingSchema.parse({
        id: 'binding-redis',
        capabilityId: capability.id,
        scope: 'project',
        projectId: 'project-1',
        agentId: 'codex-main',
        enabled: true,
        settings: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const profile = capabilityProfileSchema.parse({
        id: 'backend',
        name: 'Backend',
        scope: 'global',
        capabilityIds: [capability.id],
        policyIds: [],
        disabledCapabilityIds: [],
        adapterSettings: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await repository.putCapability(
        'create',
        capability,
        runtimeEvent('capability.registered', 'event-capability'),
      );
      await repository.putCapabilityBinding(
        'create',
        binding,
        runtimeEvent('capability.assigned', 'event-assignment'),
      );
      await repository.putProfile(
        'create',
        profile,
        runtimeEvent('profile.registered', 'event-profile'),
      );

      await expect(
        commandClient.sendCommand(['SMEMBERS', keys.projectCapabilities('project-1')]),
      ).resolves.toEqual([capability.id]);
      await expect(
        commandClient.sendCommand(['SMEMBERS', keys.projectCapabilityBindings('project-1')]),
      ).resolves.toEqual([binding.id]);

      const drift = configDriftSchema.parse({
        id: 'drift-redis',
        agentId: 'codex-main',
        projectId: 'project-1',
        path: 'C:/fixture/config.toml',
        expectedHash: 'b'.repeat(64),
        observedHash: 'c'.repeat(64),
        severity: 'warning',
        resolution: 'manual',
        detectedAt: timestamp,
      });
      await repository.putConfigDrift(
        'create',
        drift,
        runtimeEvent('config.drift.detected', 'event-drift'),
      );
      const source = contextSourceSchema.parse({
        id: 'context-source-redis',
        projectId: 'project-1',
        agentId: 'codex-main',
        agentKind: 'codex',
        sourceType: 'skill',
        path: 'C:/fixture/SKILL.md',
        byteCount: 40,
        lineCount: 2,
        hash: 'd'.repeat(64),
        loadingScope: 'project',
        loadingMode: 'conditional',
        managementMode: 'managed-file',
        estimatedTokenCount: 10,
        estimationSource: 'estimated',
        estimationMethod: 'generic-character-estimate',
        measuredAt: timestamp,
      });
      await repository.putContextSource(
        'create',
        source,
        runtimeEvent('context.source.detected', 'event-context'),
      );
      const footprint = contextFootprintSchema.parse({
        projectId: 'project-1',
        agentId: 'codex-main',
        source: 'estimated',
        method: 'generic-character-estimate',
        totalBytes: 40,
        totalLines: 2,
        estimatedTokens: 10,
        categories: {
          skill: { bytes: 40, lines: 2, estimatedTokens: 10, sourceCount: 1 },
        },
        exactDuplicateGroups: [],
        measuredAt: timestamp,
      });
      await repository.putContextFootprint(
        footprint,
        runtimeEvent('context.footprint.measured', 'event-footprint'),
      );
      await expect(repository.getContextFootprint('project-1', 'codex-main')).resolves.toEqual(
        footprint,
      );

      await repository.deleteConfigDrift(
        drift,
        runtimeEvent('config.drift.resolved', 'event-drift-resolved'),
      );
      await repository.deleteContextSource(
        source,
        runtimeEvent('context.source.updated', 'event-context-removed'),
      );
      await expect(repository.getConfigDrift(drift.id)).resolves.toBeNull();
      await expect(repository.listContextSources()).resolves.toEqual([]);
    });
  },
);
