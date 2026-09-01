import { MESSAGE_MAX_RESPONSE_BYTES } from '@luwi/protocol';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { createDeepSeekAcpFactory } from './deepseek-acp-client.js';

const fixture = fileURLToPath(new URL('./fixtures/scripted-acp-agent.mjs', import.meta.url));
const windowsFixture = fileURLToPath(new URL('./fixtures/scripted-acp-agent.cmd', import.meta.url));
const silentFixture = fileURLToPath(new URL('./fixtures/silent-acp-agent.mjs', import.meta.url));

// These are real subprocess protocol tests. Production deadlines stay much
// tighter, but a parallel Windows suite needs room to schedule cmd.exe/Node
// creation and verified process-tree cleanup without turning load into a flake.
const PROCESS_TEST_TIMEOUT_MS = 15_000;

function futureDeadline(milliseconds = 5_000): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

describe('DeepSeek ACP subprocess client', () => {
  it(
    'negotiates a fresh session, collects committed text, and fails permissions closed',
    async () => {
      const factory = createDeepSeekAcpFactory({
        command: process.execPath,
        args: [fixture],
        permission: 'reject',
        environment: process.env,
        closeGraceMs: 2_000,
      });
      const session = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'luwi-session-from-test',
        },
      });

      expect(session.sessionId).toBe('scripted-deepseek-session');
      await expect(session.prompt('PING', futureDeadline())).resolves.toEqual({
        text: 'PING|luwi=luwi-session-from-test|permission=cancelled',
        stopReason: 'end_turn',
      });
      const large = await session.prompt('LARGE', futureDeadline());
      expect(Buffer.byteLength(large.text, 'utf8')).toBeLessThanOrEqual(MESSAGE_MAX_RESPONSE_BYTES);
      await session.close();
      await session.close();
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'allows only an explicit one-shot permission policy',
    async () => {
      const factory = createDeepSeekAcpFactory({
        command: process.execPath,
        args: [fixture],
        permission: 'allow-once',
        environment: process.env,
        closeGraceMs: 2_000,
      });
      const session = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'luwi-session-from-test',
        },
      });

      await expect(session.prompt('PING', futureDeadline())).resolves.toMatchObject({
        text: expect.stringContaining('permission=allow'),
      });
      await session.close();
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === 'win32')(
    'launches an explicit Windows command shim without enabling a general shell mode',
    async () => {
      const factory = createDeepSeekAcpFactory({
        command: windowsFixture,
        args: [],
        permission: 'reject',
        environment: process.env,
        closeGraceMs: 2_000,
      });
      const session = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'luwi-session-from-cmd-test',
        },
      });

      await expect(session.prompt('PING', futureDeadline())).resolves.toMatchObject({
        text: expect.stringContaining('luwi=luwi-session-from-cmd-test'),
      });
      await session.close();
    },
    // This exercises a real cmd.exe -> Node process tree and a bounded graceful
    // close. Under the full parallel suite, Windows process startup can exceed
    // Vitest's generic 5 s unit-test budget even though the protocol deadlines
    // and close grace remain independently bounded by the production client.
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'bounds silent ACP startup and a hung prompt by explicit deadlines',
    async () => {
      const silent = createDeepSeekAcpFactory({
        command: process.execPath,
        args: [silentFixture],
        permission: 'reject',
        environment: process.env,
        startupTimeoutMs: 100,
        closeGraceMs: 500,
      });
      await expect(
        silent.start({
          workingDirectory: process.cwd(),
          signal: new AbortController().signal,
          environment: {
            LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
            LUWI_SESSION_ID: 'silent-startup',
          },
        }),
      ).rejects.toThrow('startup timed out');

      const startupAbort = new AbortController();
      const cancelledStartup = silent.start({
        workingDirectory: process.cwd(),
        signal: startupAbort.signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'cancelled-startup',
        },
      });
      startupAbort.abort();
      await expect(cancelledStartup).rejects.toThrow('startup was cancelled');

      const factory = createDeepSeekAcpFactory({
        command: process.execPath,
        args: [fixture],
        permission: 'reject',
        environment: process.env,
        cancelTimeoutMs: 100,
        closeGraceMs: 500,
      });
      const session = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'hung-prompt',
        },
      });
      await expect(
        session.prompt('HANG', new Date(Date.now() + 100).toISOString()),
      ).rejects.toThrow('deadline');
      await session.close();
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'surfaces unexpected process exit and rejects oversized malformed ACP frames without logging them',
    async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const factory = createDeepSeekAcpFactory({
        command: process.execPath,
        args: [fixture],
        permission: 'reject',
        environment: process.env,
        maxFrameBytes: 1_024,
        closeGraceMs: 500,
      });
      const malformed = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'malformed-frame',
        },
      });
      await expect(
        malformed.prompt('MALFORMED', new Date(Date.now() + 1_000).toISOString()),
      ).rejects.toThrow('frame');
      expect(consoleError).not.toHaveBeenCalled();
      await malformed.close();

      const invalid = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'invalid-frame',
        },
      });
      await expect(
        invalid.prompt('INVALID', new Date(Date.now() + 1_000).toISOString()),
      ).rejects.toThrow('frame');
      expect(consoleError).not.toHaveBeenCalled();
      await invalid.close();
      consoleError.mockRestore();

      const exited = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'unexpected-exit',
        },
      });
      void exited.prompt('EXIT', new Date(Date.now() + 1_000).toISOString()).catch(() => undefined);
      await expect(exited.closed).resolves.toBeUndefined();
      if (process.platform === 'win32') {
        await expect(exited.close()).rejects.toThrow('could not be verified');
      } else {
        await expect(exited.close()).resolves.toBeUndefined();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    'uses verified owned-tree cleanup for a Windows ACP subprocess',
    async () => {
      const cleanup = vi.fn(async (request: { rootPid: number }) => {
        process.kill(request.rootPid, 'SIGKILL');
        return true;
      });
      const factory = createDeepSeekAcpFactory({
        command: process.execPath,
        args: [fixture],
        permission: 'reject',
        environment: process.env,
        platform: 'win32',
        trustedWindowsUtilities: {
          taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
          powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        },
        windowsProcessCleanup: cleanup,
        closeGraceMs: 500,
      });
      const session = await factory.start({
        workingDirectory: process.cwd(),
        signal: new AbortController().signal,
        environment: {
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'owned-tree-cleanup',
        },
      });

      await session.close();

      expect(cleanup).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          rootExecutableName: expect.any(String),
          rootCanonicalExecutablePath: expect.any(String),
        }),
      );
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});
