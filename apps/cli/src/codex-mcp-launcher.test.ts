import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AttachRecord = {
  request: {
    projectId: string;
    agentId: string;
    workingDirectory: string;
    native: { adapterId: string; nativeSessionId: string };
  };
  codexSid: string;
  cwd: string;
};

type ResolveOptions = {
  codexSid: string;
  cwd: string;
  temporaryDirectory: string;
  environment?: NodeJS.ProcessEnv;
  record?: AttachRecord;
  execute?: (...args: unknown[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
  };
};

describe('Codex MCP attach resolution', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'luwi-codex-mcp-resolution-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const request = {
    projectId: 'project-1',
    agentId: 'codex',
    workingDirectory: 'C:/work/app',
    native: { adapterId: 'codex', nativeSessionId: 'codex-sid' },
  };

  it('prefers an exact hook record without invoking dry-run', async () => {
    const { resolveCodexAttach } =
      (await import('../../../scripts/codex-attach-resolution.mjs')) as {
        resolveCodexAttach(options: ResolveOptions): { record: AttachRecord; plan: unknown };
      };
    const execute = vi.fn();
    const record = { request, codexSid: 'codex-sid', cwd: 'C:/work/app' };

    const result = resolveCodexAttach({
      codexSid: 'codex-sid',
      cwd: 'C:/work/app',
      temporaryDirectory: scratch,
      environment: {},
      record,
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.record).toEqual(record);
    expect(result.plan).toEqual({
      cwd: 'C:/work/app',
      sessionFile: join(scratch, 'luwi-attach-codex-codex-sid.out'),
      attachArguments: expect.arrayContaining(['--native-session', 'codex-sid']),
    });
  });

  it('resolves from exact identity and inherited cwd when no hook record exists', async () => {
    const { resolveCodexAttach } =
      (await import('../../../scripts/codex-attach-resolution.mjs')) as {
        resolveCodexAttach(options: ResolveOptions): { record: AttachRecord; plan: unknown };
      };
    const execute = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify(request),
      stderr: '',
    }));

    const result = resolveCodexAttach({
      codexSid: 'codex-sid',
      cwd: 'C:/work/app',
      temporaryDirectory: scratch,
      environment: { KEEP: 'yes', CLAUDE_PID: 'remove-me' },
      execute,
    });

    const call = execute.mock.calls[0];
    expect(call?.[1]).toEqual(
      expect.arrayContaining(['session', 'attach', '--agent-kind', 'codex', '--dry-run']),
    );
    expect(call?.[2]).toEqual(
      expect.objectContaining({
        cwd: 'C:/work/app',
        encoding: 'utf8',
        timeout: 8_000,
        env: expect.objectContaining({ CODEX_SESSION_ID: 'codex-sid', KEEP: 'yes' }),
      }),
    );
    expect((call?.[2] as { env: NodeJS.ProcessEnv }).env).not.toHaveProperty('CLAUDE_PID');
    expect(result.record).toEqual({ request, codexSid: 'codex-sid', cwd: 'C:/work/app' });
  });

  it.each([
    [{ status: 1, stdout: '', stderr: 'failed' }, 'dry-run failed'],
    [{ status: 0, stdout: 'not-json', stderr: '' }, 'invalid JSON'],
    [{ status: null, stdout: '', stderr: '', error: new Error('timed out') }, 'timed out'],
  ])('fails closed for an unusable dry-run result', async (execution, message) => {
    const { resolveCodexAttach } =
      (await import('../../../scripts/codex-attach-resolution.mjs')) as {
        resolveCodexAttach(options: ResolveOptions): { record: AttachRecord; plan: unknown };
      };

    expect(() =>
      resolveCodexAttach({
        codexSid: 'codex-sid',
        cwd: 'C:/work/app',
        temporaryDirectory: scratch,
        execute: () => execution,
      }),
    ).toThrow(message);
  });

  it('uses immediate self-resolution instead of waiting for SessionStart', async () => {
    // The deployed launcher (~/.codex/config.toml) is v3: a thin thread-id
    // normaliser that delegates to v2, where the self-resolution lives. v1
    // (`codex-mcp-launch.mjs`) was the pre-migration launcher and is deleted.
    const scripts = join(import.meta.dirname, '..', '..', '..', 'scripts');
    const entry = await readFile(join(scripts, 'codex-mcp-launch-v3.mjs'), 'utf8');
    expect(entry).toContain("await import('./codex-mcp-launch-v2.mjs')");

    const resolver = await readFile(join(scripts, 'codex-mcp-launch-v2.mjs'), 'utf8');
    expect(resolver).toContain('resolveCodexAttach({');
    expect(resolver).toContain('cwd: process.cwd()');
    expect(resolver).not.toContain('claimRecord(Date.now() + WAIT_MS');
  });
});
