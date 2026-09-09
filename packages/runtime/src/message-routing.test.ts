import type { SessionView } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { selectMessageTarget } from './index.js';

const session = (
  id: string,
  agentId: string,
  status: SessionView['status'],
  lastHeartbeatAt: string,
  overrides: Partial<SessionView> = {},
): SessionView => ({
  id,
  agentId,
  projectId: 'project-1',
  status,
  workingDirectory: 'C:/workspace',
  startedAt: '2026-07-29T10:00:00.000Z',
  lastHeartbeatAt,
  metadata: {},
  presence: 'online',
  ...overrides,
});

const source = session('source', 'claude-sim', 'idle', '2026-07-29T12:00:00.000Z');

describe('message target routing', () => {
  it('validates a direct same-project online non-terminal target', () => {
    const target = session('target', 'gemini-sim', 'thinking', '2026-07-29T12:00:01.000Z');

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [target],
        targetSessionId: 'target',
      }),
    ).toEqual({
      status: 'selected',
      session: target,
      reason: 'direct target session target',
    });
  });

  it('reports project mismatch separately for a direct target', () => {
    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [
          session('target', 'gemini-sim', 'idle', '2026-07-29T12:00:01.000Z', {
            projectId: 'project-2',
          }),
        ],
        targetSessionId: 'target',
      }),
    ).toEqual({ status: 'project_mismatch', targetSessionId: 'target' });
  });

  it.each([
    { presence: 'offline' as const, status: 'idle' as const },
    { presence: 'online' as const, status: 'completed' as const },
    { presence: 'online' as const, status: 'disconnected' as const },
  ])('rejects unavailable direct targets %#', (availability) => {
    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [
          session('target', 'gemini-sim', availability.status, '2026-07-29T12:00:01.000Z', {
            presence: availability.presence,
          }),
        ],
        targetSessionId: 'target',
      }),
    ).toEqual({ status: 'unavailable', selector: 'target' });
  });

  it('selects an agent session by rank, heartbeat recency, then lexical ID', () => {
    const candidates = [
      session('waiting', 'gemini-sim', 'waiting_for_input', '2026-07-29T12:05:00.000Z'),
      session('idle-old', 'gemini-sim', 'idle', '2026-07-29T12:01:00.000Z'),
      session('idle-z', 'gemini-sim', 'idle', '2026-07-29T12:04:00.000Z'),
      session('idle-a', 'gemini-sim', 'idle', '2026-07-29T12:04:00.000Z'),
      session('other-agent', 'codex-sim', 'idle', '2026-07-29T12:06:00.000Z'),
      session('other-project', 'gemini-sim', 'idle', '2026-07-29T12:07:00.000Z', {
        projectId: 'project-2',
      }),
    ];

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: candidates,
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({
      status: 'selected',
      session: candidates[3],
      reason: 'selected agent gemini-sim session idle-a by status, heartbeat, and session ID',
    });
  });

  it('prefers an eligible native headless bridge over a better-ranked interactive session', () => {
    const interactive = session('interactive', 'gemini-sim', 'idle', '2026-07-29T12:10:00.000Z');
    const bridge = session('bridge', 'gemini-sim', 'thinking', '2026-07-29T12:01:00.000Z', {
      metadata: { bridge: 'native-headless' },
    });

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [interactive, bridge],
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({
      status: 'selected',
      session: bridge,
      reason:
        'selected agent gemini-sim session bridge by native-headless bridge preference, status, heartbeat, and session ID',
    });
  });

  it('requires the native-headless bridge marker to be an exact string', () => {
    const exactMarker = session('exact', 'gemini-sim', 'idle', '2026-07-29T12:01:00.000Z', {
      metadata: { bridge: 'native-headless' },
    });
    const truthyMarker = session('truthy', 'gemini-sim', 'idle', '2026-07-29T12:03:00.000Z', {
      metadata: { bridge: true },
    });
    const otherMarker = session('other', 'gemini-sim', 'idle', '2026-07-29T12:02:00.000Z', {
      metadata: { bridge: 'native' },
    });

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [truthyMarker, otherMarker, exactMarker],
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({
      status: 'selected',
      session: exactMarker,
      reason:
        'selected agent gemini-sim session exact by native-headless bridge preference, status, heartbeat, and session ID',
    });
  });

  it('excludes offline and terminal native bridges from agent routing', () => {
    const available = session('available', 'gemini-sim', 'idle', '2026-07-29T12:01:00.000Z');
    const offline = session('offline-bridge', 'gemini-sim', 'idle', '2026-07-29T12:10:00.000Z', {
      metadata: { bridge: 'native-headless' },
      presence: 'offline',
    });
    const completed = session(
      'completed-bridge',
      'gemini-sim',
      'completed',
      '2026-07-29T12:11:00.000Z',
      {
        metadata: { bridge: 'native-headless' },
      },
    );
    const disconnected = session(
      'disconnected-bridge',
      'gemini-sim',
      'disconnected',
      '2026-07-29T12:12:00.000Z',
      { metadata: { bridge: 'native-headless' } },
    );

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [offline, completed, disconnected, available],
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({
      status: 'selected',
      session: available,
      reason: 'selected agent gemini-sim session available by status, heartbeat, and session ID',
    });
  });

  it('orders multiple eligible native bridges by status, heartbeat, then lexical ID', () => {
    const candidates = [
      session('bridge-z', 'gemini-sim', 'idle', '2026-07-29T12:05:00.000Z', {
        metadata: { bridge: 'native-headless' },
      }),
      session('bridge-a', 'gemini-sim', 'idle', '2026-07-29T12:05:00.000Z', {
        metadata: { bridge: 'native-headless' },
      }),
      session('bridge-old', 'gemini-sim', 'idle', '2026-07-29T12:04:00.000Z', {
        metadata: { bridge: 'native-headless' },
      }),
      session('bridge-waiting', 'gemini-sim', 'waiting_for_input', '2026-07-29T12:10:00.000Z', {
        metadata: { bridge: 'native-headless' },
      }),
    ];

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: candidates,
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({
      status: 'selected',
      session: candidates[1],
      reason:
        'selected agent gemini-sim session bridge-a by native-headless bridge preference, status, heartbeat, and session ID',
    });
  });

  it('preserves direct session precedence when the agent also has a native bridge', () => {
    const direct = session('direct', 'gemini-sim', 'thinking', '2026-07-29T12:01:00.000Z');
    const bridge = session('bridge', 'gemini-sim', 'idle', '2026-07-29T12:10:00.000Z', {
      metadata: { bridge: 'native-headless' },
    });

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [direct, bridge],
        targetSessionId: 'direct',
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({
      status: 'selected',
      session: direct,
      reason: 'direct target session direct',
    });
  });

  it('reports no valid online agent target deterministically', () => {
    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [
          session('offline', 'gemini-sim', 'idle', '2026-07-29T12:00:00.000Z', {
            presence: 'offline',
          }),
        ],
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({ status: 'unavailable', selector: 'gemini-sim' });
  });
});
