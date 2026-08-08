import { describe, expect, it } from 'vitest';

import { loadMcpServerConfig } from './config.js';

describe('MCP server configuration', () => {
  it('requires a bound session and defaults to the loopback daemon', () => {
    expect(loadMcpServerConfig({ LUWI_SESSION_ID: 'session-1' })).toEqual({
      daemonUrl: 'http://127.0.0.1:4782',
      sessionId: 'session-1',
      requestTimeoutMs: 30_000,
    });
  });

  it('rejects remote daemon URLs and invalid request timeouts', () => {
    expect(() =>
      loadMcpServerConfig({
        LUWI_SESSION_ID: 'session-1',
        LUWI_DAEMON_URL: 'https://example.test',
      }),
    ).toThrow();
    expect(() =>
      loadMcpServerConfig({
        LUWI_SESSION_ID: 'session-1',
        LUWI_MCP_REQUEST_TIMEOUT_MS: '0',
      }),
    ).toThrow();
  });
});
