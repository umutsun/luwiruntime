import { describe, expect, it } from 'vitest';

import { parseBridgeSlotView } from './bridge.js';

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
