import { randomUUID } from 'node:crypto';

import { createRuntimeEvent, type AutopilotRecord, type Goal, type Task } from '@luwi/protocol';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  claimSessionInbox,
  createAutopilotRepository,
  createFunctionRegistry,
  createRedisKeys,
  createRuntimeRepository,
  type AutopilotRepository,
  type RedisCommandClient,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

/**
 * The autopilot Functions (ADR 0035) against a real server. What only a real
 * server can show: a compare-and-set that refuses a stale version, a dispatch
 * race that yields exactly one dispatching task, and a notice that the inbox
 * claim returns once and never again.
 */
describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'autopilot Functions',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    const library = buildFunctionLibrary(registry);
    let client: RedisClientType;
    let commandClient: RedisCommandClient;
    let repository: AutopilotRepository;

    const nowMs = 1_800_000_000_000;
    const at = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
    const event = (
      type: 'goal.created' | 'task.created' | 'autopilot.mode.changed' | 'autopilot.notice.queued',
    ) => createRuntimeEvent({ type, workspaceId: 'local', projectId: 'project-1', payload: {} });

    const record = (overrides: Partial<AutopilotRecord> = {}): AutopilotRecord => ({
      projectId: 'project-1',
      mode: 'off',
      policy: null,
      version: 1,
      changedAt: at(0),
      ...overrides,
    });
    const goal = (overrides: Partial<Goal> = {}): Goal => ({
      id: 'goal-1',
      projectId: 'project-1',
      title: 'Ship',
      objective: 'Ship it.',
      acceptanceCriteria: [],
      createdBy: { kind: 'operator' },
      budget: {
        maxTasks: 12,
        maxReworksPerTask: 1,
        maxReplans: 2,
        maxWallClockMs: 14_400_000,
        minConfidence: 0.6,
      },
      state: 'proposed',
      planVersion: 0,
      taskIds: [],
      usage: { tasks: 0, reworks: 0, replans: 0, judgments: 0, invalidJudgments: 0 },
      version: 1,
      createdAt: at(0),
      updatedAt: at(0),
      ...overrides,
    });
    const task = (id: string, overrides: Partial<Task> = {}): Task => ({
      id,
      projectId: 'project-1',
      goalId: 'goal-1',
      title: id,
      brief: 'Do it.',
      agentId: 'claude-code',
      paths: [`src/${id}`],
      matchPaths: [`src/${id}/`],
      dependsOn: [],
      evidenceRequirements: [],
      timeoutMs: 600_000,
      kind: 'work',
      reworkCount: 0,
      state: 'ready',
      version: 1,
      createdAt: at(0),
      updatedAt: at(0),
      ...overrides,
    });
    const dispatch = (
      candidate: Task,
      overrides: { maxInFlight?: number; maxPerHour?: number; nowMs?: number } = {},
    ) =>
      repository.dispatchTask({
        task: { ...candidate, state: 'dispatching', version: candidate.version + 1 },
        expectedVersion: candidate.version,
        nowMs: overrides.nowMs ?? nowMs,
        windowMs: 3_600_000,
        maxInFlight: overrides.maxInFlight ?? 2,
        maxPerHour: overrides.maxPerHour ?? 10,
        active: {
          taskId: candidate.id,
          goalId: candidate.goalId,
          agentId: candidate.agentId ?? 'claude-code',
          state: 'dispatching',
          matchPaths: candidate.matchPaths,
        },
      });

    beforeAll(async () => {
      client = createClient({ url: testRedisUrl });
      client.on('error', () => undefined);
      await client.connect();
      commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
      await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
      repository = createAutopilotRepository({ client: commandClient, keys, functions: registry });
      const runtime = createRuntimeRepository({ client: commandClient, keys, functions: registry });
      await runtime.registerProject({
        project: {
          id: 'project-1',
          name: 'Autopilot',
          localPath: 'C:/workspace/autopilot',
          canonicalPath: 'C:/workspace/autopilot',
          identityPath: 'c:/workspace/autopilot',
          pathIdentityHash: 'e'.repeat(64),
        },
        workspaceId: 'local',
        eventId: 'event-project',
      });
      await runtime.registerSession({
        session: {
          id: 'coordinator-1',
          agentId: 'luwibot',
          projectId: 'project-1',
          status: 'starting',
          workingDirectory: 'C:/workspace/autopilot',
          metadataJson: '{}',
        },
        workspaceId: 'local',
        eventId: 'event-session',
        presenceTtlMs: 15_000,
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

    it('creates the autopilot record at version 1, refuses a stale version, and lists it', async () => {
      const created = await repository.putAutopilot({
        record: record(),
        event: event('autopilot.mode.changed'),
        expectedVersion: 0,
      });
      expect(created).toMatchObject({ status: 'written', record: { mode: 'off', version: 1 } });
      const stale = await repository.putAutopilot({
        record: record({ mode: 'supervised', version: 3 }),
        event: event('autopilot.mode.changed'),
        expectedVersion: 2,
      });
      expect(stale).toMatchObject({ status: 'version_conflict', record: { version: 1 } });
      expect(await repository.getAutopilot('project-1')).toMatchObject({ mode: 'off', version: 1 });
      expect(await repository.listAutopilot()).toHaveLength(1);
    });

    it('writes a goal with its event and indexes a retrospective when one is set', async () => {
      const created = await repository.writeGoal({
        goal: goal(),
        event: event('goal.created'),
        expectedVersion: 0,
      });
      expect(created).toMatchObject({ status: 'written' });
      const ended = goal({
        state: 'achieved',
        version: 2,
        retrospective: { summary: 'fine', workerNotes: {}, writtenAt: at(60_000) },
      });
      expect(
        await repository.writeGoal({ goal: ended, event: null, expectedVersion: 1 }),
      ).toMatchObject({ status: 'written' });
      expect(await repository.listRetrospectiveGoals('project-1', 5)).toMatchObject([
        { id: 'goal-1', state: 'achieved' },
      ]);
      expect(await repository.listProjectGoals('project-1', 10)).toHaveLength(1);
    });

    it('dispatches within the limits and refuses the in-flight limit, the rate window and an overlapping path', async () => {
      for (const id of ['t1', 't2', 't3']) {
        await repository.writeTask({
          task: task(id),
          event: event('task.created'),
          expectedVersion: 0,
          active: null,
        });
      }
      expect(await dispatch(task('t1'))).toMatchObject({
        status: 'dispatching',
        task: { state: 'dispatching' },
      });
      expect(await repository.listActiveTasks('project-1')).toMatchObject([{ taskId: 't1' }]);
      expect(await dispatch(task('t2', { paths: ['src'], matchPaths: ['src/'] }))).toMatchObject({
        status: 'denied',
        reason: 'path_overlap',
        detail: 't1',
      });
      expect(await dispatch(task('t2'), { maxInFlight: 1 })).toMatchObject({
        status: 'denied',
        reason: 'in_flight_limit',
      });
      expect(await dispatch(task('t2'), { maxPerHour: 1 })).toMatchObject({
        status: 'denied',
        reason: 'rate_limit',
      });
      expect(await dispatch(task('t2'))).toMatchObject({ status: 'dispatching' });
      expect(await repository.recentDispatchesMs('project-1', nowMs - 3_600_000)).toEqual([
        nowMs,
        nowMs,
      ]);
      // A refusal wrote nothing: t3 is still at version 1 and ready.
      expect(await repository.getTask('t3')).toMatchObject({ state: 'ready', version: 1 });
    });

    it('lets exactly one of two racing dispatches take the last in-flight slot', async () => {
      for (const id of ['r1', 'r2']) {
        await repository.writeTask({
          task: task(id),
          event: event('task.created'),
          expectedVersion: 0,
          active: null,
        });
      }
      const [first, second] = await Promise.all([
        dispatch(task('r1'), { maxInFlight: 3 }),
        dispatch(task('r2'), { maxInFlight: 3 }),
      ]);
      const dispatching = [first, second].filter((result) => result.status === 'dispatching');
      const denied = [first, second].filter((result) => result.status === 'denied');
      expect(dispatching).toHaveLength(1);
      expect(denied).toMatchObject([{ reason: 'in_flight_limit' }]);
    });

    it('dispatches a review over an in-flight path: it reads a commit and claims no path', async () => {
      // t1 is still in flight over src/t1/; a work task over src/ was refused above.
      const review = task('rv1', { kind: 'review', paths: ['src'], matchPaths: ['src/'] });
      await repository.writeTask({
        task: review,
        event: event('task.created'),
        expectedVersion: 0,
        active: null,
      });
      expect(await dispatch(review, { maxInFlight: 10 })).toMatchObject({
        status: 'dispatching',
      });
    });

    it('drops the in-flight entry when a task is written as terminal', async () => {
      const current = await repository.getTask('t1');
      expect(current).not.toBeNull();
      const done = {
        ...(current as Task),
        state: 'done' as const,
        version: (current as Task).version + 1,
      };
      expect(
        await repository.writeTask({
          task: done,
          event: null,
          expectedVersion: (current as Task).version,
          active: null,
        }),
      ).toMatchObject({ status: 'written' });
      expect(
        (await repository.listActiveTasks('project-1')).map((entry) => entry.taskId),
      ).not.toContain('t1');
    });

    it('queues a notice into a registered session inbox that the claim path returns once and acknowledges', async () => {
      const queued = await repository.queueNotice({
        sessionId: 'coordinator-1',
        projectId: 'project-1',
        notice: {
          itemKind: 'notice',
          targetSessionId: 'coordinator-1',
          createdAt: at(0),
          payload: { kind: 'kick', projectId: 'project-1' },
        },
        event: event('autopilot.notice.queued'),
      });
      expect(queued).toMatchObject({ status: 'queued' });
      const claim = () =>
        claimSessionInbox({
          client: commandClient,
          keys,
          sessionId: 'coordinator-1',
          bridgeInstanceId: 'orchestrator',
          limit: 10,
          minIdleMs: 0,
          getMessage: async () => null,
          markDelivered: async () => undefined,
        });
      const first = await claim();
      expect(first.items).toMatchObject([{ itemKind: 'notice', payload: { kind: 'kick' } }]);
      const second = await claim();
      expect(second.items).toHaveLength(0);
      const pending = (await commandClient.sendCommand([
        'XPENDING',
        keys.sessionInbox('coordinator-1'),
        'luwi-session-inbox-v1',
      ])) as unknown[];
      expect(pending[0]).toBe(0);
    });

    it('refuses a notice for a session with no inbox rather than creating a group-less stream', async () => {
      expect(
        await repository.queueNotice({
          sessionId: 'nobody',
          projectId: 'project-1',
          notice: {
            itemKind: 'notice',
            targetSessionId: 'nobody',
            createdAt: at(0),
            payload: { kind: 'kick', projectId: 'project-1' },
          },
          event: event('autopilot.notice.queued'),
        }),
      ).toEqual({ status: 'inbox_missing' });
    });
  },
);
