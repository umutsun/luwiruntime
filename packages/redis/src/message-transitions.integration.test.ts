import { createHash, randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  claimSessionInbox,
  createFunctionRegistry,
  createMessageRepository,
  createRedisKeys,
  createRuntimeRepository,
  SESSION_INBOX_CONSUMER_GROUP,
  type CreateMessageInput,
  type MessageRepository,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'message transition Functions',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let runtimeRepository: RuntimeRepository;
    let messages: MessageRepository;

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      runtimeRepository = createRuntimeRepository({
        client: commandClient,
        keys,
        functions: registry,
      });
      messages = createMessageRepository({ client: commandClient, keys, functions: registry });
      await runtimeRepository.registerProject({
        project: {
          id: 'project-1',
          name: 'Transitions',
          localPath: 'C:/workspace/transitions',
          canonicalPath: 'C:/workspace/transitions',
          identityPath: 'c:/workspace/transitions',
          pathIdentityHash: 'e'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-project',
      });
      for (const session of [
        { id: 'source', agentId: 'claude-sim' },
        { id: 'target', agentId: 'gemini-sim' },
        { id: 'other', agentId: 'codex-sim' },
      ]) {
        await runtimeRepository.registerSession({
          session: {
            ...session,
            projectId: 'project-1',
            status: 'starting',
            workingDirectory: 'C:/workspace/transitions',
            metadataJson: '{}',
          },
          workspaceId: 'local',
          eventId: `event-${session.id}`,
          presenceTtlMs: 60_000,
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

    const createInput = (suffix: string): CreateMessageInput => ({
      message: {
        id: `message-${suffix}`,
        correlationId: `correlation-${suffix}`,
        projectId: 'project-1',
        sourceSessionId: 'source',
        sourceAgentId: 'claude-sim',
        targetSessionId: 'target',
        targetAgentId: 'gemini-sim',
        selectionReason: 'direct target session target',
        kind: 'question',
        content: `Status ${suffix}?`,
        evidenceRequirements: ['session_state'],
        timeoutMs: 120_000,
        requestFingerprint: createHash('sha256').update(suffix).digest('hex'),
      },
      workspaceId: 'local',
      eventId: `event-request-${suffix}`,
    });

    async function claim(suffix: string): Promise<string> {
      const result = await claimSessionInbox({
        client: commandClient,
        keys,
        sessionId: 'target',
        bridgeInstanceId: `bridge_${suffix}`,
        limit: 1,
        minIdleMs: 0,
        getMessage: (messageId) => messages.getMessageById(messageId),
        markDelivered: async (correlationId) => {
          await messages.transitionMessage('delivered', {
            correlationId,
            responderSessionId: 'target',
            workspaceId: 'local',
            eventId: `event-delivered-${suffix}`,
          });
        },
      });
      const streamId = result.items[0]?.streamId;
      if (streamId === undefined) {
        throw new Error('Expected claimed request');
      }
      return streamId;
    }

    it('keeps work pending through processing and XACKs only after response', async () => {
      await messages.createMessage(createInput('respond'));
      const streamId = await claim('respond');
      await expect(
        commandClient.sendCommand([
          'XPENDING',
          keys.sessionInbox('target'),
          SESSION_INBOX_CONSUMER_GROUP,
        ]),
      ).resolves.toEqual(expect.arrayContaining([1]));

      await expect(
        messages.transitionMessage('acknowledged', {
          correlationId: 'correlation-respond',
          responderSessionId: 'target',
          workspaceId: 'local',
          eventId: 'event-acknowledged-respond',
        }),
      ).resolves.toMatchObject({ status: 'updated', message: { state: 'acknowledged' } });
      await expect(
        messages.transitionMessage('processing', {
          correlationId: 'correlation-respond',
          responderSessionId: 'target',
          workspaceId: 'local',
          eventId: 'event-processing-respond',
        }),
      ).resolves.toMatchObject({ status: 'updated', message: { state: 'processing' } });
      await expect(
        commandClient.sendCommand([
          'XPENDING',
          keys.sessionInbox('target'),
          SESSION_INBOX_CONSUMER_GROUP,
        ]),
      ).resolves.toEqual(expect.arrayContaining([1]));
      const eventsBeforeRecovery = Number(
        await commandClient.sendCommand(['XLEN', keys.globalEvents]),
      );
      await expect(claim('respond-recovered')).resolves.toBe(streamId);
      await expect(messages.getMessage('correlation-respond')).resolves.toMatchObject({
        state: 'processing',
      });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        eventsBeforeRecovery,
      );

      const responseJson = JSON.stringify({
        status: 'answered',
        answer: 'Simulated response.',
        confidence: 0.8,
        evidence: [
          {
            type: 'session_state',
            summary: 'Simulated session state evidence.',
            observedAt: '2026-07-29T12:00:00.000Z',
            metadata: { simulated: true },
          },
        ],
        verifiedAt: '2026-07-29T12:00:00.000Z',
      });
      const responded = await messages.transitionMessage('responded', {
        correlationId: 'correlation-respond',
        responderSessionId: 'target',
        workspaceId: 'local',
        eventId: 'event-responded-respond',
        responseJson,
        idempotencyRetentionMs: 86_400_000,
      });
      expect(responded).toMatchObject({
        status: 'updated',
        message: {
          state: 'responded',
          response: { status: 'answered', answer: 'Simulated response.' },
        },
      });
      await expect(
        commandClient.sendCommand([
          'XPENDING',
          keys.sessionInbox('target'),
          SESSION_INBOX_CONSUMER_GROUP,
        ]),
      ).resolves.toEqual(expect.arrayContaining([0]));
      await expect(commandClient.sendCommand(['XLEN', keys.sessionInbox('source')])).resolves.toBe(
        1,
      );
      await expect(
        commandClient.sendCommand(['ZSCORE', keys.messageDeadlines, 'message-respond']),
      ).resolves.toBeNull();
      await expect(
        commandClient.sendCommand(['HGET', keys.message('message-respond'), 'targetInboxStreamId']),
      ).resolves.toBe(streamId);

      const globalBefore = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));
      await expect(
        messages.transitionMessage('responded', {
          correlationId: 'correlation-respond',
          responderSessionId: 'target',
          workspaceId: 'local',
          eventId: 'event-responded-duplicate',
          responseJson,
        }),
      ).resolves.toMatchObject({ status: 'unchanged', message: { state: 'responded' } });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalBefore,
      );
      await expect(
        messages.transitionMessage('responded', {
          correlationId: 'correlation-respond',
          responderSessionId: 'other',
          workspaceId: 'local',
          eventId: 'event-responded-wrong-responder',
          responseJson,
        }),
      ).rejects.toMatchObject({ code: 'RESPONDER_SESSION_MISMATCH' });
    });

    it('rejects responder mismatch and supports rejected/failed terminal notifications', async () => {
      for (const [suffix, terminal, status] of [
        ['reject', 'rejected', 'rejected'],
        ['fail', 'failed', 'failed'],
      ] as const) {
        await messages.createMessage(createInput(suffix));
        await claim(suffix);
        await expect(
          messages.transitionMessage(terminal, {
            correlationId: `correlation-${suffix}`,
            responderSessionId: 'other',
            workspaceId: 'local',
            eventId: `event-wrong-${suffix}`,
            responseJson: JSON.stringify({
              status,
              answer: `Simulated ${status}.`,
              evidence: [],
              verifiedAt: '2026-07-29T12:00:00.000Z',
            }),
          }),
        ).rejects.toMatchObject({ code: 'RESPONDER_SESSION_MISMATCH' });

        await expect(
          messages.transitionMessage(terminal, {
            correlationId: `correlation-${suffix}`,
            responderSessionId: 'target',
            workspaceId: 'local',
            eventId: `event-${terminal}-${suffix}`,
            responseJson: JSON.stringify({
              status,
              answer: `Simulated ${status}.`,
              evidence: [],
              verifiedAt: '2026-07-29T12:00:00.000Z',
            }),
          }),
        ).resolves.toMatchObject({ status: 'updated', message: { state: terminal } });
      }
      await expect(commandClient.sendCommand(['XLEN', keys.sessionInbox('source')])).resolves.toBe(
        3,
      );
    });

    it('times out atomically, notifies the source, and rejects a late response', async () => {
      const input = createInput('timeout');
      input.message.timeoutMs = 1;
      await messages.createMessage(input);
      await claim('timeout');
      const deadline = Number(
        await commandClient.sendCommand(['ZSCORE', keys.messageDeadlines, 'message-timeout']),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(messages.findDueMessageDeadlines(Date.now(), 10)).resolves.toContainEqual({
        messageId: 'message-timeout',
        deadlineMs: deadline,
      });

      await expect(
        messages.transitionMessage('timed_out', {
          correlationId: 'correlation-timeout',
          responderSessionId: '',
          workspaceId: 'local',
          eventId: 'event-timed-out-timeout',
          expectedDeadlineMs: deadline,
        }),
      ).resolves.toMatchObject({ status: 'updated', message: { state: 'timed_out' } });
      await expect(
        commandClient.sendCommand(['ZSCORE', keys.messageDeadlines, 'message-timeout']),
      ).resolves.toBeNull();
      await expect(
        commandClient.sendCommand([
          'XPENDING',
          keys.sessionInbox('target'),
          SESSION_INBOX_CONSUMER_GROUP,
        ]),
      ).resolves.toEqual(expect.arrayContaining([0]));
      await expect(commandClient.sendCommand(['XLEN', keys.sessionInbox('source')])).resolves.toBe(
        4,
      );

      await expect(
        messages.transitionMessage('responded', {
          correlationId: 'correlation-timeout',
          responderSessionId: 'target',
          workspaceId: 'local',
          eventId: 'event-late-response',
          responseJson: JSON.stringify({
            status: 'answered',
            answer: 'Too late.',
            evidence: [],
            verifiedAt: '2026-07-29T12:00:00.000Z',
          }),
        }),
      ).rejects.toMatchObject({ code: 'MESSAGE_TERMINAL' });
    });

    it('times out a queued request that was never claimed', async () => {
      const input = createInput('timeout-unclaimed');
      input.message.timeoutMs = 1;
      await messages.createMessage(input);
      const deadline = Number(
        await commandClient.sendCommand([
          'ZSCORE',
          keys.messageDeadlines,
          'message-timeout-unclaimed',
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      await expect(
        messages.transitionMessage('timed_out', {
          correlationId: 'correlation-timeout-unclaimed',
          responderSessionId: '',
          workspaceId: 'local',
          eventId: 'event-timed-out-unclaimed',
          expectedDeadlineMs: deadline,
        }),
      ).resolves.toMatchObject({ status: 'updated', message: { state: 'timed_out' } });
    });

    it('leaves state and events unchanged when a response or changed deadline wins', async () => {
      const responseInput = createInput('response-wins');
      responseInput.message.timeoutMs = 60_000;
      await messages.createMessage(responseInput);
      const responseDeadline = Number(
        await commandClient.sendCommand(['ZSCORE', keys.messageDeadlines, 'message-response-wins']),
      );
      await messages.transitionMessage('delivered', {
        correlationId: 'correlation-response-wins',
        responderSessionId: 'target',
        workspaceId: 'local',
        eventId: 'event-delivered-response-wins',
      });
      await messages.transitionMessage('responded', {
        correlationId: 'correlation-response-wins',
        responderSessionId: 'target',
        workspaceId: 'local',
        eventId: 'event-responded-response-wins',
        responseJson: JSON.stringify({
          status: 'answered',
          answer: 'Response won.',
          evidence: [],
          verifiedAt: '2026-07-29T12:00:00.000Z',
        }),
      });
      const globalAfterResponse = Number(
        await commandClient.sendCommand(['XLEN', keys.globalEvents]),
      );
      await expect(
        messages.transitionMessage('timed_out', {
          correlationId: 'correlation-response-wins',
          responderSessionId: '',
          workspaceId: 'local',
          eventId: 'event-timeout-lost-response',
          expectedDeadlineMs: responseDeadline,
        }),
      ).resolves.toMatchObject({ status: 'unchanged', message: { state: 'responded' } });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalAfterResponse,
      );

      const deadlineInput = createInput('deadline-changed');
      deadlineInput.message.timeoutMs = 1;
      await messages.createMessage(deadlineInput);
      const originalDeadline = Number(
        await commandClient.sendCommand([
          'ZSCORE',
          keys.messageDeadlines,
          'message-deadline-changed',
        ]),
      );
      await commandClient.sendCommand([
        'ZADD',
        keys.messageDeadlines,
        String(originalDeadline + 60_000),
        'message-deadline-changed',
      ]);
      const globalBeforeStaleTimeout = Number(
        await commandClient.sendCommand(['XLEN', keys.globalEvents]),
      );
      await expect(
        messages.transitionMessage('timed_out', {
          correlationId: 'correlation-deadline-changed',
          responderSessionId: '',
          workspaceId: 'local',
          eventId: 'event-timeout-stale-deadline',
          expectedDeadlineMs: originalDeadline,
        }),
      ).resolves.toMatchObject({ status: 'unchanged', message: { state: 'queued' } });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalBeforeStaleTimeout,
      );
    });
  },
);
