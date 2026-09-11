import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * ADR 0031: a native process launched under a LUWI session (`agent run`, the
 * native inbox bridge) inherits `LUWI_SESSION_ID`. Its vendor hooks still fire —
 * Claude runs `SessionStart` in `--print` mode too — and must not register a
 * second, reader-less LUWI session. Both hooks exit before touching anything.
 */
const run = promisify(execFile);
const scripts = join(import.meta.dirname, '..', '..', '..', 'scripts');

describe('MCP reload process safety', () => {
  it('limits wildcard command-line matches to Node MCP child processes', async () => {
    const source = await readFile(join(scripts, 'mcp-reload.mjs'), 'utf8');

    expect(source).toContain("$_.Name -eq 'node.exe' -and (");
  });
});

describe('Antigravity MCP launcher security', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'luwi-antigravity-launcher-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const environment = (): NodeJS.ProcessEnv => {
    const result = {
      ...process.env,
      TEMP: scratch,
      TMP: scratch,
      TMPDIR: scratch,
      LUWI_SESSION_ID: 'missing-test-session',
      LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
      ANTIGRAVITY_CSRF_TOKEN: 'must-not-appear-in-diagnostics',
    };
    delete result.LUWI_SESSION_FILE;
    delete result.LUWI_ANTIGRAVITY_DIAGNOSTICS;
    return result;
  };

  it('keeps diagnostics off by default and never records environment values when opted in', async () => {
    const launcher = join(scripts, 'antigravity-mcp-launch.mjs');
    await run(process.execPath, [launcher], { env: environment(), timeout: 5_000 }).catch(
      () => undefined,
    );
    expect(await readdir(scratch)).not.toContain('luwi-antigravity-mcp-launch.diag.json');

    await run(process.execPath, [launcher], {
      env: { ...environment(), LUWI_ANTIGRAVITY_DIAGNOSTICS: '1' },
      timeout: 5_000,
    }).catch(() => undefined);
    const diagnostic = JSON.parse(
      await readFile(join(scratch, 'luwi-antigravity-mcp-launch.diag.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(JSON.stringify(diagnostic)).not.toContain('must-not-appear-in-diagnostics');
    expect(diagnostic).not.toHaveProperty('env');
    expect(diagnostic['environmentKeys']).toEqual(
      expect.arrayContaining(['ANTIGRAVITY_CSRF_TOKEN']),
    );
  });

  it('rejects a non-loopback daemon URL before sending a session identifier', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ presence: 'online' }));
    });
    server.listen(0, '0.0.0.0');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing test address');
      const sessionFile = join(scratch, 'session.out');
      await writeFile(sessionFile, '{"attached":"private-session-id"}', { mode: 0o600 });
      await writeFile(
        join(scratch, 'luwi-antigravity-current.json'),
        JSON.stringify({ sessionFile }),
        { mode: 0o600 },
      );
      const childEnvironment = environment();
      delete childEnvironment.LUWI_SESSION_ID;
      childEnvironment.LUWI_DAEMON_URL = `http://0.0.0.0:${String(address.port)}`;

      await run(process.execPath, [join(scripts, 'antigravity-mcp-launch.mjs')], {
        env: childEnvironment,
        timeout: 5_000,
      }).catch(() => undefined);

      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('attach hooks under an inherited LUWI session', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'luwi-hook-guard-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const environment = () => ({
    ...process.env,
    LUWI_SESSION_ID: 'session-from-bridge',
    TEMP: scratch,
    TMP: scratch,
    TMPDIR: scratch,
  });

  it('claude-attach-hook start writes nothing and spawns no attach', async () => {
    const { stdout } = await run(
      process.execPath,
      [join(scripts, 'claude-attach-hook.mjs'), 'start'],
      { env: environment(), input: JSON.stringify({ session_id: 'claude-sid', cwd: scratch }) },
    );
    expect(stdout).toBe('');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('codex-attach-hook start writes nothing and spawns no attach', async () => {
    const { stdout } = await run(
      process.execPath,
      [join(scripts, 'codex-attach-hook.mjs'), 'start'],
      { env: environment(), input: JSON.stringify({ session_id: 'codex-sid', cwd: scratch }) },
    );
    expect(stdout).toBe('');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('antigravity-attach-hook still answers {} and writes nothing', async () => {
    const { stdout } = await run(process.execPath, [join(scripts, 'antigravity-attach-hook.mjs')], {
      env: environment(),
      input: JSON.stringify({ conversationId: 'conv-1', workspacePaths: [scratch] }),
    });
    expect(stdout).toBe('{}');
    expect(await readdir(scratch)).toEqual([]);
  });

  it('rejects an Antigravity conversation traversal before writing a pid file', async () => {
    const isolatedTemp = join(scratch, 'temp');
    await mkdir(isolatedTemp);
    const childEnvironment = {
      ...process.env,
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      TMPDIR: isolatedTemp,
    };
    delete childEnvironment.LUWI_SESSION_ID;
    delete childEnvironment.LUWI_SESSION_FILE;

    await run(process.execPath, [join(scripts, 'antigravity-attach-hook.mjs')], {
      cwd: process.cwd(),
      env: childEnvironment,
      timeout: 2_000,
      input: JSON.stringify({
        conversationId: 'x/../../escaped',
        workspacePaths: [process.cwd()],
      }),
    }).catch(() => undefined);

    await expect(readFile(join(scratch, 'escaped.pid'), 'utf8')).rejects.toThrow();
  });
});

describe('native MCP launcher binding environment', () => {
  it('passes a rotating session file without retaining a stale static id', async () => {
    const { mcpServerEnvironment } = (await import('../../../scripts/claude-mcp-launch.mjs')) as {
      mcpServerEnvironment(
        environment: NodeJS.ProcessEnv,
        binding: { sessionId: string; sessionFile?: string },
      ): NodeJS.ProcessEnv;
    };

    expect(
      mcpServerEnvironment(
        { LUWI_SESSION_ID: 'stale', LUWI_SESSION_FILE: 'stale-file', KEEP: 'yes' },
        { sessionId: 'current', sessionFile: 'C:/Temp/session.out' },
      ),
    ).toEqual({ LUWI_SESSION_FILE: 'C:/Temp/session.out', KEEP: 'yes' });
    expect(
      mcpServerEnvironment(
        { LUWI_SESSION_ID: 'old', LUWI_SESSION_FILE: 'old-file', KEEP: 'yes' },
        { sessionId: 'static' },
      ),
    ).toEqual({ LUWI_SESSION_ID: 'static', KEEP: 'yes' });
  });

  it('builds a Codex-owned rotating attach command and file-backed MCP environment', async () => {
    const { codexAttachPlan, mcpServerEnvironment, sessionAttachArguments } =
      (await import('../../../scripts/native-mcp-binding.mjs')) as {
        codexAttachPlan(
          record: {
            request: {
              projectId: string;
              agentId: string;
              workingDirectory: string;
              native: { adapterId: string; nativeSessionId: string };
              metadata?: { model?: string };
            };
            codexSid: string;
            cwd: string;
          },
          temporaryDirectory: string,
        ): { cwd: string; sessionFile: string; attachArguments: string[] };
        mcpServerEnvironment(
          environment: NodeJS.ProcessEnv,
          binding: { sessionId: string; sessionFile?: string },
        ): NodeJS.ProcessEnv;
        sessionAttachArguments(
          request: {
            projectId: string;
            agentId: string;
            workingDirectory: string;
            native: { adapterId: string; nativeSessionId: string };
            metadata?: { model?: string };
          },
          sessionFile: string,
        ): string[];
      };

    const sessionFile = join('C:/Temp', 'luwi-attach-codex-codex-sid.out');
    expect(
      sessionAttachArguments(
        {
          projectId: 'project-1',
          agentId: 'codex',
          workingDirectory: 'C:/work/app',
          native: { adapterId: 'codex', nativeSessionId: 'codex-sid' },
          metadata: { model: 'gpt-6-astra' },
        },
        sessionFile,
      ),
    ).toEqual([
      'session',
      'attach',
      '--project',
      'project-1',
      '--agent',
      'codex',
      '--agent-kind',
      'codex',
      '--native-adapter',
      'codex',
      '--native-session',
      'codex-sid',
      '--working-directory',
      'C:/work/app',
      '--session-out',
      sessionFile,
      '--model',
      'gpt-6-astra',
    ]);
    expect(
      mcpServerEnvironment(
        { LUWI_SESSION_ID: 'stale', LUWI_SESSION_FILE: 'old', KEEP: 'yes' },
        { sessionId: 'current', sessionFile },
      ),
    ).toEqual({ LUWI_SESSION_FILE: sessionFile, KEEP: 'yes' });
    expect(
      codexAttachPlan(
        {
          request: {
            projectId: 'project-1',
            agentId: 'codex',
            workingDirectory: 'C:/work/app',
            native: { adapterId: 'codex', nativeSessionId: 'codex-sid' },
          },
          codexSid: 'codex-sid',
          cwd: 'C:/work/app',
        },
        'C:/Temp',
      ),
    ).toEqual({
      cwd: 'C:/work/app',
      sessionFile,
      attachArguments: expect.arrayContaining(['--session-out', sessionFile]),
    });
  });

  it('keeps inherited bridge sessions static', async () => {
    const { mcpServerEnvironment } = (await import('../../../scripts/native-mcp-binding.mjs')) as {
      mcpServerEnvironment(
        environment: NodeJS.ProcessEnv,
        binding: { sessionId: string; sessionFile?: string },
      ): NodeJS.ProcessEnv;
    };

    expect(
      mcpServerEnvironment(
        { LUWI_SESSION_ID: 'old', LUWI_SESSION_FILE: 'old-file', KEEP: 'yes' },
        { sessionId: 'bridge-session' },
      ),
    ).toEqual({ LUWI_SESSION_ID: 'bridge-session', KEEP: 'yes' });
  });

  it('creates conversation-scoped binding and pid files without path traversal', async () => {
    const { conversationPidFile, conversationSessionFile } =
      (await import('../../../scripts/native-mcp-binding.mjs')) as {
        conversationPidFile(
          temporaryDirectory: string,
          vendor: 'antigravity',
          nativeSessionId: string,
        ): string;
        conversationSessionFile(
          temporaryDirectory: string,
          vendor: 'codex' | 'antigravity',
          nativeSessionId: string,
        ): string;
      };

    expect(conversationSessionFile('C:/Temp', 'codex', 'codex-sid')).toBe(
      join('C:/Temp', 'luwi-attach-codex-codex-sid.out'),
    );
    expect(conversationSessionFile('C:/Temp', 'antigravity', 'conversation-1')).toBe(
      join('C:/Temp', 'luwi-attach-antigravity-conversation-1.out'),
    );
    expect(conversationPidFile('C:/Temp', 'antigravity', 'conversation-1')).toBe(
      join('C:/Temp', 'luwi-antigravity-conversation-1.pid'),
    );
    expect(() => conversationSessionFile('C:/Temp', 'codex', '../escape')).toThrow(
      'native session id',
    );
    expect(() => conversationPidFile('C:/Temp', 'antigravity', 'x/../../escape')).toThrow(
      'native session id',
    );
  });

  it('binds a Codex launcher to its exact native conversation identity', async () => {
    const { codexNativeSessionId } = (await import('../../../scripts/native-mcp-binding.mjs')) as {
      codexNativeSessionId(environment: NodeJS.ProcessEnv): string | undefined;
    };

    expect(
      codexNativeSessionId({ CODEX_SESSION_ID: 'codex-sid', CODEX_THREAD_ID: 'codex-sid' }),
    ).toBe('codex-sid');
    expect(codexNativeSessionId({})).toBeUndefined();
    expect(() => codexNativeSessionId({ CODEX_SESSION_ID: 'one', CODEX_THREAD_ID: 'two' })).toThrow(
      'identity',
    );
  });

  it('securely resolves launcher environment files and rejects ambiguous or unsafe bindings', async () => {
    const { environmentSessionBinding } =
      (await import('../../../scripts/native-mcp-binding.mjs')) as {
        environmentSessionBinding(
          environment: NodeJS.ProcessEnv,
        ): { sessionId: string; sessionFile?: string } | undefined;
      };
    const scratch = await mkdtemp(join(tmpdir(), 'luwi-native-binding-'));
    try {
      const sessionFile = join(scratch, 'session.out');
      await writeFile(sessionFile, '{"attached":"current"}\n', { mode: 0o600 });
      expect(environmentSessionBinding({ LUWI_SESSION_FILE: sessionFile })).toEqual({
        sessionId: 'current',
        sessionFile,
      });
      expect(() =>
        environmentSessionBinding({
          LUWI_SESSION_ID: 'static',
          LUWI_SESSION_FILE: sessionFile,
        }),
      ).toThrow('both');

      const oversized = join(scratch, 'oversized.out');
      await writeFile(oversized, 'x'.repeat(4097), { mode: 0o600 });
      expect(() => environmentSessionBinding({ LUWI_SESSION_FILE: oversized })).toThrow(
        'session binding file',
      );
      const target = join(scratch, 'target');
      const linked = join(scratch, 'linked');
      await mkdir(target);
      await symlink(target, linked, 'junction');
      expect(() => environmentSessionBinding({ LUWI_SESSION_FILE: linked })).toThrow(
        'session binding file',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('publishes private hook records atomically without touching a fixed temp hard link', async () => {
    const { writePrivateJsonFile } = (await import('../../../scripts/native-mcp-binding.mjs')) as {
      writePrivateJsonFile(path: string, value: unknown): void;
    };
    const scratch = await mkdtemp(join(tmpdir(), 'luwi-native-writer-'));
    try {
      const target = join(scratch, 'record.json');
      const sentinel = join(scratch, 'sentinel');
      await writeFile(sentinel, 'do-not-touch', { mode: 0o600 });
      await link(sentinel, `${target}.tmp`);

      writePrivateJsonFile(target, { request: 'current' });

      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ request: 'current' });
      expect(await readFile(sentinel, 'utf8')).toBe('do-not-touch');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('session binding file with a native reference (ADR 0034)', () => {
  it('accepts the native block beside the id and still rejects anything else', async () => {
    const { readSessionBindingFile } =
      (await import('../../../scripts/native-mcp-binding.mjs')) as {
        readSessionBindingFile(path: string): string;
      };
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'luwi-binding-record-'));
    const write = async (name: string, record: unknown) => {
      const path = join(root, name);
      await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      return path;
    };
    try {
      const native = { adapterId: 'claude-code', nativeSessionId: 'native-1' };
      expect(readSessionBindingFile(await write('a.json', { attached: 's1' }))).toBe('s1');
      expect(readSessionBindingFile(await write('b.json', { attached: 's1', native }))).toBe('s1');
      for (const record of [
        { attached: 's1', projectId: 'forged' },
        { attached: 's1', native: { adapterId: 'claude-code' } },
        { attached: 's1', native: { ...native, extra: true } },
        { attached: 's1', native: 'native-1' },
      ]) {
        expect(() => readSessionBindingFile(root)).toThrow();
        await expect(
          write('c.json', record).then((path) => readSessionBindingFile(path)),
        ).rejects.toThrow('invalid LUWI session binding file');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
