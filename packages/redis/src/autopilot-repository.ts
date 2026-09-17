import {
  activeTaskEntrySchema,
  autopilotRecordSchema,
  goalSchema,
  inboxNoticeEnvelopeSchema,
  taskSchema,
  type ActiveTaskEntry,
  type AutopilotRecord,
  type Goal,
  type InboxNoticeEnvelope,
  type RuntimeEvent,
  type Task,
} from '@luwi/protocol';

import type { RedisFunctionRegistry } from './function-registry.js';
import type { RedisKeys } from './redis-keys.js';
import { RedisRepositoryError, type RedisCommandClient } from './runtime-repository.js';

/**
 * Per-project autopilot, goals, tasks and coordinator notices (ADR 0035).
 *
 * Every write is a compare-and-set through a Redis Function that also owns
 * the index writes and the event; every read is validated against the
 * protocol schema because Redis data is untrusted (AGENTS.md section 7).
 */

export type CasWriteResult<Stored> =
  { status: 'written'; record: Stored } | { status: 'version_conflict'; record: Stored | null };

export type DispatchTaskResult =
  | { status: 'dispatching'; task: Task }
  | { status: 'denied'; reason: 'in_flight_limit' | 'rate_limit' | 'path_overlap'; detail: string }
  | { status: 'version_conflict'; task: Task | null };

export type QueueNoticeResult =
  { status: 'queued'; streamId: string } | { status: 'inbox_missing' };

export type { ActiveTaskEntry };

export interface AutopilotRepository {
  getAutopilot(projectId: string): Promise<AutopilotRecord | null>;
  listAutopilot(): Promise<AutopilotRecord[]>;
  putAutopilot(input: {
    record: AutopilotRecord;
    event: RuntimeEvent;
    expectedVersion: number;
  }): Promise<CasWriteResult<AutopilotRecord>>;
  queueNotice(input: {
    sessionId: string;
    projectId: string;
    notice: Omit<InboxNoticeEnvelope, 'streamId'>;
    event: RuntimeEvent;
  }): Promise<QueueNoticeResult>;

  getGoal(goalId: string): Promise<Goal | null>;
  listProjectGoals(projectId: string, limit: number): Promise<Goal[]>;
  listRetrospectiveGoals(projectId: string, limit: number): Promise<Goal[]>;
  writeGoal(input: {
    goal: Goal;
    event: RuntimeEvent | null;
    expectedVersion: number;
  }): Promise<CasWriteResult<Goal>>;

  getTask(taskId: string): Promise<Task | null>;
  listProjectTasks(projectId: string, limit: number): Promise<Task[]>;
  listGoalTasks(goalId: string): Promise<Task[]>;
  listActiveTasks(projectId: string): Promise<ActiveTaskEntry[]>;
  recentDispatchesMs(projectId: string, sinceMs: number): Promise<number[]>;
  writeTask(input: {
    task: Task;
    event: RuntimeEvent | null;
    expectedVersion: number;
    /** The in-flight entry to hold, or null to drop it. */
    active: ActiveTaskEntry | null;
  }): Promise<CasWriteResult<Task>>;
  dispatchTask(input: {
    task: Task;
    expectedVersion: number;
    nowMs: number;
    windowMs: number;
    maxInFlight: number;
    maxPerHour: number;
    active: ActiveTaskEntry;
  }): Promise<DispatchTaskResult>;
}

function invalid(detail: string): never {
  throw new RedisRepositoryError('REDIS_DATA_INVALID', `Redis autopilot ${detail} is invalid.`);
}

function decodeJsonReply(reply: unknown): Record<string, unknown> {
  if (typeof reply !== 'string') invalid('transition result');
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply) as unknown;
  } catch {
    invalid('transition result');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    invalid('transition result');
  }
  return parsed as Record<string, unknown>;
}

function storedJson(reply: unknown): unknown {
  if (reply === null || reply === undefined) return null;
  let json: unknown;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    const index = reply.indexOf('json');
    if (index < 0) invalid('record');
    json = reply[index + 1];
  } else if (typeof reply === 'object') {
    json = (reply as Record<string, unknown>).json;
    if (json === undefined) return null;
  } else {
    invalid('record');
  }
  if (typeof json !== 'string') invalid('record');
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return invalid('record');
  }
}

type Parser<Value> = {
  safeParse(value: unknown): { success: true; data: Value } | { success: false };
};

function parseWith<Value>(schema: Parser<Value>, value: unknown, label: string): Value {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(label);
  return parsed.data;
}

function stringMembers(reply: unknown): string[] {
  if (!Array.isArray(reply)) invalid('index');
  return reply.map((entry) => {
    if (typeof entry !== 'string') invalid('index');
    return entry;
  });
}

function errorCode(reply: Record<string, unknown>): never {
  const code = typeof reply.code === 'string' ? reply.code : 'REDIS_STATE_INVALID';
  throw new RedisRepositoryError(
    code === 'REDIS_ARGUMENT_INVALID' ? 'REDIS_ARGUMENT_INVALID' : 'REDIS_STATE_INVALID',
    `Redis autopilot transition failed with ${code}.`,
  );
}

export function createAutopilotRepository(options: {
  client: RedisCommandClient;
  keys: RedisKeys;
  functions: RedisFunctionRegistry;
}): AutopilotRepository {
  const { client, keys, functions } = options;

  const getAutopilot = async (projectId: string): Promise<AutopilotRecord | null> => {
    const value = storedJson(
      await client.sendCommand(['HGETALL', keys.projectAutopilot(projectId)]),
    );
    return value === null ? null : parseWith(autopilotRecordSchema, value, 'record');
  };
  const getGoal = async (goalId: string): Promise<Goal | null> => {
    const value = storedJson(await client.sendCommand(['HGETALL', keys.goal(goalId)]));
    return value === null ? null : parseWith(goalSchema, value, 'goal');
  };
  const getTask = async (taskId: string): Promise<Task | null> => {
    const value = storedJson(await client.sendCommand(['HGETALL', keys.task(taskId)]));
    return value === null ? null : parseWith(taskSchema, value, 'task');
  };
  const loadGoals = async (ids: readonly string[]): Promise<Goal[]> => {
    const goals: Goal[] = [];
    for (const id of ids) {
      const goal = await getGoal(id);
      if (goal !== null) goals.push(goal);
    }
    return goals;
  };
  const loadTasks = async (ids: readonly string[]): Promise<Task[]> => {
    const tasks: Task[] = [];
    for (const id of ids) {
      const task = await getTask(id);
      if (task !== null) tasks.push(task);
    }
    return tasks;
  };
  // The Functions hand back the JSON they stored rather than a re-encoded
  // table: cjson turns an empty array into `{}`, which the strict schemas refuse.
  const fromJson = <Stored>(schema: Parser<Stored>, value: unknown, label: string): Stored => {
    if (typeof value !== 'string') invalid(label);
    let decoded: unknown;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      invalid(label);
    }
    return parseWith(schema, decoded, label);
  };
  const casResult = <Stored>(
    reply: Record<string, unknown>,
    field: string,
    schema: Parser<Stored>,
  ): CasWriteResult<Stored> => {
    if (reply.status === 'written') {
      return { status: 'written', record: fromJson(schema, reply.json, field) };
    }
    if (reply.status === 'version_conflict') {
      const stored = reply.json;
      return {
        status: 'version_conflict',
        record: stored === undefined || stored === null ? null : fromJson(schema, stored, field),
      };
    }
    return errorCode(reply);
  };

  return {
    getAutopilot,
    async listAutopilot() {
      const ids = stringMembers(await client.sendCommand(['SMEMBERS', keys.autopilotProjects]));
      const records: AutopilotRecord[] = [];
      for (const id of ids.toSorted()) {
        const record = await getAutopilot(id);
        if (record !== null) records.push(record);
      }
      return records;
    },
    async putAutopilot(input) {
      const reply = decodeJsonReply(
        await client.sendCommand([
          'FCALL',
          functions.functions.autopilotPut,
          '4',
          keys.projectAutopilot(input.record.projectId),
          keys.autopilotProjects,
          keys.globalEvents,
          keys.projectEvents(input.record.projectId),
          JSON.stringify(input.record),
          JSON.stringify(input.event),
          String(input.expectedVersion),
        ]),
      );
      return casResult(reply, 'record', autopilotRecordSchema);
    },
    async queueNotice(input) {
      const envelope = { ...input.notice, streamId: '0-0' };
      parseWith(inboxNoticeEnvelopeSchema, envelope, 'notice');
      const { streamId: _ignored, ...stored } = envelope;
      const reply = decodeJsonReply(
        await client.sendCommand([
          'FCALL',
          functions.functions.inboxNotice,
          '3',
          keys.sessionInbox(input.sessionId),
          keys.globalEvents,
          keys.projectEvents(input.projectId),
          JSON.stringify(stored),
          JSON.stringify(input.event),
        ]),
      );
      if (reply.status === 'queued' && typeof reply.streamId === 'string') {
        return { status: 'queued', streamId: reply.streamId };
      }
      if (reply.code === 'INBOX_MISSING') return { status: 'inbox_missing' };
      return errorCode(reply);
    },

    getGoal,
    async listProjectGoals(projectId, limit) {
      const ids = stringMembers(
        await client.sendCommand([
          'ZRANGE',
          keys.projectGoals(projectId),
          '+inf',
          '-inf',
          'BYSCORE',
          'REV',
          'LIMIT',
          '0',
          String(limit),
        ]),
      );
      return loadGoals(ids);
    },
    async listRetrospectiveGoals(projectId, limit) {
      const ids = stringMembers(
        await client.sendCommand([
          'ZRANGE',
          keys.projectRetrospectives(projectId),
          '+inf',
          '-inf',
          'BYSCORE',
          'REV',
          'LIMIT',
          '0',
          String(limit),
        ]),
      );
      return loadGoals(ids);
    },
    async writeGoal(input) {
      const retrospectiveMs =
        input.goal.retrospective === undefined
          ? ''
          : String(Date.parse(input.goal.retrospective.writtenAt));
      const reply = decodeJsonReply(
        await client.sendCommand([
          'FCALL',
          functions.functions.goalWrite,
          '5',
          keys.goal(input.goal.id),
          keys.projectGoals(input.goal.projectId),
          keys.projectRetrospectives(input.goal.projectId),
          keys.globalEvents,
          keys.projectEvents(input.goal.projectId),
          JSON.stringify(input.goal),
          input.event === null ? '' : JSON.stringify(input.event),
          String(input.expectedVersion),
          String(Date.parse(input.goal.createdAt)),
          retrospectiveMs,
        ]),
      );
      return casResult(reply, 'goal', goalSchema);
    },

    getTask,
    async listProjectTasks(projectId, limit) {
      const ids = stringMembers(
        await client.sendCommand([
          'ZRANGE',
          keys.projectTasks(projectId),
          '+inf',
          '-inf',
          'BYSCORE',
          'REV',
          'LIMIT',
          '0',
          String(limit),
        ]),
      );
      return loadTasks(ids);
    },
    async listGoalTasks(goalId) {
      const ids = stringMembers(
        await client.sendCommand(['ZRANGE', keys.goalTasks(goalId), '0', '-1']),
      );
      return loadTasks(ids);
    },
    async listActiveTasks(projectId) {
      const reply = await client.sendCommand(['HGETALL', keys.projectTasksActive(projectId)]);
      const values: unknown[] = Array.isArray(reply)
        ? reply.filter((_, index) => index % 2 === 1)
        : typeof reply === 'object' && reply !== null
          ? Object.values(reply)
          : [];
      const entries: ActiveTaskEntry[] = [];
      for (const value of values) {
        if (typeof value !== 'string') invalid('active entry');
        let decoded: unknown;
        try {
          decoded = JSON.parse(value) as unknown;
        } catch {
          invalid('active entry');
        }
        entries.push(parseWith(activeTaskEntrySchema, decoded, 'active entry'));
      }
      return entries;
    },
    async recentDispatchesMs(projectId, sinceMs) {
      const reply = await client.sendCommand([
        'ZRANGE',
        keys.projectTaskDispatches(projectId),
        String(sinceMs),
        '+inf',
        'BYSCORE',
        'WITHSCORES',
      ]);
      if (!Array.isArray(reply)) invalid('dispatch index');
      // WITHSCORES arrives flat (RESP2), as [member, score] pairs, or as
      // { value, score } objects depending on the client's reply mode.
      const scores: number[] = [];
      const push = (value: unknown) => {
        const score = Number(value);
        if (!Number.isFinite(score)) invalid('dispatch index');
        scores.push(score);
      };
      if (reply.every((entry) => Array.isArray(entry) && entry.length === 2)) {
        for (const entry of reply as [unknown, unknown][]) push(entry[1]);
      } else if (
        reply.every((entry) => typeof entry === 'object' && entry !== null && 'score' in entry)
      ) {
        for (const entry of reply as { score: unknown }[]) push(entry.score);
      } else {
        for (let index = 1; index < reply.length; index += 2) push(reply[index]);
      }
      return scores;
    },
    async writeTask(input) {
      const reply = decodeJsonReply(
        await client.sendCommand([
          'FCALL',
          functions.functions.taskWrite,
          '6',
          keys.task(input.task.id),
          keys.projectTasks(input.task.projectId),
          keys.projectTasksActive(input.task.projectId),
          keys.goalTasks(input.task.goalId),
          keys.globalEvents,
          keys.projectEvents(input.task.projectId),
          JSON.stringify(input.task),
          input.event === null ? '' : JSON.stringify(input.event),
          String(input.expectedVersion),
          String(Date.parse(input.task.createdAt)),
          input.active === null ? '' : JSON.stringify(input.active),
        ]),
      );
      return casResult(reply, 'task', taskSchema);
    },
    async dispatchTask(input) {
      const reply = decodeJsonReply(
        await client.sendCommand([
          'FCALL',
          functions.functions.taskDispatch,
          '3',
          keys.task(input.task.id),
          keys.projectTasksActive(input.task.projectId),
          keys.projectTaskDispatches(input.task.projectId),
          JSON.stringify(input.task),
          String(input.expectedVersion),
          String(input.nowMs),
          String(input.windowMs),
          String(input.maxInFlight),
          String(input.maxPerHour),
          JSON.stringify(input.task.matchPaths),
          JSON.stringify(input.active),
        ]),
      );
      if (reply.status === 'dispatching') {
        return { status: 'dispatching', task: fromJson(taskSchema, reply.json, 'task') };
      }
      if (reply.status === 'denied') {
        const reason = reply.reason;
        if (reason !== 'in_flight_limit' && reason !== 'rate_limit' && reason !== 'path_overlap') {
          invalid('denial reason');
        }
        return {
          status: 'denied',
          reason,
          detail: typeof reply.detail === 'string' ? reply.detail : '',
        };
      }
      if (reply.status === 'version_conflict') {
        const stored = reply.json;
        return {
          status: 'version_conflict',
          task:
            stored === undefined || stored === null ? null : fromJson(taskSchema, stored, 'task'),
        };
      }
      return errorCode(reply);
    },
  };
}
