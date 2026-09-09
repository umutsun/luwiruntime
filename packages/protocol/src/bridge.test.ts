import { describe, expect, it } from 'vitest';

import { nativeBridgeExecutionProfileSchema, parseBridgeSlotView } from './bridge.js';

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
