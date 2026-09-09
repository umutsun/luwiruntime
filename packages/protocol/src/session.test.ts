import { describe, expect, it } from 'vitest';

import {
  agentIdSchema,
  heartbeatRequestSchema,
  sessionCollectionResponseSchema,
  sessionRegistrationRequestSchema,
  sessionStatusSchema,
  sessionStatusTargetSchema,
  sessionViewSchema,
} from './index.js';

const session = {
  id: 'session-1',
  agentId: 'codex-sim',
  projectId: 'project-1',
  status: 'starting',
  workingDirectory: 'C:/workspace/luwi',
  startedAt: '2026-07-28T12:00:00.000Z',
  lastHeartbeatAt: '2026-07-28T12:00:00.000Z',
  metadata: {},
  presence: 'online',
  wakeCapable: false,
};

describe('session protocol', () => {
  it.each(['codex-sim', 'agent_1', 'vendor.agent:alpha', 'A'])(
    'accepts valid opaque agentId %s',
    (agentId) => {
      expect(agentIdSchema.parse(agentId)).toBe(agentId);
    },
  );

  it.each(['', ' ', '../codex', 'codex/sim', 'codex\\sim', '-codex', `a\nb`, 'a'.repeat(129)])(
    'rejects invalid opaque agentId %j',
    (agentId) => {
      expect(agentIdSchema.safeParse(agentId).success).toBe(false);
    },
  );

  it('defines every session status and limits status-update targets', () => {
    const statuses = [
      'starting',
      'idle',
      'thinking',
      'tool_running',
      'waiting_for_input',
      'waiting_for_agent',
      'blocked',
      'completed',
      'disconnected',
    ];

    for (const status of statuses) {
      expect(sessionStatusSchema.parse(status)).toBe(status);
    }
    expect(sessionStatusTargetSchema.safeParse('starting').success).toBe(false);
    expect(sessionStatusTargetSchema.safeParse('disconnected').success).toBe(false);
    expect(sessionStatusTargetSchema.parse('tool_running')).toBe('tool_running');
  });

  it('validates registration and session view responses', () => {
    expect(
      sessionRegistrationRequestSchema.parse({
        projectId: 'project-1',
        agentId: 'codex-sim',
        workingDirectory: '.',
        metadata: { source: 'demo' },
      }),
    ).toEqual({
      projectId: 'project-1',
      agentId: 'codex-sim',
      workingDirectory: '.',
      metadata: { source: 'demo' },
    });
    expect(sessionViewSchema.parse(session)).toEqual(session);
    expect(sessionCollectionResponseSchema.parse({ sessions: [session] })).toEqual({
      sessions: [session],
    });
  });

  it('accepts private native provenance and a host wake declaration at registration', () => {
    expect(
      sessionRegistrationRequestSchema.parse({
        projectId: 'project-1',
        agentId: 'codex-sim',
        workingDirectory: '.',
        native: { adapterId: 'codex-native-v1', nativeSessionId: 'native-1' },
        nativeIdentityProvenance: {
          source: 'host_launcher',
          launcherInstanceId: 'launcher-1',
        },
        hostWake: { adapter: 'codex-queue-v1', mcpSessionId: 'session-1' },
      }),
    ).toMatchObject({
      nativeIdentityProvenance: { source: 'host_launcher' },
      hostWake: { adapter: 'codex-queue-v1' },
    });
  });

  it('accepts legacy public views without wake capability and parses the boolean when present', () => {
    const { wakeCapable, ...legacySession } = session;
    expect(wakeCapable).toBe(false);
    expect(sessionViewSchema.parse(legacySession)).toEqual(legacySession);
    expect(sessionViewSchema.parse({ ...session, wakeCapable: true }).wakeCapable).toBe(true);
  });

  it('does not expose either private proof through a public session view', () => {
    for (const proof of [
      { hostWake: { adapter: 'codex-queue-v1', mcpSessionId: 'session-1' } },
      {
        nativeIdentityProvenance: {
          source: 'host_launcher',
          launcherInstanceId: 'launcher-1',
        },
      },
    ]) {
      expect(sessionViewSchema.safeParse({ ...session, ...proof }).success).toBe(false);
    }
  });

  it('bounds heartbeat metadata to 16 KiB of JSON', () => {
    expect(
      heartbeatRequestSchema.parse({
        metadata: { branchHead: 'abc123' },
      }),
    ).toEqual({
      metadata: { branchHead: 'abc123' },
    });
    expect(() =>
      heartbeatRequestSchema.parse({
        metadata: { oversized: 'x'.repeat(16 * 1024) },
      }),
    ).toThrow();
  });
});
