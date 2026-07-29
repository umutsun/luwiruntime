import { describe, expect, it } from 'vitest';

import { createRedisKeys } from './index.js';

describe('Redis key registry', () => {
  it('constructs the approved production taxonomy centrally', () => {
    const keys = createRedisKeys();

    expect(keys.globalEvents).toBe('luwi:v1:events:global');
    expect(keys.projectEvents('project-1')).toBe('luwi:v1:events:project:project-1');
    expect(keys.deadLetterEvents).toBe('luwi:v1:events:dead-letter');
    expect(keys.project('project-1')).toBe('luwi:v1:project:project-1');
    expect(keys.session('session-1')).toBe('luwi:v1:session:session-1');
    expect(keys.projectsIndex).toBe('luwi:v1:index:projects');
    expect(keys.projectPathIndex('abc')).toBe('luwi:v1:index:project:path:abc');
    expect(keys.projectSessions('project-1')).toBe('luwi:v1:index:project:project-1:sessions');
    expect(keys.agentSessions('codex-sim')).toBe('luwi:v1:index:agent:codex-sim:sessions');
    expect(keys.sessionPresence('session-1')).toBe('luwi:v1:presence:session:session-1');
    expect(keys.heartbeatDeadlines).toBe('luwi:v1:deadline:heartbeats');
    expect(keys.daemonOwner).toBe('luwi:v1:runtime:daemon-owner');
  });

  it('supports a run-specific test namespace without changing suffixes', () => {
    const keys = createRedisKeys('luwi:test:run-123:v1');

    expect(keys.globalEvents).toBe('luwi:test:run-123:v1:events:global');
    expect(keys.project('project-1')).toBe('luwi:test:run-123:v1:project:project-1');
  });

  it('rejects unsafe entity identifiers before constructing keys', () => {
    const keys = createRedisKeys();

    expect(() => keys.project('project/1')).toThrow();
    expect(() => keys.agentSessions('../agent')).toThrow();
  });
});
