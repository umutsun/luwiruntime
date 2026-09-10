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
  type ContinueWorkflowInput,
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

    const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
    const input = (suffix: string, overrides: Partial<CreateWorkflowInput> = {}) => {
      const rootCorrelationId = `correlation-${suffix}`;
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

    const seedWake = async (input: {
      workflowId: string;
      messageId: string;
      correlationId: string;
      coordinatorSessionId: string;
      revision: number;
      state: 'dispatching' | 'dispatched' | 'indeterminate';
    }) => {
      const timestamp = '2026-09-09T12:00:00.000Z';
      await commandClient.sendCommand([
        'HSET',
        keys.workflow(input.workflowId),
        'state',
        'active',
        'currentWakeIntentId',
        input.messageId,
      ]);
      await commandClient.sendCommand([
        'HDEL',
        keys.workflow(input.workflowId),
        'currentHumanContinuationId',
        'humanDecision',
      ]);
      const fields = [
        'id',
        input.messageId,
        'messageId',
        input.messageId,
        'workflowId',
        input.workflowId,
        'sourceSessionId',
        input.coordinatorSessionId,
        'correlationId',
        input.correlationId,
        'terminalState',
        'responded',
        'adapter',
        'codex-queue-v1',
        'state',
        input.state,
        'createdAt',
        timestamp,
        'updatedAt',
        timestamp,
        'workspaceId',
        'local',
        'projectId',
        'project-1',
        'sourceAgentId',
        'codex',
        'workflowRevision',
        String(input.revision),
        'streamId',
        '1-0',
        'deadlineMs',
        '1999999999999',
        'fallbackContinuationId',
        `fallback-${input.messageId}`,
        'requestedEventId',
        `requested-${input.messageId}`,
        'lastEventId',
        `last-${input.messageId}`,
      ];
      if (input.state === 'dispatching') {
        fields.push(
          'dispatcherInstanceId',
          'dispatcher-1',
          'claimId',
          'claim-1',
          'attemptId',
          'attempt-1',
        );
      } else {
        fields.push('reasonCode', input.state === 'dispatched' ? 'started' : 'process_unknown');
      }
      await commandClient.sendCommand(['HSET', keys.wakeIntent(input.messageId), ...fields]);
    };

    const nextContinuation = (
      suffix: string,
      value: CreateWorkflowInput,
      overrides: Partial<ContinueWorkflowInput> = {},
    ): ContinueWorkflowInput => {
      const actorSessionId = overrides.actorSessionId ?? value.workflow.coordinatorSessionId;
      const messageId = `next-message-${suffix}`;
      const correlationId = `next-correlation-${suffix}`;
      const base: ContinueWorkflowInput = {
        workflowId: value.workflow.id,
        expectedRevision: 1,
        proof: { kind: 'wake', wakeIntentId: value.firstMessage.id },
        decision: {
          kind: 'next_message',
          targetAgentId: 'gemini',
          message: {
            kind: 'instruction',
            subject: `Continue ${suffix}`,
            content: `Complete the next bounded step for ${suffix}.`,
          },
        },
        actorSessionId,
        nextMessage: {
          id: messageId,
          correlationId,
          projectId: 'project-1',
          sourceSessionId: actorSessionId,
          sourceAgentId: 'codex',
          targetSessionId: 'session-target',
          targetAgentId: 'gemini',
          selectionReason: 'direct target session session-target',
          kind: 'instruction',
          subject: `Continue ${suffix}`,
          content: `Complete the next bounded step for ${suffix}.`,
          evidenceRequirements: ['test_result'],
          timeoutMs: 120_000,
          requestFingerprint: fingerprint(`message:${suffix}:next`),
        },
        workspaceId: 'local',
        eventId: `event-${suffix}-next`,
      };
      return {
        ...base,
        ...overrides,
        decision: overrides.decision ?? base.decision,
        nextMessage:
          overrides.nextMessage === undefined
            ? base.nextMessage
            : { ...base.nextMessage, ...overrides.nextMessage },
      };
    };

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
      await runtime.registerProject({
        project: {
          id: 'project-2',
          name: 'Other workflow project',
          localPath: 'C:/workspace/workflows-other',
          canonicalPath: 'C:/workspace/workflows-other',
          identityPath: 'c:/workspace/workflows-other',
          pathIdentityHash: 'b'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-project-2',
      });
      for (const session of [
        { id: 'session-source', agentId: 'codex', projectId: 'project-1' },
        { id: 'session-source-replacement', agentId: 'codex', projectId: 'project-1' },
        { id: 'session-target', agentId: 'gemini', projectId: 'project-1' },
        { id: 'session-wrong-agent', agentId: 'gemini', projectId: 'project-1' },
        { id: 'session-other-project', agentId: 'gemini', projectId: 'project-2' },
      ]) {
        await runtime.registerSession({
          session: {
            ...session,
            projectId: session.projectId,
            status: 'starting',
            workingDirectory:
              session.projectId === 'project-1'
                ? 'C:/workspace/workflows'
                : 'C:/workspace/workflows-other',
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

    it('commits one next message and replays the exact receipt after later revisions', async () => {
      const value = input('continue-replay');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      const decision = nextContinuation('continue-replay', value);

      const first = await workflows.continue(decision);
      expect(first).toMatchObject({
        status: 'updated',
        workflow: {
          id: value.workflow.id,
          revision: 2,
          state: 'active',
          currentMessageId: 'next-message-continue-replay',
        },
        message: { id: 'next-message-continue-replay', state: 'queued' },
      });
      await expect(workflows.continue(decision)).resolves.toEqual(first);
      const receiptTtl = Number(
        await commandClient.sendCommand([
          'PTTL',
          keys.workflowDecision(value.workflow.id, decision.expectedRevision),
        ]),
      );
      expect(receiptTtl).toBeGreaterThan(0);
      expect(receiptTtl).toBeLessThanOrEqual(604_800_000);
      await expect(messages.listByWorkflow(value.workflow.id)).resolves.toEqual([
        expect.objectContaining({ id: value.firstMessage.id }),
        expect.objectContaining({ id: 'next-message-continue-replay' }),
      ]);
      await expect(
        commandClient.sendCommand([
          'HGET',
          keys.message('next-message-continue-replay'),
          'causationId',
        ]),
      ).resolves.toBe(`last-${value.firstMessage.id}`);
      const latestProjectEvent = (await commandClient.sendCommand([
        'XREVRANGE',
        keys.projectEvents('project-1'),
        '+',
        '-',
        'COUNT',
        '1',
      ])) as [[string, [string, string]]];
      expect(JSON.parse(latestProjectEvent[0][1][1])).toMatchObject({
        id: 'event-continue-replay-next',
        causationId: `last-${value.firstMessage.id}`,
      });

      await seedWake({
        workflowId: value.workflow.id,
        messageId: 'next-message-continue-replay',
        correlationId: 'next-correlation-continue-replay',
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 2,
        state: 'dispatched',
      });
      await workflows.continue({
        ...decision,
        expectedRevision: 2,
        proof: { kind: 'wake', wakeIntentId: 'next-message-continue-replay' },
        decision: { kind: 'complete' },
        nextMessage: undefined,
        eventId: 'event-continue-replay-complete',
      });

      await expect(workflows.continue(decision)).resolves.toEqual(first);
      await expect(messages.listByWorkflow(value.workflow.id)).resolves.toHaveLength(2);
    });

    it('derives wake causation from the canonical wake record and rejects caller forgery', async () => {
      const value = input('continue-causation-forgery');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      const forged = nextContinuation('continue-causation-forgery', value);
      forged.nextMessage = {
        ...forged.nextMessage!,
        causationId: 'caller-forged-event',
      } as unknown as NonNullable<ContinueWorkflowInput['nextMessage']>;

      await expect(workflows.continue(forged)).rejects.toMatchObject({
        code: 'REDIS_ARGUMENT_INVALID',
      });
      await expect(workflows.get(value.workflow.id)).resolves.toMatchObject({ revision: 1 });
      await expect(
        commandClient.sendCommand([
          'EXISTS',
          keys.workflowDecision(value.workflow.id, forged.expectedRevision),
        ]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['EXISTS', keys.message(forged.nextMessage.id)]),
      ).resolves.toBe(0);
    });

    it('expires a decision receipt at the configured message-retention boundary', async () => {
      const value = input('continue-receipt-expiry');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      const expiringWorkflows = createWorkflowRepository({
        client: commandClient,
        keys,
        functions: registry,
        decisionReceiptRetentionMs: 50,
      });
      const decision = nextContinuation('continue-receipt-expiry', value);

      const committed = await expiringWorkflows.continue(decision);
      await expect(expiringWorkflows.continue(decision)).resolves.toEqual(committed);
      await expect
        .poll(
          async () =>
            Number(
              await commandClient.sendCommand([
                'EXISTS',
                keys.workflowDecision(value.workflow.id, 1),
              ]),
            ),
          { interval: 10, timeout: 1_000 },
        )
        .toBe(0);
      await expect(expiringWorkflows.continue(decision)).rejects.toMatchObject({
        code: 'WORKFLOW_REVISION_MISMATCH',
      });
    });

    it('rejects a wake proof whose canonical stored record is incomplete', async () => {
      const value = input('continue-corrupt-wake-schema');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      await commandClient.sendCommand([
        'HDEL',
        keys.wakeIntent(value.firstMessage.id),
        'lastEventId',
      ]);

      await expect(
        workflows.continue({
          ...nextContinuation('continue-corrupt-wake-schema', value),
          decision: { kind: 'complete' },
          nextMessage: undefined,
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await expect(workflows.get(value.workflow.id)).resolves.toMatchObject({ revision: 1 });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflowDecision(value.workflow.id, 1)]),
      ).resolves.toBe(0);
    });

    it('rejects a conflicting decision fingerprint at the committed revision', async () => {
      const value = input('continue-conflict');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      const accepted = nextContinuation('continue-conflict', value);
      const outcomes = await Promise.allSettled([
        workflows.continue(accepted),
        workflows.continue({
          ...accepted,
          decision: { kind: 'complete' },
          nextMessage: undefined,
        }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'WORKFLOW_DECISION_CONFLICT' },
      });
      await expect(workflows.get(value.workflow.id)).resolves.toMatchObject({ revision: 2 });
    });

    it.each(['dispatched', 'indeterminate'] as const)(
      'accepts an exact current coordinator wake in the %s state',
      async (state) => {
        const value = input(`continue-${state}`);
        await workflows.create(value);
        await seedWake({
          workflowId: value.workflow.id,
          messageId: value.firstMessage.id,
          correlationId: value.firstMessage.correlationId,
          coordinatorSessionId: value.workflow.coordinatorSessionId,
          revision: 1,
          state,
        });

        await expect(
          workflows.continue({
            ...nextContinuation(`continue-${state}`, value),
            decision: { kind: 'complete' },
            nextMessage: undefined,
          }),
        ).resolves.toMatchObject({
          workflow: { revision: 2, state: 'completed' },
        });
      },
    );

    it('uses a human token only as a fence and atomically rebinds a live replacement', async () => {
      const value = input('continue-human');
      await workflows.create(value);
      await commandClient.sendCommand([
        'HSET',
        keys.workflow(value.workflow.id),
        'state',
        'waiting_for_human',
        'currentHumanContinuationId',
        'human-proof-1',
        'humanDecision',
        'Choose the next bounded task.',
      ]);
      await commandClient.sendCommand([
        'HDEL',
        keys.workflow(value.workflow.id),
        'currentWakeIntentId',
      ]);
      const decision = nextContinuation('continue-human', value, {
        proof: { kind: 'human', continuationId: 'human-proof-1' },
        actorSessionId: 'session-source-replacement',
        nextMessage: {
          ...nextContinuation('continue-human', value).nextMessage!,
          sourceSessionId: 'session-source-replacement',
        },
      });

      const result = await workflows.continue(decision);
      expect(result).toMatchObject({
        workflow: {
          revision: 2,
          coordinatorSessionId: 'session-source-replacement',
          state: 'active',
        },
        message: { sourceSessionId: 'session-source-replacement' },
      });
      await expect(
        commandClient.sendCommand([
          'HGET',
          keys.message('next-message-continue-human'),
          'causationId',
        ]),
      ).resolves.toBe('human-proof-1');
      await expect(
        commandClient.sendCommand([
          'ZSCORE',
          keys.coordinatorSessionWorkflows('session-source'),
          value.workflow.id,
        ]),
      ).resolves.toBeNull();
      await expect(
        commandClient.sendCommand([
          'ZSCORE',
          keys.coordinatorSessionWorkflows('session-source-replacement'),
          value.workflow.id,
        ]),
      ).resolves.not.toBeNull();
    });

    it('requires a distinct live same-agent replacement for a human next message', async () => {
      const value = input('continue-human-refusal');
      await workflows.create(value);
      await commandClient.sendCommand([
        'HSET',
        keys.workflow(value.workflow.id),
        'state',
        'waiting_for_human',
        'currentHumanContinuationId',
        'human-proof-refusal',
        'humanDecision',
        'Choose the next task.',
      ]);
      await expect(
        workflows.continue(
          nextContinuation('continue-human-refusal', value, {
            proof: { kind: 'human', continuationId: 'human-proof-refusal' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'WORKFLOW_REPLACEMENT_REQUIRED' });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflowDecision(value.workflow.id, 1)]),
      ).resolves.toBe(0);

      await expect(
        workflows.continue(
          nextContinuation('continue-human-refusal', value, {
            proof: { kind: 'human', continuationId: 'human-proof-refusal' },
            actorSessionId: 'session-wrong-agent',
            nextMessage: {
              ...nextContinuation('continue-human-refusal', value).nextMessage!,
              sourceSessionId: 'session-wrong-agent',
              sourceAgentId: 'gemini',
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'WORKFLOW_ACTOR_INVALID' });
    });

    it('increments every waiting and completed decision and rotates the human fence', async () => {
      const value = input('continue-waiting');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      const waiting = await workflows.continue({
        ...nextContinuation('continue-waiting', value),
        decision: { kind: 'waiting_for_human', humanDecision: 'Approve the staging release.' },
        nextMessage: undefined,
        nextHumanContinuationId: 'human-continue-waiting',
      });
      expect(waiting).toMatchObject({
        workflow: {
          revision: 2,
          state: 'waiting_for_human',
          currentHumanContinuationId: 'human-continue-waiting',
          humanDecision: 'Approve the staging release.',
        },
      });

      const completed = await workflows.continue({
        ...nextContinuation('continue-waiting-complete', value),
        expectedRevision: 2,
        proof: { kind: 'human', continuationId: 'human-continue-waiting' },
        actorSessionId: 'session-source-replacement',
        decision: { kind: 'complete' },
        nextMessage: undefined,
      });
      expect(completed).toMatchObject({
        workflow: { revision: 3, state: 'completed' },
      });
      expect(completed.workflow).not.toHaveProperty('currentWakeIntentId');
      expect(completed.workflow).not.toHaveProperty('currentHumanContinuationId');
      expect(completed.workflow).not.toHaveProperty('humanDecision');
    });

    it('rejects a resolved target from another project without consuming the revision', async () => {
      const value = input('continue-scope');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      const next = nextContinuation('continue-scope', value);
      await expect(
        workflows.continue({
          ...next,
          nextMessage: {
            ...next.nextMessage!,
            targetSessionId: 'session-other-project',
          },
        }),
      ).rejects.toMatchObject({ code: 'TARGET_PROJECT_MISMATCH' });
      await expect(workflows.get(value.workflow.id)).resolves.toMatchObject({ revision: 1 });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflowDecision(value.workflow.id, 1)]),
      ).resolves.toBe(0);
    });

    it('preflights the complete next-message write set without partial state', async () => {
      const value = input('continue-preflight');
      await workflows.create(value);
      await seedWake({
        workflowId: value.workflow.id,
        messageId: value.firstMessage.id,
        correlationId: value.firstMessage.correlationId,
        coordinatorSessionId: value.workflow.coordinatorSessionId,
        revision: 1,
        state: 'dispatching',
      });
      await commandClient.sendCommand(['DEL', keys.sessionInbox('session-target')]);
      await commandClient.sendCommand(['SET', keys.sessionInbox('session-target'), 'corrupt']);
      const before = await Promise.all([
        commandClient.sendCommand(['XLEN', keys.globalEvents]),
        commandClient.sendCommand(['ZCARD', keys.messagesIndex]),
      ]);

      await expect(
        workflows.continue(nextContinuation('continue-preflight', value)),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.workflowDecision(value.workflow.id, 1)]),
      ).resolves.toBe(0);
      await expect(
        commandClient.sendCommand(['EXISTS', keys.message('next-message-continue-preflight')]),
      ).resolves.toBe(0);
      await expect(workflows.get(value.workflow.id)).resolves.toMatchObject({ revision: 1 });
      await expect(
        Promise.all([
          commandClient.sendCommand(['XLEN', keys.globalEvents]),
          commandClient.sendCommand(['ZCARD', keys.messagesIndex]),
        ]),
      ).resolves.toEqual(before);
    });
  },
);
