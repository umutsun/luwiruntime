import { describe, expect, it } from 'vitest';

import {
  bridgeOwnerDeclarationSchema,
  bridgeSlotAcquireBodySchema,
  bridgeSlotTransitionResponseSchema,
  nativeBridgeExecutionProfileSchema,
  parseBridgeSlotView,
} from './bridge.js';

const slot = {
  id: 'slot-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  agentId: 'codex',
  provider: 'codex',
  executionProfile: 'workspace-write',
  state: 'active',
  revision: 1,
  expiresAt: '2026-09-09T12:00:15.000Z',
};

describe('bridge slot view', () => {
  it('rejects a private owner token from its redacted public shape', () => {
    expect(() => parseBridgeSlotView({ ...slot, ownerToken: 'secret' })).toThrow();
  });
});

describe('bridge owner declaration', () => {
  /**
   * The slot id names a Redis key. A value that is not the SHA-256 digest the
   * key constructor expects must be a 400 at the protocol, not a 500 deep in
   * the repository (ADR 0015).
   */
  it('accepts only a 64-character lowercase SHA-256 slot id', () => {
    const declaration = {
      slotId: 'a'.repeat(64),
      ownerToken: 'token',
      provider: 'codex',
      executionProfile: 'read-only',
    };
    expect(bridgeOwnerDeclarationSchema.parse(declaration)).toEqual(declaration);
    expect(() => bridgeOwnerDeclarationSchema.parse({ ...declaration, slotId: 'x' })).toThrow();
    expect(() =>
      bridgeOwnerDeclarationSchema.parse({ ...declaration, slotId: 'A'.repeat(64) }),
    ).toThrow();
  });
});

describe('bridge slot acquire body', () => {
  /** The daemon owns the workspace id; a caller cannot acquire under another one. */
  it('takes the project and agent tuple without a workspace id', () => {
    const body = {
      projectId: 'project-1',
      agentId: 'codex',
      ownerToken: 'token',
      provider: 'codex',
      executionProfile: 'workspace-write',
    };
    expect(bridgeSlotAcquireBodySchema.parse(body)).toEqual(body);
    expect(() => bridgeSlotAcquireBodySchema.parse({ ...body, workspaceId: 'w' })).toThrow();
  });
});

describe('bridge slot transition response', () => {
  it('carries the redacted slot and a bounded status', () => {
    expect(bridgeSlotTransitionResponseSchema.parse({ status: 'held', slot })).toEqual({
      status: 'held',
      slot,
    });
    expect(() =>
      bridgeSlotTransitionResponseSchema.parse({
        status: 'acquired',
        slot: { ...slot, ownerToken: 't' },
      }),
    ).toThrow();
    expect(() => bridgeSlotTransitionResponseSchema.parse({ status: 'stolen', slot })).toThrow();
  });
});

describe('native bridge execution profile', () => {
  it('accepts only the strict enabled provider/profile leaf', () => {
    expect(
      nativeBridgeExecutionProfileSchema.parse({
        enabled: true,
        provider: 'codex',
        executionProfile: 'read-only',
      }),
    ).toEqual({
      enabled: true,
      provider: 'codex',
      executionProfile: 'read-only',
    });
    expect(() =>
      nativeBridgeExecutionProfileSchema.parse({
        enabled: true,
        provider: 'codex',
        executionProfile: 'read-only',
        additionalArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
    ).toThrow();
  });
});
