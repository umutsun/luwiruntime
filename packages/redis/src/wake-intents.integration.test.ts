import { createHash, randomUUID } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createFunctionRegistry,
  createMessageRepository,
  createRedisKeys,
  createRuntimeRepository,
  createWakeIntentRepository,
  createWorkflowRepository,
  type CreateMessageInput,
  type CreateWorkflowInput,
  type MessageRepository,
  type MessageTransitionKind,
  type RedisCommandClient,
  type RedisKeys,
  type RuntimeRepository,
  type WakeIntentRepository,
  type WorkflowRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';
const dedicatedRedisUrl = 'redis://127.0.0.1:6391';

type TerminalKind = Extract<
  MessageTransitionKind,
  'responded' | 'rejected' | 'failed' | 'timed_out'
>;

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'terminal workflow wake intent Function',
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
    let defaultMessages: MessageRepository;
    let wakeIntents: WakeIntentRepository;

    const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');

    const workflowInput = (
      suffix: string,
      sourceSessionId: string,
      timeoutMs = 120_000,
    ): CreateWorkflowInput => ({
      workflow: {
        id: `workflow-${suffix}`,
        projectId: 'project-1',
        coordinatorSessionId: sourceSessionId,
        rootCorrelationId: `correlation-${suffix}`,
        objective: `Complete workflow ${suffix}.`,
        createFingerprint: fingerprint(`workflow:${suffix}`),
      },
      firstMessage: {
        id: `message-${suffix}`,
        correlationId: `correlation-${suffix}`,
        projectId: 'project-1',
        sourceSessionId,
        sourceAgentId: 'codex',
        targetSessionId: 'target',
        targetAgentId: 'gemini',
        selectionReason: 'direct target session target',
        kind: 'instruction',
        subject: `Workflow ${suffix}`,
        content: `Execute workflow ${suffix} and return evidence.`,
        evidenceRequirements: ['test_result'],
        timeoutMs,
        requestFingerprint: fingerprint(`message:${suffix}`),
      },
      workspaceId: 'local',
      eventId: `event-request-${suffix}`,
    });

    const standaloneInput = (suffix: string): CreateMessageInput => ({
      message: {
        id: `message-${suffix}`,
        correlationId: `correlation-${suffix}`,
        projectId: 'project-1',
        sourceSessionId: 'source-capable',
        sourceAgentId: 'codex',
        targetSessionId: 'target',
        targetAgentId: 'gemini',
        selectionReason: 'direct target session target',
        kind: 'instruction',
        content: `Execute standalone request ${suffix}.`,
        evidenceRequirements: ['test_result'],
        timeoutMs: 120_000,
        requestFingerprint: fingerprint(`message:${suffix}`),
      },
      workspaceId: 'local',
      eventId: `event-request-${suffix}`,
    });

    const eventRows = async () => {
      const rows = await client.xRange(keys.globalEvents, '-', '+');
      return rows.map((row) => {
        const encoded = row.message.event;
        if (encoded === undefined) throw new Error('Expected a Runtime event Stream item.');
        return JSON.parse(encoded) as {
          id: string;
          type: string;
          correlationId?: string;
          causationId?: string;
          payload: Record<string, unknown>;
        };
      });
    };

    const responseJson = (terminal: Exclude<TerminalKind, 'timed_out'>, suffix: string): string =>
      JSON.stringify({
        status:
          terminal === 'responded' ? 'answered' : terminal === 'rejected' ? 'rejected' : 'failed',
        answer: `Terminal ${terminal} response for ${suffix}.`,
        evidence: [],
        verifiedAt: '2026-09-09T12:00:00.000Z',
      });

    const prepareTerminal = async (
      messages: MessageRepository,
      suffix: string,
      terminal: TerminalKind,
    ): Promise<{ responseJson?: string; expectedDeadlineMs?: number }> => {
      if (terminal === 'timed_out') {
        const expectedDeadlineMs = Number(
          await commandClient.sendCommand(['ZSCORE', keys.messageDeadlines, `message-${suffix}`]),
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { expectedDeadlineMs };
      }
      await messages.transitionMessage('delivered', {
        correlationId: `correlation-${suffix}`,
        responderSessionId: 'target',
        workspaceId: 'local',
        eventId: `event-delivered-${suffix}`,
      });
      return { responseJson: responseJson(terminal, suffix) };
    };

    const transitionRepository = (ids: readonly string[]): MessageRepository => {
      const remaining = [...ids];
      return createMessageRepository({
        client: commandClient,
        keys,
        functions: registry,
        createId: () => remaining.shift() ?? `unexpected-${randomUUID()}`,
      });
    };

    const atomicCaseKeys = (caseKeys: RedisKeys, suffix: string): readonly string[] => [
      caseKeys.message(`message-${suffix}`),
      caseKeys.session('target'),
      caseKeys.globalEvents,
      caseKeys.projectEvents('project-1'),
      caseKeys.sessionInbox('target'),
      caseKeys.sessionInbox('source-capable'),
      caseKeys.messageDeadlines,
      caseKeys.terminalMessages,
      caseKeys.messageIdempotency('source-capable', `message-${suffix}`),
      caseKeys.messageCorrelation(`correlation-${suffix}`),
      caseKeys.session('source-capable'),
      caseKeys.sessionPresence('source-capable'),
      caseKeys.workflow(`workflow-${suffix}`),
      caseKeys.wakeIntent(`message-${suffix}`),
      caseKeys.wakeStream,
      caseKeys.wakeIntentsIndex,
      caseKeys.projectWakeIntents('project-1'),
      caseKeys.wakeIntentDeadlines,
    ];

    const snapshotAtomicState = async (
      caseKeys: RedisKeys,
      suffix: string,
    ): Promise<readonly string[]> =>
      Promise.all(
        atomicCaseKeys(caseKeys, suffix).map(async (key) => {
          const type = await client.type(key);
          const ttl = await client.pTTL(key);
          const ttlState = ttl === -2 ? 'missing' : ttl === -1 ? 'persistent' : 'expiring';
          if (type === 'none') return JSON.stringify({ type, ttlState });
          if (type === 'string') {
            return JSON.stringify({ type, ttlState, value: await client.get(key) });
          }
          if (type === 'hash') {
            const value = Object.entries(await client.hGetAll(key)).sort(([left], [right]) =>
              left.localeCompare(right),
            );
            return JSON.stringify({ type, ttlState, value });
          }
          if (type === 'zset') {
            return JSON.stringify({
              type,
              ttlState,
              value: await client.zRangeWithScores(key, 0, -1),
            });
          }
          if (type === 'stream') {
            const entries = (await client.xRange(key, '-', '+')).map((entry) => ({
              id: entry.id,
              message: Object.entries(entry.message).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            }));
            return JSON.stringify({
              type,
              ttlState,
              entries,
              groups: await client.xInfoGroups(key),
            });
          }
          throw new Error(`Unexpected Redis type ${type} for ${key}.`);
        }),
      );

    const prepareAtomicCase = async (suffix: string, wakeCapable = true) => {
      const caseKeys = createRedisKeys(`${namespace}:case:${suffix}`);
      const caseRuntime = createRuntimeRepository({
        client: commandClient,
        keys: caseKeys,
        functions: registry,
      });
      const caseWorkflows = createWorkflowRepository({
        client: commandClient,
        keys: caseKeys,
        functions: registry,
      });
      await caseRuntime.registerProject({
        project: {
          id: 'project-1',
          name: `Atomicity case ${suffix}`,
          localPath: `C:/workspace/wake-intents/${suffix}`,
          canonicalPath: `C:/workspace/wake-intents/${suffix}`,
          identityPath: `c:/workspace/wake-intents/${suffix}`,
          pathIdentityHash: fingerprint(`path:${suffix}`),
        },
        workspaceId: 'local',
        eventId: `event-project-${suffix}`,
      });
      for (const session of [
        { id: 'source-capable', agentId: 'codex' },
        { id: 'target', agentId: 'gemini' },
      ]) {
        await caseRuntime.registerSession({
          session: {
            ...session,
            projectId: 'project-1',
            status: 'starting',
            workingDirectory: `C:/workspace/wake-intents/${suffix}`,
            metadataJson: '{}',
          },
          workspaceId: 'local',
          eventId: `event-session-${session.id}-${suffix}`,
          presenceTtlMs: 300_000,
        });
      }
      if (wakeCapable) {
        await client.hSet(caseKeys.session('source-capable'), {
          hostWakeAdapter: 'codex-queue-v1',
          hostWakeMcpSessionId: 'source-capable',
        });
      }
      await caseWorkflows.create(workflowInput(suffix, 'source-capable'));
      const caseMessages = createMessageRepository({
        client: commandClient,
        keys: caseKeys,
        functions: registry,
        createId: (() => {
          const ids = [`wake-event-${suffix}`, `human-continuation-${suffix}`];
          return () => ids.shift() ?? `unexpected-${randomUUID()}`;
        })(),
      });
      await caseMessages.transitionMessage('delivered', {
        correlationId: `correlation-${suffix}`,
        responderSessionId: 'target',
        workspaceId: 'local',
        eventId: `event-delivered-${suffix}`,
      });
      return { keys: caseKeys, messages: caseMessages };
    };

    beforeAll(async () => {
      if (testRedisUrl !== dedicatedRedisUrl) {
        throw new Error('Wake intent integration tests require dedicated Redis port 6391.');
      }
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      runtime = createRuntimeRepository({ client: commandClient, keys, functions: registry });
      workflows = createWorkflowRepository({ client: commandClient, keys, functions: registry });
      defaultMessages = createMessageRepository({
        client: commandClient,
        keys,
        functions: registry,
      });
      wakeIntents = createWakeIntentRepository({
        client: commandClient,
        keys,
        functions: registry,
      });

      await runtime.registerProject({
        project: {
          id: 'project-1',
          name: 'Wake intent tests',
          localPath: 'C:/workspace/wake-intents',
          canonicalPath: 'C:/workspace/wake-intents',
          identityPath: 'c:/workspace/wake-intents',
          pathIdentityHash: '9'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-project',
      });

      for (const session of [
        { id: 'source-capable', agentId: 'codex' },
        { id: 'source-offline', agentId: 'codex' },
        { id: 'source-inbox-only', agentId: 'codex' },
        { id: 'target', agentId: 'gemini' },
      ]) {
        await runtime.registerSession({
          session: {
            ...session,
            projectId: 'project-1',
            status: 'starting',
            workingDirectory: 'C:/workspace/wake-intents',
            metadataJson: '{}',
          },
          workspaceId: 'local',
          eventId: `event-session-${session.id}`,
          presenceTtlMs: 300_000,
        });
      }

      for (const sessionId of ['source-capable', 'source-offline']) {
        await client.hSet(keys.session(sessionId), {
          hostWakeAdapter: 'codex-queue-v1',
          hostWakeMcpSessionId: sessionId,
        });
      }
    });

    afterAll(async () => {
      if (!client?.isOpen) return;
      let cursor = '0';
      do {
        const result = await client.scan(cursor, { MATCH: `${namespace}:*`, COUNT: 100 });
        cursor = result.cursor;
        if (result.keys.length > 0) await client.del(result.keys);
      } while (cursor !== '0');
      await commandClient.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]);
      await client.quit();
    });

    it.each([
      ['responded', 120_000],
      ['rejected', 120_000],
      ['failed', 120_000],
      ['timed_out', 1],
    ] as const)(
      'atomically creates one redacted pending wake and two linked events for %s',
      async (terminal, timeoutMs) => {
        const suffix = `eligible-${terminal}`;
        await workflows.create(workflowInput(suffix, 'source-capable', timeoutMs));
        const messages = transitionRepository([
          `wake-event-${suffix}`,
          `human-continuation-${suffix}`,
          `replay-wake-event-${suffix}`,
          `replay-human-continuation-${suffix}`,
        ]);
        const terminalFields = await prepareTerminal(messages, suffix, terminal);
        const globalBefore = await client.xLen(keys.globalEvents);
        const projectBefore = await client.xLen(keys.projectEvents('project-1'));
        const sourceInboxBefore = await client.xLen(keys.sessionInbox('source-capable'));

        const first = await messages.transitionMessage(terminal, {
          correlationId: `correlation-${suffix}`,
          responderSessionId: terminal === 'timed_out' ? '' : 'target',
          workspaceId: 'local',
          eventId: `terminal-event-${suffix}`,
          ...terminalFields,
        });

        expect(first).toMatchObject({
          status: 'updated',
          message: { id: `message-${suffix}`, state: terminal },
          event: { id: `terminal-event-${suffix}`, type: `message.${terminal}` },
        });
        expect(await client.xLen(keys.globalEvents)).toBe(globalBefore + 2);
        expect(await client.xLen(keys.projectEvents('project-1'))).toBe(projectBefore + 2);
        expect(await client.xLen(keys.sessionInbox('source-capable'))).toBe(sourceInboxBefore + 1);
        expect(await client.xLen(keys.wakeStream)).toBeGreaterThanOrEqual(1);
        await expect(
          client.zScore(keys.wakeIntentsIndex, `message-${suffix}`),
        ).resolves.not.toBeNull();
        await expect(
          client.zScore(keys.projectWakeIntents('project-1'), `message-${suffix}`),
        ).resolves.not.toBeNull();

        const publicWake = await wakeIntents.getByMessage(`message-${suffix}`);
        expect(publicWake).toEqual({
          id: `message-${suffix}`,
          messageId: `message-${suffix}`,
          workflowId: `workflow-${suffix}`,
          sourceSessionId: 'source-capable',
          correlationId: `correlation-${suffix}`,
          terminalState: terminal,
          adapter: 'codex-queue-v1',
          state: 'pending',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        });
        await expect(workflows.get(`workflow-${suffix}`)).resolves.toMatchObject({
          state: 'active',
          currentMessageId: `message-${suffix}`,
          currentWakeIntentId: `message-${suffix}`,
        });

        const newEvents = (await eventRows()).slice(-2);
        expect(newEvents).toEqual([
          expect.objectContaining({
            id: `terminal-event-${suffix}`,
            type: `message.${terminal}`,
            correlationId: `correlation-${suffix}`,
          }),
          expect.objectContaining({
            id: `wake-event-${suffix}`,
            type: 'wake.requested',
            correlationId: `correlation-${suffix}`,
            causationId: `terminal-event-${suffix}`,
            payload: expect.objectContaining({
              messageId: `message-${suffix}`,
              workflowId: `workflow-${suffix}`,
            }),
          }),
        ]);

        const wakeRecord = await client.hGetAll(keys.wakeIntent(`message-${suffix}`));
        expect(JSON.stringify(wakeRecord)).not.toContain(`Terminal ${terminal} response`);
        expect(JSON.stringify(wakeRecord)).not.toContain('nativeSessionId');
        expect(JSON.stringify(wakeRecord)).not.toContain('ownerToken');

        const countsBeforeReplay = await Promise.all([
          client.xLen(keys.globalEvents),
          client.xLen(keys.projectEvents('project-1')),
          client.xLen(keys.sessionInbox('source-capable')),
          client.xLen(keys.wakeStream),
          client.zCard(keys.wakeIntentsIndex),
          client.zCard(keys.projectWakeIntents('project-1')),
        ]);
        await expect(
          messages.transitionMessage(terminal, {
            correlationId: `correlation-${suffix}`,
            responderSessionId: terminal === 'timed_out' ? '' : 'target',
            workspaceId: 'local',
            eventId: `terminal-replay-${suffix}`,
            ...terminalFields,
          }),
        ).resolves.toMatchObject({
          status: 'unchanged',
          message: { id: `message-${suffix}`, state: terminal },
        });
        await expect(
          Promise.all([
            client.xLen(keys.globalEvents),
            client.xLen(keys.projectEvents('project-1')),
            client.xLen(keys.sessionInbox('source-capable')),
            client.xLen(keys.wakeStream),
            client.zCard(keys.wakeIntentsIndex),
            client.zCard(keys.projectWakeIntents('project-1')),
          ]),
        ).resolves.toEqual(countsBeforeReplay);

        if (terminal === 'responded') {
          await client.hSet(keys.wakeIntent(`message-${suffix}`), {
            nativeSessionId: 'private-native-session',
            ownerToken: 'private-owner-token',
            response: 'private-response',
          });
          expect(await wakeIntents.getByMessage(`message-${suffix}`)).toEqual(publicWake);
          expect(JSON.stringify(publicWake)).not.toContain('private-');
        }
      },
    );

    it.each([
      ['offline source', 'source-offline'],
      ['missing wake capability', 'source-inbox-only'],
    ] as const)(
      'atomically moves the workflow to human continuation for an %s',
      async (reason, sourceSessionId) => {
        const suffix = `fallback-${reason.replaceAll(' ', '-')}`;
        await workflows.create(workflowInput(suffix, sourceSessionId));
        const messages = transitionRepository([
          `unused-wake-event-${suffix}`,
          `human-continuation-${suffix}`,
        ]);
        const terminalFields = await prepareTerminal(messages, suffix, 'responded');
        if (sourceSessionId === 'source-offline') {
          await client.del(keys.sessionPresence(sourceSessionId));
        }
        const globalBefore = await client.xLen(keys.globalEvents);
        const projectBefore = await client.xLen(keys.projectEvents('project-1'));

        try {
          await expect(
            messages.transitionMessage('responded', {
              correlationId: `correlation-${suffix}`,
              responderSessionId: 'target',
              workspaceId: 'local',
              eventId: `terminal-event-${suffix}`,
              ...terminalFields,
            }),
          ).resolves.toMatchObject({
            status: 'updated',
            message: { id: `message-${suffix}`, state: 'responded' },
          });

          expect(await client.xLen(keys.globalEvents)).toBe(globalBefore + 1);
          expect(await client.xLen(keys.projectEvents('project-1'))).toBe(projectBefore + 1);
          await expect(wakeIntents.getByMessage(`message-${suffix}`)).resolves.toBeNull();
          await expect(client.exists(keys.wakeIntent(`message-${suffix}`))).resolves.toBe(0);
          await expect(
            client.zScore(keys.wakeIntentsIndex, `message-${suffix}`),
          ).resolves.toBeNull();
          await expect(
            client.zScore(keys.projectWakeIntents('project-1'), `message-${suffix}`),
          ).resolves.toBeNull();

          await expect(workflows.get(`workflow-${suffix}`)).resolves.toMatchObject({
            state: 'waiting_for_human',
          });
          await expect(
            client.hGet(keys.workflow(`workflow-${suffix}`), 'currentHumanContinuationId'),
          ).resolves.toBe(`human-continuation-${suffix}`);
          expect((await eventRows()).slice(-1)).toEqual([
            expect.objectContaining({
              id: `terminal-event-${suffix}`,
              type: 'message.responded',
            }),
          ]);
        } finally {
          if (sourceSessionId === 'source-offline') {
            await client.set(keys.sessionPresence(sourceSessionId), sourceSessionId, {
              PX: 300_000,
            });
          }
        }
      },
    );

    it('keeps a standalone terminal message inbox-only even when its source is wake-capable', async () => {
      const suffix = 'standalone';
      await defaultMessages.createMessage(standaloneInput(suffix));
      let generatedIds = 0;
      const messages = createMessageRepository({
        client: commandClient,
        keys,
        functions: registry,
        createId: () => {
          generatedIds += 1;
          return `unexpected-${generatedIds}`;
        },
      });
      await messages.transitionMessage('delivered', {
        correlationId: `correlation-${suffix}`,
        responderSessionId: 'target',
        workspaceId: 'local',
        eventId: `event-delivered-${suffix}`,
      });
      const globalBefore = await client.xLen(keys.globalEvents);
      const wakeStreamBefore = await client.xLen(keys.wakeStream);
      const wakeIndexBefore = await client.zCard(keys.wakeIntentsIndex);

      await expect(
        messages.transitionMessage('responded', {
          correlationId: `correlation-${suffix}`,
          responderSessionId: 'target',
          workspaceId: 'local',
          eventId: `terminal-event-${suffix}`,
          responseJson: responseJson('responded', suffix),
        }),
      ).resolves.toMatchObject({
        status: 'updated',
        message: { id: `message-${suffix}`, state: 'responded' },
      });

      expect(await client.xLen(keys.globalEvents)).toBe(globalBefore + 1);
      expect(await client.xLen(keys.wakeStream)).toBe(wakeStreamBefore);
      expect(await client.zCard(keys.wakeIntentsIndex)).toBe(wakeIndexBefore);
      expect(generatedIds).toBe(0);
      await expect(wakeIntents.getByMessage(`message-${suffix}`)).resolves.toBeNull();
    });

    it('rejects a linked terminal transition sent through the legacy 10-key boundary', async () => {
      const suffix = 'legacy-bypass';
      const atomicCase = await prepareAtomicCase(suffix);
      const commandKeys = atomicCaseKeys(atomicCase.keys, suffix).slice(0, 10);
      const before = await snapshotAtomicState(atomicCase.keys, suffix);

      const reply = await commandClient.sendCommand([
        'FCALL',
        registry.functions.messageRespond,
        '10',
        ...commandKeys,
        `correlation-${suffix}`,
        'target',
        'local',
        `terminal-event-${suffix}`,
        responseJson('responded', suffix),
        '',
        '86400000',
        'luwi-session-inbox-v1',
        '0',
      ]);

      expect(JSON.parse(String(reply))).toEqual({
        status: 'error',
        code: 'REDIS_ARGUMENT_INVALID',
      });
      await expect(snapshotAtomicState(atomicCase.keys, suffix)).resolves.toEqual(before);
    });

    it('rejects a linked terminal transition when the target inbox group is missing', async () => {
      const suffix = 'missing-inbox-group';
      const atomicCase = await prepareAtomicCase(suffix);
      await expect(
        client.xGroupDestroy(atomicCase.keys.sessionInbox('target'), 'luwi-session-inbox-v1'),
      ).resolves.toBe(1);
      const before = await snapshotAtomicState(atomicCase.keys, suffix);

      await expect(
        atomicCase.messages.transitionMessage('responded', {
          correlationId: `correlation-${suffix}`,
          responderSessionId: 'target',
          workspaceId: 'local',
          eventId: `terminal-event-${suffix}`,
          responseJson: responseJson('responded', suffix),
        }),
      ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
      await expect(snapshotAtomicState(atomicCase.keys, suffix)).resolves.toEqual(before);
    });

    it.each([11, 12, 13, 14, 15, 16, 17, 18] as const)(
      'rejects the wrong Redis type for extended key %i before any write',
      async (keyNumber) => {
        const suffix = `wrong-type-${keyNumber}`;
        const atomicCase = await prepareAtomicCase(suffix);
        const corruptedKey = atomicCaseKeys(atomicCase.keys, suffix)[keyNumber - 1];
        if (corruptedKey === undefined) throw new Error('Expected an extended Function key.');
        await client.del(corruptedKey);
        if (keyNumber === 12) {
          await client.hSet(corruptedKey, 'invalid', 'type');
        } else {
          await client.set(corruptedKey, 'invalid-type');
        }
        const before = await snapshotAtomicState(atomicCase.keys, suffix);

        await expect(
          atomicCase.messages.transitionMessage('responded', {
            correlationId: `correlation-${suffix}`,
            responderSessionId: 'target',
            workspaceId: 'local',
            eventId: `terminal-event-${suffix}`,
            responseJson: responseJson('responded', suffix),
          }),
        ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
        await expect(snapshotAtomicState(atomicCase.keys, suffix)).resolves.toEqual(before);
      },
    );

    it.each([
      ['global', true],
      ['global', false],
      ['project', true],
      ['project', false],
    ] as const)(
      'rejects a %s Runtime stream with one slot for a %s wake path before any write',
      async (streamKind, wakeCapable) => {
        const path = wakeCapable ? 'eligible' : 'fallback';
        const suffix = `capacity-${streamKind}-${path}`;
        const atomicCase = await prepareAtomicCase(suffix, wakeCapable);
        const constrainedStream =
          streamKind === 'global'
            ? atomicCase.keys.globalEvents
            : atomicCase.keys.projectEvents('project-1');
        await client.xAdd(constrainedStream, '18446744073709551615-18446744073709551614', {
          boundary: 'one-slot-remains',
        });
        const before = await snapshotAtomicState(atomicCase.keys, suffix);

        await expect(
          atomicCase.messages.transitionMessage('responded', {
            correlationId: `correlation-${suffix}`,
            responderSessionId: 'target',
            workspaceId: 'local',
            eventId: `terminal-event-${suffix}`,
            responseJson: responseJson('responded', suffix),
          }),
        ).rejects.toMatchObject({ code: 'REDIS_STATE_INVALID' });
        await expect(snapshotAtomicState(atomicCase.keys, suffix)).resolves.toEqual(before);
      },
    );
  },
);
