import { createHash, randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createMessageRepository,
  createRedisKeys,
  createRuntimeRepository,
  createWorkflowRepository,
  type CreateWorkflowInput,
  type MessageRepository,
  type RedisCommandClient,
  type RuntimeRepository,
  type WorkflowRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'workflow creation Function',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let runtime: RuntimeRepository;
    let workflows: WorkflowRepository;
    let messages: MessageRepository;

    const input = (suffix: string, overrides: Partial<CreateWorkflowInput> = {}) => {
      const rootCorrelationId = `correlation-${suffix}`;
      const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
      const value: CreateWorkflowInput = {
        workflow: {
          id: `workflow-${suffix}`,
          projectId: 'project-1',
          coordinatorSessionId: 'session-source',
          rootCorrelationId,
          objective: `Complete workflow ${suffix}.`,
          createFingerprint: fingerprint(`workflow:${suffix}`),
        },
        firstMessage: {
          id: `message-${suffix}`,
          correlationId: rootCorrelationId,
          projectId: 'project-1',
          sourceSessionId: 'session-source',
          sourceAgentId: 'codex',
          targetSessionId: 'session-target',
          targetAgentId: 'gemini',
          selectionReason: 'direct target session session-target',
          kind: 'instruction',
          subject: `Workflow ${suffix}`,
          content: `Execute workflow ${suffix} and return evidence.`,
          evidenceRequirements: ['test_result'],
          timeoutMs: 120_000,
          requestFingerprint: fingerprint(`message:${suffix}`),
        },
        workspaceId: 'local',
        eventId: `event-${suffix}`,
      };
      return {
        ...value,
        ...overrides,
        workflow: { ...value.workflow, ...overrides.workflow },
        firstMessage: { ...value.firstMessage, ...overrides.firstMessage },
      };
    };

    const workflowCommand = (
      value: CreateWorkflowInput,
      projectEventProjectId = value.firstMessage.projectId,
    ) => [
      'FCALL',
      registry.functions.workflowCreate,
      '21',
      keys.workflow(value.workflow.id),
      keys.workflowRootCorrelation(value.workflow.rootCorrelationId),
      keys.workflowsIndex,
      keys.projectWorkflows(value.workflow.projectId),
      keys.coordinatorSessionWorkflows(value.workflow.coordinatorSessionId),
      keys.workflowMessages(value.workflow.id),
      keys.message(value.firstMessage.id),
      keys.messageCorrelation(value.firstMessage.correlationId),
      keys.messageIdempotency(value.firstMessage.sourceSessionId, value.firstMessage.id),
      keys.messagesIndex,
      keys.projectMessages(value.firstMessage.projectId),
      keys.sourceSessionMessages(value.firstMessage.sourceSessionId),
      keys.targetSessionMessages(value.firstMessage.targetSessionId),
      keys.messageDeadlines,
      keys.session(value.firstMessage.sourceSessionId),
      keys.sessionPresence(value.firstMessage.sourceSessionId),
      keys.session(value.firstMessage.targetSessionId),
      keys.sessionPresence(value.firstMessage.targetSessionId),
      keys.sessionInbox(value.firstMessage.targetSessionId),
      keys.globalEvents,
      keys.projectEvents(projectEventProjectId),
      JSON.stringify(value.workflow),
      JSON.stringify(value.firstMessage),
      value.workspaceId,
      value.eventId,
    ];

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      runtime = createRuntimeRepository({ client: commandClient, keys, functions: registry });
      workflows = createWorkflowRepository({ client: commandClient, keys, functions: registry });
      messages = createMessageRepository({ client: commandClient, keys, functions: registry });
      await runtime.registerProject({
        project: {
          id: 'project-1',
          name: 'Workflow tests',
          localPath: 'C:/workspace/workflows',
          canonicalPath: 'C:/workspace/workflows',
          identityPath: 'c:/workspace/workflows',
          pathIdentityHash: 'a'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-project',
      });
      for (const session of [
        { id: 'session-source', agentId: 'codex' },
        { id: 'session-target', agentId: 'gemini' },
      ]) {
        await runtime.registerSession({
          session: {
            ...session,
            projectId: 'project-1',
            status: 'starting',
            workingDirectory: 'C:/workspace/workflows',
            metadataJson: '{}',
          },
          workspaceId: 'local',
          eventId: `event-${session.id}`,
          presenceTtlMs: 300_000,
        });
      }
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
          if (reply[1].length > 0) {
            await commandClient.sendCommand(['DEL', ...reply[1]]);
          }
        } while (cursor !== '0');
        await commandClient.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]);
        await client.quit();
      }
    });

    it('atomically creates revision one and its first durable message without a wake', async () => {
      const result = await workflows.create(input('happy'));

      expect(result).toMatchObject({
        status: 'created',
        workflow: {
          id: 'workflow-happy',
          revision: 1,
          state: 'active',
          currentMessageId: 'message-happy',
        },
        message: { id: 'message-happy', state: 'queued' },
      });
      await expect(workflows.get('workflow-happy')).resolves.toEqual(result.workflow);
      await expect(workflows.getByRootCorrelation('correlation-happy')).resolves.toEqual(
        result.workflow,
      );
      await expect(messages.listByWorkflow('workflow-happy')).resolves.toEqual([result.message]);
      await expect(
        commandClient.sendCommand([
          'ZSCORE',
          keys.workflowMessages('workflow-happy'),
          'message-happy',
        ]),
      ).resolves.toBe(1);
      await expect(
        commandClient.sendCommand(['HGET', keys.message('message-happy'), 'workflowRevision']),
      ).resolves.toBe('1');
      await expect(
        commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
      ).resolves.toBe(1);
      await expect(commandClient.sendCommand(['XLEN', keys.wakeStream])).resolves.toBe(0);
      await expect(commandClient.sendCommand(['ZCARD', keys.wakeIntentsIndex])).resolves.toBe(0);
    });

    it('returns the committed workflow on semantic retry after sessions go offline', async () => {
      const first = await workflows.create(input('retry'));
      const before = await Promise.all([
        commandClient.sendCommand(['XLEN', keys.globalEvents]),
        commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
        commandClient.sendCommand(['ZCARD', keys.workflowsIndex]),
        commandClient.sendCommand(['ZCARD', keys.messagesIndex]),
      ]);
      await commandClient.sendCommand(['DEL', keys.sessionPresence('session-source')]);
      await commandClient.sendCommand(['DEL', keys.sessionPresence('session-target')]);

      const retry = input('retry', {
        workflow: { id: 'workflow-retry-regenerated' } as CreateWorkflowInput['workflow'],
        firstMessage: { id: 'message-retry-regenerated' } as CreateWorkflowInput['firstMessage'],
        eventId: 'event-retry-regenerated',
      });
      await expect(workflows.create(retry)).resolves.toEqual({ ...first, status: 'existing' });
      await expect(
        Promise.all([
          commandClient.sendCommand(['XLEN', keys.globalEvents]),
          commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
          commandClient.sendCommand(['ZCARD', keys.workflowsIndex]),
          commandClient.sendCommand(['ZCARD', keys.messagesIndex]),
        ]),
      ).resolves.toEqual(before);
      await commandClient.sendCommand([
        'SET',
        keys.sessionPresence('session-source'),
        'session-source',
        'PX',
        '300000',
      ]);
      await commandClient.sendCommand([
        'SET',
        keys.sessionPresence('session-target'),
        'session-target',
        'PX',
        '300000',
      ]);

      await commandClient.sendCommand(['DEL', keys.sessionPresence('session-source')]);
      await expect(workflows.create(input('offline-coordinator'))).rejects.toMatchObject({
        code: 'SOURCE_SESSION_INVALID',
      });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflow('workflow-offline-coordinator')]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand([
          'EXISTS',
          keys.workflowRootCorrelation('correlation-offline-coordinator'),
        ]),
      ).resolves.toBe(0);
      await expect(
        Promise.all([
          commandClient.sendCommand(['XLEN', keys.globalEvents]),
          commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
          commandClient.sendCommand(['ZCARD', keys.workflowsIndex]),
          commandClient.sendCommand(['ZCARD', keys.messagesIndex]),
        ]),
      ).resolves.toEqual(before);
      await commandClient.sendCommand([
        'SET',
        keys.sessionPresence('session-source'),
        'session-source',
        'PX',
        '300000',
      ]);
    });

    it('replays through the immutable first message after the active step advances', async () => {
      const value = input('advanced');
      const first = await workflows.create(value);
      await commandClient.sendCommand([
        'HSET',
        keys.workflow(value.workflow.id),
        'revision',
        '2',
        'currentMessageId',
        'message-advanced-next',
      ]);

      await expect(
        workflows.getByRootCorrelation(value.workflow.rootCorrelationId),
      ).resolves.toMatchObject({
        id: value.workflow.id,
        revision: 2,
        currentMessageId: 'message-advanced-next',
      });
      const retry = input('advanced', {
        workflow: { id: 'workflow-advanced-regenerated' } as CreateWorkflowInput['workflow'],
        firstMessage: {
          id: 'message-advanced-regenerated',
        } as CreateWorkflowInput['firstMessage'],
        eventId: 'event-advanced-regenerated',
      });
      await expect(workflows.create(retry)).resolves.toEqual({
        status: 'existing',
        workflow: {
          ...first.workflow,
          revision: 2,
          currentMessageId: 'message-advanced-next',
        },
        message: first.message,
      });
    });

    it('replays through the immutable first message after completion clears the current step', async () => {
      const value = input('completed');
      const first = await workflows.create(value);
      await commandClient.sendCommand([
        'HSET',
        keys.workflow(value.workflow.id),
        'revision',
        '2',
        'state',
        'completed',
      ]);
      await commandClient.sendCommand([
        'HDEL',
        keys.workflow(value.workflow.id),
        'currentMessageId',
      ]);

      const retry = input('completed', {
        workflow: { id: 'workflow-completed-regenerated' } as CreateWorkflowInput['workflow'],
        firstMessage: {
          id: 'message-completed-regenerated',
        } as CreateWorkflowInput['firstMessage'],
        eventId: 'event-completed-regenerated',
      });
      await expect(workflows.create(retry)).resolves.toEqual({
        status: 'existing',
        workflow: {
          ...first.workflow,
          revision: 2,
          state: 'completed',
          currentMessageId: undefined,
        },
        message: first.message,
      });
    });

    it('rejects an existing receipt when the authoritative workflow fingerprint is corrupt', async () => {
      const value = input('corrupt-workflow-fingerprint');
      await workflows.create(value);
      await commandClient.sendCommand([
        'HSET',
        keys.workflow(value.workflow.id),
        'createFingerprint',
        'd'.repeat(64),
      ]);

      const reply = JSON.parse(String(await commandClient.sendCommand(workflowCommand(value)))) as {
        status: string;
        code?: string;
      };

      expect(reply).toEqual({ status: 'error', code: 'REDIS_STATE_INVALID' });
    });

    it('rejects semantic replay when the private message workflow link is corrupt', async () => {
      const value = input('corrupt-message-link');
      await workflows.create(value);
      await commandClient.sendCommand([
        'HSET',
        keys.message(value.firstMessage.id),
        'workflowId',
        'workflow-other',
        'workflowRevision',
        '2',
      ]);

      const retry = input('corrupt-message-link', {
        workflow: {
          id: 'workflow-corrupt-message-link-regenerated',
        } as CreateWorkflowInput['workflow'],
        firstMessage: {
          id: 'message-corrupt-message-link-regenerated',
        } as CreateWorkflowInput['firstMessage'],
        eventId: 'event-corrupt-message-link-regenerated',
      });
      await expect(workflows.create(retry)).rejects.toMatchObject({
        code: 'REDIS_STATE_INVALID',
      });
    });

    it('rejects a root lookup whose stored workflow identity was replaced', async () => {
      const value = input('replaced-workflow-identity');
      await workflows.create(value);
      await commandClient.sendCommand([
        'HSET',
        keys.workflow(value.workflow.id),
        'id',
        'workflow-other',
      ]);
      await commandClient.sendCommand([
        'HSET',
        keys.message(value.firstMessage.id),
        'workflowId',
        'workflow-other',
      ]);

      await expect(
        workflows.getByRootCorrelation(value.workflow.rootCorrelationId),
      ).rejects.toMatchObject({ code: 'REDIS_DATA_INVALID' });
    });

    it('rejects a conflicting root and unavailable participants without partial writes', async () => {
      await workflows.create(input('conflict'));
      const before = await Promise.all([
        commandClient.sendCommand(['XLEN', keys.globalEvents]),
        commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
        commandClient.sendCommand(['ZCARD', keys.workflowsIndex]),
        commandClient.sendCommand(['ZCARD', keys.messagesIndex]),
      ]);
      await expect(
        workflows.create(
          input('conflict', {
            workflow: { createFingerprint: 'c'.repeat(64) } as CreateWorkflowInput['workflow'],
          }),
        ),
      ).rejects.toMatchObject({ code: 'WORKFLOW_CREATE_CONFLICT' });

      await commandClient.sendCommand(['DEL', keys.sessionPresence('session-target')]);
      await expect(workflows.create(input('offline-target'))).rejects.toMatchObject({
        code: 'TARGET_SESSION_UNAVAILABLE',
      });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflow('workflow-offline-target')]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand([
          'EXISTS',
          keys.workflowRootCorrelation('correlation-offline-target'),
        ]),
      ).resolves.toBe(0);
      await expect(
        Promise.all([
          commandClient.sendCommand(['XLEN', keys.globalEvents]),
          commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
          commandClient.sendCommand(['ZCARD', keys.workflowsIndex]),
          commandClient.sendCommand(['ZCARD', keys.messagesIndex]),
        ]),
      ).resolves.toEqual(before);
      await commandClient.sendCommand([
        'SET',
        keys.sessionPresence('session-target'),
        'session-target',
        'PX',
        '300000',
      ]);
    });

    it('rejects an aliased declared key before any mutation', async () => {
      const value = input('alias');
      const command = workflowCommand(value, 'wrong-project');

      const reply = JSON.parse(String(await commandClient.sendCommand(command))) as {
        status: string;
        code: string;
      };
      expect(reply).toEqual({ status: 'error', code: 'REDIS_ARGUMENT_INVALID' });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflow(value.workflow.id)]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['EXISTS', keys.message(value.firstMessage.id)]),
      ).resolves.toBe(0);
    });

    it('preflights a corrupt workflow index type before message or inbox writes', async () => {
      const value = input('wrong-type');
      await commandClient.sendCommand(['SET', keys.workflowMessages(value.workflow.id), 'bad']);
      const inboxBefore = await commandClient.sendCommand([
        'XLEN',
        keys.sessionInbox('session-target'),
      ]);
      const eventsBefore = await commandClient.sendCommand(['XLEN', keys.globalEvents]);

      await expect(workflows.create(value)).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflow(value.workflow.id)]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['EXISTS', keys.message(value.firstMessage.id)]),
      ).resolves.toBe(0);
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        eventsBefore,
      );
      await expect(
        commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
      ).resolves.toBe(inboxBefore);
    });
  },
);
