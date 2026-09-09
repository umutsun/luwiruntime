import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canTransitionBridgeSlot,
  deriveBridgeSlotId,
  evaluateProviderProfile,
} from './bridge-slot.js';

describe('bridge slot policy', () => {
  it('derives one deterministic id from the workspace, project, and agent tuple', () => {
    const tuple = { workspaceId: 'workspace-a', projectId: 'project-a', agentId: 'agent-a' };
    const expected = createHash('sha256')
      .update(['workspace-a', 'project-a', 'agent-a'].join(String.fromCharCode(0)), 'utf8')
      .digest('hex');

    expect(deriveBridgeSlotId(tuple)).toBe(expected);
    expect(deriveBridgeSlotId(tuple)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not give providers separate ownership slots', () => {
    const tuple = { workspaceId: 'workspace-a', projectId: 'project-a', agentId: 'agent-a' };

    expect(deriveBridgeSlotId(tuple)).toBe(deriveBridgeSlotId({ ...tuple }));
  });

  it.each([
    ['active', 'standby', true],
    ['active', 'degraded', true],
    ['active', 'expired', true],
    ['standby', 'active', true],
    ['standby', 'degraded', true],
    ['degraded', 'active', true],
    ['degraded', 'expired', true],
    ['expired', 'active', true],
    ['active', 'active', false],
    ['standby', 'expired', false],
    ['expired', 'standby', false],
  ] as const)('allows bridge slot transition %s -> %s: %s', (from, to, expected) => {
    expect(canTransitionBridgeSlot(from, to)).toBe(expected);
  });
});

describe('provider profile policy', () => {
  const trustedCodex = {
    provider: 'codex',
    executionProfile: 'workspace-write',
    agent: { kind: 'codex', enabled: true },
    effectiveConfiguration: { valid: true },
    sourceSession: {
      id: 'source-session',
      status: 'idle',
      presence: 'online',
      mcpSessionId: 'mcp-session',
      hostWake: { adapter: 'codex-queue-v1', mcpSessionId: 'mcp-session' },
    },
    nativeBinding: {
      adapterId: 'codex-native-v1',
      kind: 'main',
      conflicted: false,
      trimmedLinkCount: 0,
      openLink: { sessionId: 'source-session' },
      identityProvenance: { source: 'host_launcher', launcherInstanceId: 'launcher-1' },
    },
  } as const;

  it('permits a trusted live main Codex source through the fixed profile', () => {
    expect(evaluateProviderProfile(trustedCodex)).toEqual({
      eligible: true,
      mode: 'automatic',
      provider: 'codex',
      executionProfile: 'workspace-write',
    });
  });

  it.each([
    [
      'filesystem evidence',
      { nativeBinding: { identityProvenance: { source: 'filesystem_heuristic' } } },
      'identity_untrusted',
    ],
    ['subagent', { nativeBinding: { kind: 'subagent' } }, 'native_subagent'],
    [
      'wrong host adapter',
      { sourceSession: { hostWake: { adapter: 'other' } } },
      'adapter_mismatch',
    ],
    [
      'wrong MCP binding',
      { sourceSession: { hostWake: { adapter: 'codex-queue-v1', mcpSessionId: 'other-mcp' } } },
      'mcp_session_mismatch',
    ],
    ['trimmed links', { nativeBinding: { trimmedLinkCount: 1 } }, 'native_binding_trimmed'],
    ['offline presence', { sourceSession: { presence: 'offline' } }, 'source_session_offline'],
    ['conflicting binding', { nativeBinding: { conflicted: true } }, 'native_binding_conflict'],
    [
      'missing launcher instance id',
      { nativeBinding: { identityProvenance: { source: 'host_launcher' } } },
      'identity_untrusted',
    ],
    [
      'stale native link',
      { nativeBinding: { openLink: { sessionId: 'other-session' } } },
      'native_binding_stale',
    ],
    [
      'unsupported provider',
      { provider: 'gemini-cli', agent: { kind: 'gemini-cli' } },
      'provider_unsupported',
    ],
    ['arbitrary profile', { executionProfile: 'dangerous' }, 'profile_unsupported'],
  ] as const)('uses an inbox-only stable reason for %s', (_caseName, patch, reasonCode) => {
    const input = {
      ...trustedCodex,
      ...patch,
      agent: { ...trustedCodex.agent, ...(patch.agent ?? {}) },
      sourceSession: { ...trustedCodex.sourceSession, ...(patch.sourceSession ?? {}) },
      nativeBinding: { ...trustedCodex.nativeBinding, ...(patch.nativeBinding ?? {}) },
    };

    expect(evaluateProviderProfile(input)).toEqual({
      eligible: false,
      mode: 'inbox_only',
      reasonCode,
    });
  });
});
