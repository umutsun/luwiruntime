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

  it('prefers a native-bridge worker over an interactive session sharing the agentId', () => {
    // The interactive/PM session is idle with a FRESHER heartbeat, so it would win the rank+heartbeat
    // sort — but an agentId-routed dispatch must reach the managed worker, never the PM session.
    const interactive = session('pm', 'claude-code', 'idle', '2026-07-29T12:09:00.000Z');
    const worker = session('worker', 'claude-code', 'idle', '2026-07-29T12:01:00.000Z', {
      metadata: { bridge: 'native-headless', provider: 'claude' },
    });

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [interactive, worker],
        targetAgentId: 'claude-code',
      }),
    ).toEqual({
      status: 'selected',
      session: worker,
      reason: 'selected agent claude-code session worker by status, heartbeat, and session ID',
    });
  });

  it('falls back to an interactive session when no bridge worker is present', () => {
    const interactive = session('pm', 'claude-code', 'idle', '2026-07-29T12:09:00.000Z');

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [interactive],
        targetAgentId: 'claude-code',
      }),
    ).toEqual({
      status: 'selected',
      session: interactive,
      reason: 'selected agent claude-code session pm by status, heartbeat, and session ID',
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

  it('never auto-selects a starting session, failing fast instead of timing out', () => {
    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [
          session('ghost-1', 'gemini-sim', 'starting', '2026-07-29T12:05:00.000Z'),
          session('ghost-2', 'gemini-sim', 'starting', '2026-07-29T12:06:00.000Z'),
        ],
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({ status: 'unavailable', selector: 'gemini-sim' });
  });

  it('prefers a ready worker over a starting one for the same agent', () => {
    const ready = session('ready', 'gemini-sim', 'idle', '2026-07-29T12:01:00.000Z');

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [session('ghost', 'gemini-sim', 'starting', '2026-07-29T12:09:00.000Z'), ready],
        targetAgentId: 'gemini-sim',
      }),
    ).toEqual({
      status: 'selected',
      session: ready,
      reason: 'selected agent gemini-sim session ready by status, heartbeat, and session ID',
    });
  });

  it('still honours a direct target that is starting (bound-session continuation)', () => {
    const target = session('bound', 'gemini-sim', 'starting', '2026-07-29T12:00:01.000Z');

    expect(
      selectMessageTarget({
        sourceSession: source,
        sessions: [target],
        targetSessionId: 'bound',
      }),
    ).toEqual({
      status: 'selected',
      session: target,
      reason: 'direct target session bound',
    });
  });
});
