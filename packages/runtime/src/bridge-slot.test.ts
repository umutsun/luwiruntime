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

  it('keeps adjacent tuple fields unambiguous', () => {
    expect(deriveBridgeSlotId({ workspaceId: 'ab', projectId: 'c', agentId: 'd' })).not.toBe(
      deriveBridgeSlotId({ workspaceId: 'a', projectId: 'bc', agentId: 'd' }),
    );
    expect(deriveBridgeSlotId({ workspaceId: 'a', projectId: 'bc', agentId: 'd' })).not.toBe(
      deriveBridgeSlotId({ workspaceId: 'a', projectId: 'b', agentId: 'cd' }),
    );
  });

  it.each([
    { workspaceId: '', projectId: 'project-a', agentId: 'agent-a' },
    { workspaceId: '   ', projectId: 'project-a', agentId: 'agent-a' },
    { workspaceId: 'workspace-a', projectId: 'p'.repeat(129), agentId: 'agent-a' },
    {
      workspaceId: `workspace${String.fromCharCode(0)}a`,
      projectId: 'project-a',
      agentId: 'agent-a',
    },
  ])('rejects an ambiguous bridge slot tuple: %o', (identity) => {
    expect(() => deriveBridgeSlotId(identity)).toThrow('Bridge slot identity is invalid.');
  });

  const bridgeSlotStates = ['active', 'standby', 'degraded', 'expired'] as const;
  const allowedBridgeSlotTransitions = new Set([
    'active:standby',
    'active:degraded',
    'active:expired',
    'standby:active',
    'standby:degraded',
    'degraded:active',
    'degraded:expired',
    'expired:active',
  ]);

  it.each(
    bridgeSlotStates.flatMap((from) =>
      bridgeSlotStates.map((to) => [from, to, allowedBridgeSlotTransitions.has(`${from}:${to}`)]),
    ),
  )('uses the complete bridge slot transition matrix for %s -> %s', (from, to, expected) => {
    expect(canTransitionBridgeSlot(from, to)).toBe(expected);
  });

  it('preserves semantic slot transition examples', () => {
    expect(canTransitionBridgeSlot('active', 'degraded')).toBe(true);
    expect(canTransitionBridgeSlot('standby', 'active')).toBe(true);
    expect(canTransitionBridgeSlot('expired', 'standby')).toBe(false);
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
      { sourceSession: { hostWake: { adapter: 'other', mcpSessionId: 'mcp-session' } } },
      'adapter_mismatch',
    ],
    [
      'wrong MCP binding',
      { sourceSession: { hostWake: { adapter: 'codex-queue-v1', mcpSessionId: 'other-mcp' } } },
      'mcp_session_mismatch',
    ],
    ['trimmed links', { nativeBinding: { trimmedLinkCount: 1 } }, 'native_binding_trimmed'],
    ['negative trimmed links', { nativeBinding: { trimmedLinkCount: -1 } }, 'evidence_invalid'],
    ['fractional trimmed links', { nativeBinding: { trimmedLinkCount: 0.5 } }, 'evidence_invalid'],
    ['blank source session id', { sourceSession: { id: ' ' } }, 'evidence_invalid'],
    [
      'over-bounded source session id',
      { sourceSession: { id: 's'.repeat(129) } },
      'evidence_invalid',
    ],
    ['blank MCP session id', { sourceSession: { mcpSessionId: '' } }, 'evidence_invalid'],
    ['blank native adapter id', { nativeBinding: { adapterId: '' } }, 'evidence_invalid'],
    [
      'blank open-link session id',
      { nativeBinding: { openLink: { sessionId: '' } } },
      'evidence_invalid',
    ],
    ['offline presence', { sourceSession: { presence: 'offline' } }, 'source_session_offline'],
    ['conflicting binding', { nativeBinding: { conflicted: true } }, 'native_binding_conflict'],
    [
      'missing launcher instance id',
      { nativeBinding: { identityProvenance: { source: 'host_launcher' } } },
      'identity_untrusted',
    ],
    [
      'over-bounded launcher instance id',
      {
        nativeBinding: {
          identityProvenance: { source: 'host_launcher', launcherInstanceId: 'l'.repeat(129) },
        },
      },
      'identity_untrusted',
    ],
    [
      'NUL-containing launcher instance id',
      {
        nativeBinding: {
          identityProvenance: {
            source: 'host_launcher',
            launcherInstanceId: `launcher${String.fromCharCode(0)}id`,
          },
        },
      },
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

  it('rejects equal empty source and open-link identities as malformed evidence', () => {
    expect(
      evaluateProviderProfile({
        ...trustedCodex,
        sourceSession: { ...trustedCodex.sourceSession, id: '' },
        nativeBinding: {
          ...trustedCodex.nativeBinding,
          openLink: { sessionId: '' },
        },
      }),
    ).toEqual({ eligible: false, mode: 'inbox_only', reasonCode: 'evidence_invalid' });
  });

  it('rejects a missing open link as malformed evidence', () => {
    const nativeBinding = { ...trustedCodex.nativeBinding };
    delete nativeBinding.openLink;

    expect(evaluateProviderProfile({ ...trustedCodex, nativeBinding })).toEqual({
      eligible: false,
      mode: 'inbox_only',
      reasonCode: 'evidence_invalid',
    });
  });
});
