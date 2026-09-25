import type { Project, SessionSubagentsResponse, SessionView } from '@luwi/protocol';
import type { RedisGateway, RedisHealth } from '@luwi/redis';
import { createRuntimeReadiness } from '@luwi/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, createSessionSubagentsReader, type DaemonApp } from './app.js';
import type { DaemonConfig } from './config.js';
import type { ProjectService } from './project-service.js';
import type { SessionService } from './session-service.js';

const config: DaemonConfig = {
  host: '127.0.0.1',
  port: 80,
  redisUrl: 'redis://127.0.0.1:6379',
  logLevel: 'info',
  workspaceId: 'local',
};

class HealthyRedis implements RedisGateway {
  async connect(): Promise<boolean> {
    return true;
  }
  async checkHealth(): Promise<RedisHealth> {
    return { connected: true, status: 'connected', latencyMs: 1 };
  }
  async close(): Promise<void> {}
}

const project: Project = {
  id: 'project-1',
  name: 'LUWI Runtime',
  localPath: 'C:/workspace/luwi',
  canonicalPath: 'C:/workspace/luwi',
  createdAt: '2026-07-28T12:00:00.000Z',
  updatedAt: '2026-07-28T12:00:00.000Z',
};

function session(index: number, status: SessionView['status'] = 'idle'): SessionView {
  return {
    id: `session-${index}`,
    agentId: 'claude-coder',
    projectId: project.id,
    status,
    workingDirectory: 'C:/workspace/luwi',
    startedAt: new Date(Date.UTC(2026, 8, 25, 0, index)).toISOString(),
    lastHeartbeatAt: '2026-09-25T09:00:00.000Z',
    metadata: {},
    presence: 'online',
  };
}

const observedAt = '2026-09-25T10:00:00.000Z';
const listing = (sessionId: string): SessionSubagentsResponse => ({
  sessionId,
  status: 'observed',
  subagents: [
    {
      agentId: 'a0b1c2',
      agentType: 'general-purpose',
      description: 'A0 admin prep refactor',
      state: 'running',
      lastActivityAt: observedAt,
      lastToolName: 'Bash',
    },
  ],
  truncated: false,
  observedAt,
});

function build(
  sessions: SessionView[],
  readSessionSubagents: (sessionId: string) => Promise<SessionSubagentsResponse | null>,
  nativeRefs: Map<string, { adapterId: string; nativeSessionId: string }> = new Map(),
): DaemonApp {
  const readiness = createRuntimeReadiness('recovering');
  readiness.transitionTo('ready');
  const byId = new Map(sessions.map((candidate) => [candidate.id, candidate]));
  return buildDaemon({
    config,
    redis: new HealthyRedis(),
    logger: false,
    runtimeState: () => readiness.state,
    readiness,
    readSessionSubagents,
    now: () => new Date(observedAt),
    services: {
      projects: {
        get: async (projectId: string) => (projectId === project.id ? project : null),
        list: async () => [project],
      } as unknown as ProjectService,
      sessions: {
        get: async (sessionId: string) => byId.get(sessionId) ?? null,
        list: async (projectId?: string) =>
          projectId === undefined || projectId === project.id ? sessions : [],
        getNativeRef: async (sessionId: string) => nativeRefs.get(sessionId) ?? null,
      } as unknown as SessionService,
      listEvents: async () => [],
    },
  });
}

describe('subagent listing routes', () => {
  let app: DaemonApp | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('serves one session listing, 404 for an unknown session, refuses an oversized id', async () => {
    const reader = vi.fn(async (sessionId: string) =>
      sessionId === 'session-1' ? listing(sessionId) : null,
    );
    app = build([session(1)], reader);

    const ok = await app.inject({ method: 'GET', url: '/api/v1/sessions/session-1/subagents' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(listing('session-1'));

    const missing = await app.inject({ method: 'GET', url: '/api/v1/sessions/nope/subagents' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SESSION_NOT_FOUND');

    // Fastify's 100-character param bound answers before the 128-character schema
    // can, so no id the schema would refuse ever reaches the reader.
    reader.mockClear();
    const invalid = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${'x'.repeat(129)}/subagents`,
    });
    expect(invalid.statusCode).toBe(414);
    expect(reader).not.toHaveBeenCalled();
  });

  it('lists a project’s live sessions, newest first, capped at 20, terminal ones skipped', async () => {
    const sessions = [
      ...Array.from({ length: 22 }, (_, index) => session(index + 1)),
      session(40, 'completed'),
      session(41, 'disconnected'),
    ];
    const reader = vi.fn(async (sessionId: string) => listing(sessionId));
    app = build(sessions, reader);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/subagents',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.projectId).toBe('project-1');
    expect(body.truncated).toBe(true);
    expect(body.observedAt).toBe(observedAt);
    expect(body.sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `session-${22 - index}`),
    );
    expect(reader).toHaveBeenCalledTimes(20);
    expect(reader).not.toHaveBeenCalledWith('session-40');
    expect(reader).not.toHaveBeenCalledWith('session-41');

    const missing = await app.inject({ method: 'GET', url: '/api/v1/projects/nope/subagents' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('also reads a recently seen session whose presence ended, once per native session', async () => {
    // A GUI session whose LUWI presence broke still writes its transcript.
    const seen = (id: number, status: SessionView['status'], at: string): SessionView => ({
      ...session(id, status),
      lastHeartbeatAt: at,
    });
    const nsid = '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34';
    const sessions = [
      seen(1, 'disconnected', '2026-09-25T09:30:00.000Z'), // bound, seen 30 min ago: read
      seen(2, 'disconnected', '2026-09-25T09:00:00.000Z'), // same native session: skipped
      seen(3, 'disconnected', '2026-09-23T09:00:00.000Z'), // bound, two days ago: skipped
      seen(4, 'completed', '2026-09-25T09:45:00.000Z'), // unbound and over: skipped
      seen(5, 'idle', '2026-09-25T09:59:00.000Z'), // live and unbound: read (answers unbound)
    ];
    const refs = new Map([
      ['session-1', { adapterId: 'claude-code', nativeSessionId: nsid }],
      ['session-2', { adapterId: 'claude-code', nativeSessionId: nsid }],
      ['session-3', { adapterId: 'claude-code', nativeSessionId: 'other' }],
    ]);
    const reader = vi.fn(async (sessionId: string) => listing(sessionId));
    app = build(sessions, reader, refs);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/project-1/subagents',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions.map((entry: { sessionId: string }) => entry.sessionId)).toEqual(
      ['session-5', 'session-1'],
    );
    expect(response.json().truncated).toBe(false);
  });
});

describe('createSessionSubagentsReader', () => {
  const nativeSessionId = '0f9d2c5e-1b47-4a3d-9f80-2c6b7e1a5d34';
  const emptyFileSystem = {
    listDirectory: vi.fn(async () => undefined),
    stat: async () => undefined,
    readLines: async () => undefined,
    readTail: async () => undefined,
  };

  it('answers null, unbound, unsupported or observed from the session’s native binding', async () => {
    const refs = new Map([
      ['claude', { adapterId: 'claude-code', nativeSessionId }],
      ['codex', { adapterId: 'codex', nativeSessionId }],
    ]);
    const read = createSessionSubagentsReader({
      sessions: {
        get: async (sessionId) => (sessionId === 'missing' ? null : session(1)),
        getNativeRef: async (sessionId) => refs.get(sessionId) ?? null,
      },
      projectsRoot: 'C:/home/.claude/projects',
      fileSystem: emptyFileSystem,
    });

    expect(await read('missing')).toBeNull();
    expect(await read('plain')).toMatchObject({ status: 'unbound', subagents: [] });
    expect(await read('codex')).toMatchObject({ status: 'unsupported', subagents: [] });
    expect(emptyFileSystem.listDirectory).not.toHaveBeenCalled();
    expect(await read('claude')).toMatchObject({
      sessionId: 'claude',
      status: 'observed',
      subagents: [],
      truncated: false,
    });
    expect(emptyFileSystem.listDirectory).toHaveBeenCalledWith('C:/home/.claude/projects');
  });
});
