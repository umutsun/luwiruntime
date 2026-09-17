import { randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createMessageRepository,
  createRedisKeys,
  createRuntimeRepository,
  type MessageRepository,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'message request Function',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let runtimeRepository: RuntimeRepository;
    let messageRepository: MessageRepository;

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
      messageRepository = createMessageRepository({
        client: commandClient,
        keys,
        functions: registry,
      });
      await runtimeRepository.registerProject({
        project: {
          id: 'project-1',
          name: 'Messages',
          localPath: 'C:/workspace/messages',
          canonicalPath: 'C:/workspace/messages',
          identityPath: 'c:/workspace/messages',
          pathIdentityHash: 'a'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-project',
      });
      for (const session of [
        { id: 'session-source', agentId: 'claude-sim' },
        { id: 'session-target', agentId: 'gemini-sim' },
      ]) {
        await runtimeRepository.registerSession({
          session: {
            ...session,
            projectId: 'project-1',
            status: 'starting',
            workingDirectory: 'C:/workspace/messages',
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

    const request = (overrides: Record<string, unknown> = {}) => ({
      message: {
        id: 'message-1',
        correlationId: 'correlation-1',
        projectId: 'project-1',
        sourceSessionId: 'session-source',
        sourceAgentId: 'claude-sim',
        targetSessionId: 'session-target',
        targetAgentId: 'gemini-sim',
        selectionReason: 'direct target session session-target',
        kind: 'question' as const,
        subject: 'Status',
        content: 'Project status?',
        evidenceRequirements: ['session_state' as const],
        timeoutMs: 120_000,
        requestFingerprint: 'f'.repeat(64),
        idempotencyKeyHash: 'b'.repeat(64),
        ...overrides,
      },
      workspaceId: 'local',
      eventId: 'event-message-1',
    });

    it('atomically creates projection, indexes, inbox entry, deadline, and matching events', async () => {
      const result = await messageRepository.createMessage(request());

      expect(result).toMatchObject({
        status: 'created',
        message: {
          id: 'message-1',
          sourceAgentId: 'claude-sim',
          targetAgentId: 'gemini-sim',
          state: 'queued',
        },
        event: {
          id: 'event-message-1',
          type: 'message.requested',
          correlationId: 'correlation-1',
        },
      });
      if (result.status !== 'created') {
        throw new Error('Expected created message');
      }
      expect(result.globalStreamId).toMatch(/^\d+-\d+$/);
      expect(result.projectStreamId).toMatch(/^\d+-\d+$/);
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBeGreaterThan(
        0,
      );
      await expect(
        commandClient.sendCommand(['XLEN', keys.projectEvents('project-1')]),
      ).resolves.toBeGreaterThan(0);
      await expect(
        commandClient.sendCommand(['GET', keys.messageCorrelation('correlation-1')]),
      ).resolves.toBe('message-1');
      await expect(
        commandClient.sendCommand(['ZSCORE', keys.messageDeadlines, 'message-1']),
      ).resolves.not.toBeNull();
      await expect(
        commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
      ).resolves.toBe(1);
      await expect(
        commandClient.sendCommand(['ZSCORE', keys.projectMessages('project-1'), 'message-1']),
      ).resolves.not.toBeNull();
    });

    it('stores and projects a declared re-dispatch link, and leaves it absent otherwise', async () => {
      const linked = await messageRepository.createMessage(
        request({
          id: 'message-2',
          correlationId: 'correlation-2',
          idempotencyKeyHash: '1'.repeat(64),
          retryOf: 'correlation-1',
        }),
      );
      expect(linked).toMatchObject({
        status: 'created',
        message: { id: 'message-2', retryOf: 'correlation-1' },
        event: { payload: { retryOf: 'correlation-1' } },
      });
      await expect(
        commandClient.sendCommand(['HGET', keys.message('message-2'), 'retryOf']),
      ).resolves.toBe('correlation-1');
      await expect(messageRepository.getMessage('correlation-2')).resolves.toMatchObject({
        retryOf: 'correlation-1',
      });

      const plain = await messageRepository.createMessage(
        request({
          id: 'message-3',
          correlationId: 'correlation-3',
          idempotencyKeyHash: '2'.repeat(64),
        }),
      );
      expect(plain.status).toBe('created');
      const stored = await messageRepository.getMessage('correlation-3');
      expect(stored).not.toBeNull();
      expect(stored).not.toHaveProperty('retryOf');
      await expect(
        commandClient.sendCommand(['HEXISTS', keys.message('message-3'), 'retryOf']),
      ).resolves.toBe(0);

      // A blank link is refused before any write.
      await expect(
        messageRepository.createMessage(
          request({
            id: 'message-4',
            correlationId: 'correlation-4',
            idempotencyKeyHash: '3'.repeat(64),
            retryOf: '',
          }),
        ),
      ).rejects.toMatchObject({ code: 'REDIS_ARGUMENT_INVALID' });
      await expect(commandClient.sendCommand(['EXISTS', keys.message('message-4')])).resolves.toBe(
        0,
      );
    });

    it('returns the original message for a same-payload retry and conflicts on reuse', async () => {
      const globalLength = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));
      const inboxLength = Number(
        await commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
      );

      await expect(
        messageRepository.createMessage({
          ...request(),
          message: {
            ...request().message,
            id: 'message-retry',
            correlationId: 'correlation-retry',
          },
          eventId: 'event-retry',
        }),
      ).resolves.toMatchObject({
        status: 'existing',
        message: { id: 'message-1', correlationId: 'correlation-1' },
      });
      await expect(
        messageRepository.createMessage({
          ...request(),
          message: {
            ...request().message,
            id: 'message-conflict',
            correlationId: 'correlation-conflict',
            requestFingerprint: 'c'.repeat(64),
          },
          eventId: 'event-conflict',
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      await expect(
        messageRepository.findIdempotentMessage('session-source', 'b'.repeat(64)),
      ).resolves.toMatchObject({
        message: { id: 'message-1', correlationId: 'correlation-1' },
        requestFingerprint: 'f'.repeat(64),
      });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(
        globalLength,
      );
      await expect(
        commandClient.sendCommand(['XLEN', keys.sessionInbox('session-target')]),
      ).resolves.toBe(inboxLength);
    });

    it('round-trips an empty evidence requirement list from the stored projection', async () => {
      await messageRepository.createMessage({
        ...request({
          id: 'message-empty-evidence',
          correlationId: 'correlation-empty-evidence',
          evidenceRequirements: [],
          idempotencyKeyHash: undefined,
        }),
        eventId: 'event-empty-evidence',
      });

      await expect(
        messageRepository.getMessage('correlation-empty-evidence'),
      ).resolves.toMatchObject({
        id: 'message-empty-evidence',
        evidenceRequirements: [],
        state: 'queued',
      });
    });

    it('rejects an offline target before any write', async () => {
      await commandClient.sendCommand(['DEL', keys.sessionPresence('session-target')]);

      await expect(
        messageRepository.createMessage({
          ...request({
            id: 'message-offline',
            correlationId: 'correlation-offline',
            idempotencyKeyHash: 'd'.repeat(64),
          }),
          eventId: 'event-offline',
        }),
      ).rejects.toMatchObject({ code: 'TARGET_SESSION_UNAVAILABLE' });
      await expect(
        commandClient.sendCommand(['EXISTS', keys.message('message-offline')]),
      ).resolves.toBe(0);
      await commandClient.sendCommand([
        'SET',
        keys.sessionPresence('session-target'),
        'session-target',
        'PX',
        '60000',
      ]);
    });

    it('preflights wrong projection types without partial mutation', async () => {
      await commandClient.sendCommand(['SET', keys.message('message-wrong-type'), 'bad']);
      const before = Number(await commandClient.sendCommand(['XLEN', keys.globalEvents]));

      await expect(
        messageRepository.createMessage({
          ...request({
            id: 'message-wrong-type',
            correlationId: 'correlation-wrong-type',
            idempotencyKeyHash: undefined,
          }),
          eventId: 'event-wrong-type',
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await expect(commandClient.sendCommand(['XLEN', keys.globalEvents])).resolves.toBe(before);
      await expect(
        commandClient.sendCommand(['EXISTS', keys.messageCorrelation('correlation-wrong-type')]),
      ).resolves.toBe(0);
    });
  },
);
