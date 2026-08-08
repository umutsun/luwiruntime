import { describe, expect, it } from 'vitest';

import { agentDefinitionSchema, createRuntimeEvent, type AgentDefinition } from '@luwi/protocol';

import {
  createControlPlaneRepository,
  createFunctionRegistry,
  createRedisKeys,
  type RedisCommandClient,
} from './index.js';

class FakeClient implements RedisCommandClient {
  readonly commands: string[][] = [];
  readonly projections = new Map<string, string>();
  readonly indexes = new Map<string, string[]>();

  async sendCommand(arguments_: readonly string[]): Promise<unknown> {
    const command = [...arguments_];
    this.commands.push(command);
    if (command[0] === 'FCALL') {
      const keyCount = Number(command[2]);
      const entityKey = command[3] ?? '';
      const entityJson = command[3 + keyCount + 1] ?? '{}';
      const entity = JSON.parse(entityJson) as { id: string };
      this.projections.set(entityKey, entityJson);
      return JSON.stringify({ status: 'created', entity });
    }
    if (command[0] === 'HGET') {
      return this.projections.get(command[1] ?? '') ?? null;
    }
    if (command[0] === 'SMEMBERS') {
      return this.indexes.get(command[1] ?? '') ?? [];
    }
    throw new Error(`Unexpected command: ${command.join(' ')}`);
  }
}

function fixture(): AgentDefinition {
  return agentDefinitionSchema.parse({
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
}

describe('Redis control-plane repository', () => {
  it('atomically creates an agent projection, indexes it, and persists its event', async () => {
    const client = new FakeClient();
    const keys = createRedisKeys();
    const functions = createFunctionRegistry();
    const repository = createControlPlaneRepository({ client, keys, functions });
    const agent = fixture();
    const event = createRuntimeEvent(
      {
        type: 'agent.definition.registered',
        workspaceId: 'local',
        agentId: agent.id,
        payload: { agentId: agent.id },
      },
      {
        createId: () => 'event-1',
        now: () => new Date('2026-07-29T12:00:00.000Z'),
      },
    );

    await repository.putAgentDefinition('create', agent, event);

    expect(client.commands[0]).toEqual([
      'FCALL',
      functions.functions.controlUpsert,
      '4',
      keys.agentDefinition(agent.id),
      keys.agentDefinitionsIndex,
      keys.globalEvents,
      keys.globalEvents,
      'create',
      JSON.stringify(agent),
      JSON.stringify(event),
      agent.id,
    ]);
  });

  it('validates projections read back from Redis', async () => {
    const client = new FakeClient();
    const keys = createRedisKeys();
    const repository = createControlPlaneRepository({
      client,
      keys,
      functions: createFunctionRegistry(),
    });
    client.projections.set(keys.agentDefinition('codex-main'), JSON.stringify(fixture()));

    await expect(repository.getAgentDefinition('codex-main')).resolves.toEqual(fixture());

    client.projections.set(
      keys.agentDefinition('codex-main'),
      JSON.stringify({ ...fixture(), enabled: 'yes' }),
    );
    await expect(repository.getAgentDefinition('codex-main')).rejects.toMatchObject({
      code: 'REDIS_DATA_INVALID',
    });
  });
});
