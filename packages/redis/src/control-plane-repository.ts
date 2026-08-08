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
  projectAgentBindingSchema,
  type AgentDefinition,
  type CapabilityBinding,
  type CapabilityPackage,
  type CapabilityProfile,
  type ConfigDrift,
  type ConfigOperationReceipt,
  type ConfigPlan,
  type ConfigPlanState,
  type ContextFootprint,
  type ContextSource,
  type ProjectAgentBinding,
  type RuntimeEvent,
} from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

type ProjectionMode = 'create' | 'update' | 'upsert';
type Schema<Value> = {
  safeParse(value: unknown): { success: true; data: Value } | { success: false };
};

export type ControlPlaneRepositoryDependencies = {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
};

export interface ControlPlaneRepository {
  appendEvent(event: RuntimeEvent): Promise<void>;
  putAgentDefinition(
    mode: ProjectionMode,
    agent: AgentDefinition,
    event: RuntimeEvent,
  ): Promise<void>;
  getAgentDefinition(agentId: string): Promise<AgentDefinition | null>;
  listAgentDefinitions(limit?: number): Promise<AgentDefinition[]>;
  putProjectAgentBinding(
    mode: ProjectionMode,
    binding: ProjectAgentBinding,
    event: RuntimeEvent,
  ): Promise<void>;
  deleteProjectAgentBinding(binding: ProjectAgentBinding, event: RuntimeEvent): Promise<void>;
  getProjectAgentBinding(bindingId: string): Promise<ProjectAgentBinding | null>;
  listProjectAgentBindings(projectId: string, limit?: number): Promise<ProjectAgentBinding[]>;
  putCapability(
    mode: ProjectionMode,
    capability: CapabilityPackage,
    event: RuntimeEvent,
  ): Promise<void>;
  getCapability(capabilityId: string): Promise<CapabilityPackage | null>;
  listCapabilities(limit?: number): Promise<CapabilityPackage[]>;
  putCapabilityBinding(
    mode: ProjectionMode,
    binding: CapabilityBinding,
    event: RuntimeEvent,
  ): Promise<void>;
  deleteCapabilityBinding(binding: CapabilityBinding, event: RuntimeEvent): Promise<void>;
  listCapabilityBindings(limit?: number): Promise<CapabilityBinding[]>;
  putProfile(mode: ProjectionMode, profile: CapabilityProfile, event: RuntimeEvent): Promise<void>;
  getProfile(profileId: string): Promise<CapabilityProfile | null>;
  listProfiles(limit?: number): Promise<CapabilityProfile[]>;
  transitionConfigPlan(
    expectedState: ConfigPlanState | '__missing__',
    plan: ConfigPlan,
    event: RuntimeEvent,
  ): Promise<void>;
  completeConfigPlan(
    expectedState: ConfigPlanState,
    plan: ConfigPlan,
    operation: ConfigOperationReceipt,
    event: RuntimeEvent,
  ): Promise<void>;
  getConfigPlan(planId: string): Promise<ConfigPlan | null>;
  listConfigPlans(limit?: number): Promise<ConfigPlan[]>;
  putConfigOperation(
    mode: ProjectionMode,
    operation: ConfigOperationReceipt,
    event: RuntimeEvent,
  ): Promise<void>;
  getConfigOperation(operationId: string): Promise<ConfigOperationReceipt | null>;
  listConfigOperations(limit?: number): Promise<ConfigOperationReceipt[]>;
  putConfigDrift(mode: ProjectionMode, drift: ConfigDrift, event: RuntimeEvent): Promise<void>;
  deleteConfigDrift(drift: ConfigDrift, event: RuntimeEvent): Promise<void>;
  getConfigDrift(driftId: string): Promise<ConfigDrift | null>;
  listConfigDrifts(limit?: number): Promise<ConfigDrift[]>;
  putContextSource(mode: ProjectionMode, source: ContextSource, event: RuntimeEvent): Promise<void>;
  deleteContextSource(source: ContextSource, event: RuntimeEvent): Promise<void>;
  listContextSources(limit?: number): Promise<ContextSource[]>;
  putContextFootprint(footprint: ContextFootprint, event: RuntimeEvent): Promise<void>;
  getContextFootprint(projectId: string, agentId: string): Promise<ContextFootprint | null>;
}

function textReply(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid value.');
}

function decode(value: unknown): unknown {
  const text = textReply(value);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned malformed JSON.');
  }
}

function parseProjection<Value>(value: unknown, schema: Schema<Value>): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RedisRepositoryError(
      'REDIS_DATA_INVALID',
      'Redis returned an incompatible control-plane projection.',
    );
  }
  return parsed.data;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid index.');
  }
  return [...value].sort() as string[];
}

function functionStatus(value: unknown, conflictCode: string, notFoundCode: string): void {
  const decoded = decode(value);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new RedisRepositoryError('REDIS_DATA_INVALID', 'Redis returned an invalid transition.');
  }
  const status = (decoded as Record<string, unknown>)['status'];
  if (status === 'created' || status === 'updated' || status === 'deleted') return;
  if (status === 'conflict') throw new RedisRepositoryError(conflictCode, 'Projection conflict.');
  if (status === 'not_found') throw new RedisRepositoryError(notFoundCode, 'Projection not found.');
  if (status === 'state_conflict') {
    throw new RedisRepositoryError('CONFIG_PLAN_SUPERSEDED', 'Config plan state changed.');
  }
  const code = (decoded as Record<string, unknown>)['code'];
  throw new RedisRepositoryError(
    typeof code === 'string' ? code : 'REDIS_DATA_INVALID',
    'Redis rejected the control-plane transition.',
  );
}

export function createControlPlaneRepository(
  dependencies: ControlPlaneRepositoryDependencies,
): ControlPlaneRepository {
  const { client, keys, functions } = dependencies;

  const read = async <Value>(key: string, schema: Schema<Value>): Promise<Value | null> => {
    const value = await client.sendCommand(['HGET', key, 'json']);
    const decoded = decode(value);
    return decoded === null ? null : parseProjection(decoded, schema);
  };

  const list = async <Value>(
    index: string,
    keyForId: (id: string) => string,
    schema: Schema<Value>,
    limit = 1000,
  ): Promise<Value[]> => {
    const ids = stringArray(await client.sendCommand(['SMEMBERS', index])).slice(0, limit);
    const values: Value[] = [];
    for (const id of ids) {
      const value = await read(keyForId(id), schema);
      if (value !== null) values.push(value);
    }
    return values;
  };

  const upsert = async <Entity extends { id: string }>(
    mode: ProjectionMode,
    entityKey: string,
    primaryIndex: string,
    secondaryIndexes: string[],
    entity: Entity,
    event: RuntimeEvent,
    conflictCode: string,
    notFoundCode: string,
  ): Promise<void> => {
    const projectStream =
      event.projectId === undefined ? keys.globalEvents : keys.projectEvents(event.projectId);
    const transition = await client.sendCommand([
      'FCALL',
      functions.functions.controlUpsert,
      String(4 + secondaryIndexes.length),
      entityKey,
      primaryIndex,
      keys.globalEvents,
      projectStream,
      ...secondaryIndexes,
      mode,
      JSON.stringify(entity),
      JSON.stringify(event),
      entity.id,
    ]);
    functionStatus(transition, conflictCode, notFoundCode);
  };

  const remove = async (
    entityKey: string,
    primaryIndex: string,
    secondaryIndexes: string[],
    entity: { id: string },
    event: RuntimeEvent,
    notFoundCode: string,
  ): Promise<void> => {
    const projectStream =
      event.projectId === undefined ? keys.globalEvents : keys.projectEvents(event.projectId);
    const transition = await client.sendCommand([
      'FCALL',
      functions.functions.controlDelete,
      String(4 + secondaryIndexes.length),
      entityKey,
      primaryIndex,
      keys.globalEvents,
      projectStream,
      ...secondaryIndexes,
      JSON.stringify(entity),
      JSON.stringify(event),
      entity.id,
    ]);
    functionStatus(transition, 'REDIS_STATE_INVALID', notFoundCode);
  };

  return {
    async appendEvent(event) {
      const eventJson = JSON.stringify(event);
      await client.sendCommand(['XADD', keys.globalEvents, '*', 'event', eventJson]);
      if (event.projectId !== undefined) {
        await client.sendCommand([
          'XADD',
          keys.projectEvents(event.projectId),
          '*',
          'event',
          eventJson,
        ]);
      }
    },
    putAgentDefinition: (mode, agent, event) =>
      upsert(
        mode,
        keys.agentDefinition(agent.id),
        keys.agentDefinitionsIndex,
        [],
        agent,
        event,
        'AGENT_DEFINITION_CONFLICT',
        'AGENT_DEFINITION_NOT_FOUND',
      ),
    getAgentDefinition: (agentId) => read(keys.agentDefinition(agentId), agentDefinitionSchema),
    listAgentDefinitions: (limit) =>
      list(keys.agentDefinitionsIndex, keys.agentDefinition, agentDefinitionSchema, limit),

    putProjectAgentBinding: (mode, binding, event) =>
      upsert(
        mode,
        keys.projectAgentBinding(binding.id),
        keys.projectAgentBindings(binding.projectId),
        [keys.agentProjectBindings(binding.agentId)],
        binding,
        event,
        'PROJECT_AGENT_BINDING_CONFLICT',
        'PROJECT_AGENT_BINDING_NOT_FOUND',
      ),
    deleteProjectAgentBinding: (binding, event) =>
      remove(
        keys.projectAgentBinding(binding.id),
        keys.projectAgentBindings(binding.projectId),
        [keys.agentProjectBindings(binding.agentId)],
        binding,
        event,
        'PROJECT_AGENT_BINDING_NOT_FOUND',
      ),
    getProjectAgentBinding: (bindingId) =>
      read(keys.projectAgentBinding(bindingId), projectAgentBindingSchema),
    listProjectAgentBindings: (projectId, limit) =>
      list(
        keys.projectAgentBindings(projectId),
        keys.projectAgentBinding,
        projectAgentBindingSchema,
        limit,
      ),

    putCapability: (mode, capability, event) =>
      upsert(
        mode,
        keys.capability(capability.id),
        keys.capabilitiesIndex,
        [
          keys.capabilitiesByKind(capability.kind),
          ...(capability.projectId === undefined
            ? []
            : [keys.projectCapabilities(capability.projectId)]),
        ],
        capability,
        event,
        'CAPABILITY_CONFLICT',
        'CAPABILITY_NOT_FOUND',
      ),
    getCapability: (capabilityId) => read(keys.capability(capabilityId), capabilityPackageSchema),
    listCapabilities: (limit) =>
      list(keys.capabilitiesIndex, keys.capability, capabilityPackageSchema, limit),

    putCapabilityBinding: (mode, binding, event) =>
      upsert(
        mode,
        keys.capabilityBinding(binding.id),
        keys.capabilityBindingsIndex,
        [
          ...(binding.projectId === undefined
            ? []
            : [keys.projectCapabilityBindings(binding.projectId)]),
          ...(binding.agentId === undefined ? [] : [keys.agentCapabilities(binding.agentId)]),
        ],
        binding,
        event,
        'CAPABILITY_CONFLICT',
        'CAPABILITY_NOT_FOUND',
      ),
    deleteCapabilityBinding: (binding, event) =>
      remove(
        keys.capabilityBinding(binding.id),
        keys.capabilityBindingsIndex,
        [
          ...(binding.projectId === undefined
            ? []
            : [keys.projectCapabilityBindings(binding.projectId)]),
          ...(binding.agentId === undefined ? [] : [keys.agentCapabilities(binding.agentId)]),
        ],
        binding,
        event,
        'CAPABILITY_NOT_FOUND',
      ),
    listCapabilityBindings: (limit) =>
      list(keys.capabilityBindingsIndex, keys.capabilityBinding, capabilityBindingSchema, limit),

    putProfile: (mode, profile, event) =>
      upsert(
        mode,
        keys.profile(profile.id),
        keys.profilesIndex,
        [],
        profile,
        event,
        'PROFILE_CONFLICT',
        'PROFILE_NOT_FOUND',
      ),
    getProfile: (profileId) => read(keys.profile(profileId), capabilityProfileSchema),
    listProfiles: (limit) => list(keys.profilesIndex, keys.profile, capabilityProfileSchema, limit),

    async transitionConfigPlan(expectedState, plan, event) {
      const projectStream =
        plan.projectId === undefined ? keys.globalEvents : keys.projectEvents(plan.projectId);
      const transition = await client.sendCommand([
        'FCALL',
        functions.functions.controlPlanTransition,
        '4',
        keys.configPlan(plan.id),
        keys.globalEvents,
        projectStream,
        keys.configPlansExpiry,
        expectedState,
        JSON.stringify(plan),
        JSON.stringify(event),
        plan.id,
        String(Date.parse(plan.expiresAt)),
        'track',
      ]);
      functionStatus(transition, 'CONFIG_PLAN_SUPERSEDED', 'CONFIG_PLAN_NOT_FOUND');
    },
    async completeConfigPlan(expectedState, plan, operation, event) {
      const projectStream =
        plan.projectId === undefined ? keys.globalEvents : keys.projectEvents(plan.projectId);
      const transition = await client.sendCommand([
        'FCALL',
        functions.functions.controlPlanComplete,
        '6',
        keys.configPlan(plan.id),
        keys.configOperation(operation.id),
        keys.configOperationsIndex,
        keys.globalEvents,
        projectStream,
        keys.configPlansExpiry,
        expectedState,
        JSON.stringify(plan),
        JSON.stringify(operation),
        JSON.stringify(event),
        plan.id,
        String(Date.parse(plan.expiresAt)),
      ]);
      functionStatus(transition, 'CONFIG_PLAN_SUPERSEDED', 'CONFIG_PLAN_NOT_FOUND');
    },
    getConfigPlan: (planId) => read(keys.configPlan(planId), configPlanSchema),
    async listConfigPlans(limit = 1000) {
      const ids = stringArray(
        await client.sendCommand([
          'ZRANGE',
          keys.configPlansExpiry,
          '0',
          String(Math.max(0, limit - 1)),
        ]),
      );
      const values = await Promise.all(
        ids.map((id) => read(keys.configPlan(id), configPlanSchema)),
      );
      return values.filter((value): value is ConfigPlan => value !== null);
    },

    putConfigOperation: (mode, operation, event) =>
      upsert(
        mode,
        keys.configOperation(operation.id),
        keys.configOperationsIndex,
        [],
        operation,
        event,
        'CONFIG_RECONCILIATION_REQUIRED',
        'CONFIG_RECONCILIATION_REQUIRED',
      ),
    getConfigOperation: (operationId) =>
      read(keys.configOperation(operationId), configOperationReceiptSchema),
    listConfigOperations: (limit) =>
      list(keys.configOperationsIndex, keys.configOperation, configOperationReceiptSchema, limit),

    putConfigDrift: (mode, drift, event) =>
      upsert(
        mode,
        keys.configDrift(drift.id),
        keys.configDriftsIndex,
        [],
        drift,
        event,
        'NATIVE_CONFIG_DRIFTED',
        'NATIVE_CONFIG_DRIFTED',
      ),
    deleteConfigDrift: (drift, event) =>
      remove(
        keys.configDrift(drift.id),
        keys.configDriftsIndex,
        [],
        drift,
        event,
        'NATIVE_CONFIG_DRIFTED',
      ),
    getConfigDrift: (driftId) => read(keys.configDrift(driftId), configDriftSchema),
    listConfigDrifts: (limit) =>
      list(keys.configDriftsIndex, keys.configDrift, configDriftSchema, limit),

    putContextSource: (mode, source, event) =>
      upsert(
        mode,
        keys.contextSource(source.id),
        keys.contextSourcesIndex,
        [
          ...(source.projectId === undefined ? [] : [keys.projectContextSources(source.projectId)]),
          ...(source.agentId === undefined ? [] : [keys.agentContextSources(source.agentId)]),
        ],
        source,
        event,
        'CONTEXT_SOURCE_INVALID',
        'CONTEXT_SOURCE_INVALID',
      ),
    deleteContextSource: (source, event) =>
      remove(
        keys.contextSource(source.id),
        keys.contextSourcesIndex,
        [
          ...(source.projectId === undefined ? [] : [keys.projectContextSources(source.projectId)]),
          ...(source.agentId === undefined ? [] : [keys.agentContextSources(source.agentId)]),
        ],
        source,
        event,
        'CONTEXT_SOURCE_INVALID',
      ),
    listContextSources: (limit) =>
      list(keys.contextSourcesIndex, keys.contextSource, contextSourceSchema, limit),

    async putContextFootprint(footprint, event) {
      if (footprint.projectId === undefined || footprint.agentId === undefined) {
        throw new RedisRepositoryError(
          'CONTEXT_SOURCE_INVALID',
          'A projected context footprint requires project and agent identifiers.',
        );
      }
      const id = `${footprint.projectId}:${footprint.agentId}`;
      await upsert(
        'upsert',
        keys.contextFootprint(footprint.projectId, footprint.agentId),
        keys.contextFootprintsIndex,
        [],
        { id, footprint },
        event,
        'CONTEXT_SOURCE_INVALID',
        'CONTEXT_SOURCE_INVALID',
      );
    },
    async getContextFootprint(projectId, agentId) {
      const raw = await client.sendCommand([
        'HGET',
        keys.contextFootprint(projectId, agentId),
        'json',
      ]);
      const decoded = decode(raw);
      if (
        decoded === null ||
        typeof decoded !== 'object' ||
        Array.isArray(decoded) ||
        !('footprint' in decoded)
      ) {
        return decoded === null
          ? null
          : (() => {
              throw new RedisRepositoryError(
                'REDIS_DATA_INVALID',
                'Redis returned an invalid context footprint projection.',
              );
            })();
      }
      return parseProjection((decoded as { footprint: unknown }).footprint, contextFootprintSchema);
    },
  };
}
