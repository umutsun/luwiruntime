import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadMcpServerConfig } from './config.js';

describe('MCP server configuration', () => {
  it('requires a bound session and defaults to the loopback daemon', () => {
    expect(loadMcpServerConfig({ LUWI_SESSION_ID: 'session-1' })).toEqual({
      daemonUrl: 'http://127.0.0.1:4782',
      sessionBinding: { kind: 'static', sessionId: 'session-1' },
      requestTimeoutMs: 30_000,
    });
  });

  it('accepts one explicit absolute session file instead of a static id', () => {
    const sessionFile = resolve('session.json');
    expect(loadMcpServerConfig({ LUWI_SESSION_FILE: sessionFile })).toEqual({
      daemonUrl: 'http://127.0.0.1:4782',
      sessionBinding: { kind: 'file', path: sessionFile },
      requestTimeoutMs: 30_000,
    });
  });

  it('rejects ambiguous, absent, and relative session bindings', () => {
    expect(() => loadMcpServerConfig({})).toThrow();
    expect(() =>
      loadMcpServerConfig({
        LUWI_SESSION_ID: 'session-1',
        LUWI_SESSION_FILE: resolve('session.json'),
      }),
    ).toThrow();
    expect(() => loadMcpServerConfig({ LUWI_SESSION_FILE: 'session.json' })).toThrow();
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
