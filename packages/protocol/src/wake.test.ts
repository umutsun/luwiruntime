import { describe, expect, it } from 'vitest';

import { parseWakeIntentView } from './wake.js';

const intent = {
  id: 'wake-1',
  messageId: 'message-1',
  workflowId: 'workflow-1',
  sourceSessionId: 'session-1',
  correlationId: 'correlation-1',
  terminalState: 'responded',
  adapter: 'codex-queue-v1',
  state: 'pending',
  createdAt: '2026-09-09T12:00:00.000Z',
  updatedAt: '2026-09-09T12:00:00.000Z',
};

describe('wake intent view', () => {
  it('rejects a native session id from its redacted public shape', () => {
    expect(() => parseWakeIntentView({ ...intent, nativeSessionId: 'native' })).toThrow();
  });
});
