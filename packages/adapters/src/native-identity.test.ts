import { describe, expect, it } from 'vitest';

import { resolveNativeIdentity } from './index.js';

/**
 * Identity resolution decides what a session declares about itself, so a wrong
 * answer here attributes one session's tokens to another. Every case therefore
 * asserts the absence of a binding as loudly as its presence.
 */
describe('native identity resolution', () => {
  it('resolves a Claude Code session from its own environment', () => {
    // Measured on a running session: the id is in the environment and is
    // byte-identical to the transcript stem the reader joins on.
    expect(
      resolveNativeIdentity('claude-code', {
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: '64c3e219-18aa-4539-9104-89d3d2ac5629',
      }),
    ).toEqual({
      adapterId: 'claude-code',
      nativeSessionId: '64c3e219-18aa-4539-9104-89d3d2ac5629',
    });
  });

  it('records a child session as a subagent rather than a second main session', () => {
    // A subagent's tokens belong to the session that spawned it. Treating it as
    // its own main session would invent a binding and split the evidence.
    expect(
      resolveNativeIdentity('claude-code', {
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: '64c3e219-18aa-4539-9104-89d3d2ac5629',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_PID: '56876',
      }),
    ).toEqual({
      adapterId: 'claude-code',
      nativeSessionId: '64c3e219-18aa-4539-9104-89d3d2ac5629',
      nativeSubagentId: '56876',
    });
  });

  it('resolves nothing when the environment carries no session id', () => {
    expect(resolveNativeIdentity('claude-code', {})).toBeUndefined();
    expect(resolveNativeIdentity('claude-code', { CLAUDE_CODE_SESSION_ID: '' })).toBeUndefined();
    expect(resolveNativeIdentity('claude-code', { CLAUDE_CODE_SESSION_ID: '   ' })).toBeUndefined();
  });

  it('refuses an id the protocol would reject instead of throwing', () => {
    // A malformed environment must not break an agent's startup, and it must
    // not produce a reference the daemon would refuse either.
    expect(
      resolveNativeIdentity('claude-code', { CLAUDE_CODE_SESSION_ID: 'has spaces' }),
    ).toBeUndefined();
    expect(
      resolveNativeIdentity('claude-code', { CLAUDE_CODE_SESSION_ID: '-leading-dash' }),
    ).toBeUndefined();
    expect(
      resolveNativeIdentity('claude-code', { CLAUDE_CODE_SESSION_ID: 'x'.repeat(300) }),
    ).toBeUndefined();
  });

  it('drops a malformed subagent id but keeps the session it belongs to', () => {
    // The session id is still good evidence; only the subagent half is unusable.
    expect(
      resolveNativeIdentity('claude-code', {
        CLAUDE_CODE_SESSION_ID: '64c3e219-18aa-4539-9104-89d3d2ac5629',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_PID: 'not a pid',
      }),
    ).toEqual({
      adapterId: 'claude-code',
      nativeSessionId: '64c3e219-18aa-4539-9104-89d3d2ac5629',
    });
  });

  it('resolves Codex from CODEX_SESSION_ID when a Codex exports one', () => {
    // The registry is extensible: a vendor that carries its session id in the
    // environment wires up the same way Claude does. Codex records a UUIDv7
    // session id in its rollout file; a build that exports it as CODEX_SESSION_ID
    // resolves here.
    expect(
      resolveNativeIdentity('codex', { CODEX_SESSION_ID: '019f839b-20be-7480-be44-f9c4446b59a1' }),
    ).toEqual({
      adapterId: 'codex',
      nativeSessionId: '019f839b-20be-7480-be44-f9c4446b59a1',
    });
  });

  it('resolves nothing for Codex when no session-id variable is present (the measured case)', () => {
    // Measured 2026-09-01: Codex on this machine is launched by Codex Desktop and
    // the VSCode extension, which export no session-id variable. CODEX_HOME is
    // present but is not identity. Registering unattributed beats a filesystem
    // guess that would name the wrong rollout file.
    expect(resolveNativeIdentity('codex', {})).toBeUndefined();
    expect(resolveNativeIdentity('codex', { CODEX_HOME: 'C:/Users/umuts/.codex' })).toBeUndefined();
    expect(resolveNativeIdentity('codex', { CODEX_SESSION_ID: 'has spaces' })).toBeUndefined();
  });

  it('resolves nothing for Gemini, which has no per-session identity at all', () => {
    // Measured: ~/.gemini/history/<project> is project-scoped and git-backed with
    // no session id, so even a spurious variable is ignored rather than bound.
    expect(resolveNativeIdentity('gemini-cli', {})).toBeUndefined();
    expect(resolveNativeIdentity('gemini-cli', { GEMINI_SESSION_ID: 'anything' })).toBeUndefined();
  });

  it('resolves nothing for an agent with no registered resolver', () => {
    // kimi is not installed here and `other` is deliberately open; both register
    // without a native block, the honest state for an unreadable identity.
    expect(resolveNativeIdentity('kimi', {})).toBeUndefined();
    expect(resolveNativeIdentity('other', { ANYTHING: 'x' })).toBeUndefined();
  });

  it('reads nothing from the ambient process environment', () => {
    // The environment is injected so a test cannot pass because the machine it
    // runs on happens to be inside a Claude session — which this one is.
    expect(resolveNativeIdentity('claude-code', {})).toBeUndefined();
  });
});
