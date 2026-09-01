import { describe, expect, it, vi } from 'vitest';

import { AUTOSTART_TASK_NAME, createAutostart, type AutostartCommandResult } from './autostart.js';

const NODE = 'C:/Program Files/nodejs/node.exe';
const CLI = 'C:/xampp/htdocs/luwiruntime/apps/cli/dist/main.js';

function harness(
  result: Partial<AutostartCommandResult> = {},
  platform: NodeJS.Platform = 'win32',
) {
  const runCommand = vi.fn(async (): Promise<AutostartCommandResult> => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...result,
  }));
  const autostart = createAutostart({ platform, runCommand, nodeExecutable: NODE, cliEntry: CLI });
  return { autostart, runCommand };
}

describe('windows autostart', () => {
  it('registers a per-user logon task that runs the idempotent CLI start', async () => {
    const { autostart, runCommand } = harness();

    await expect(autostart.enable()).resolves.toBe('enabled');
    expect(runCommand).toHaveBeenCalledWith('schtasks', [
      '/Create',
      '/TN',
      AUTOSTART_TASK_NAME,
      '/TR',
      `"${NODE}" "${CLI}" start`,
      '/SC',
      'ONLOGON',
      '/F',
    ]);
  });

  it('surfaces a registration failure rather than reporting success', async () => {
    const { autostart } = harness({ exitCode: 1, stderr: 'Access is denied.' });

    await expect(autostart.enable()).rejects.toMatchObject({ code: 'AUTOSTART_REGISTER_FAILED' });
  });

  it('removes the task', async () => {
    const { autostart, runCommand } = harness();

    await expect(autostart.disable()).resolves.toBe('disabled');
    expect(runCommand).toHaveBeenCalledWith('schtasks', [
      '/Delete',
      '/TN',
      AUTOSTART_TASK_NAME,
      '/F',
    ]);
  });

  it('treats removing a task that was never there as already disabled', async () => {
    const { autostart } = harness({
      exitCode: 1,
      stderr: 'ERROR: The system cannot find the file specified.',
    });

    await expect(autostart.disable()).resolves.toBe('disabled');
  });

  it('surfaces a genuine removal failure', async () => {
    const { autostart } = harness({ exitCode: 1, stderr: 'Access is denied.' });

    await expect(autostart.disable()).rejects.toMatchObject({ code: 'AUTOSTART_REMOVE_FAILED' });
  });

  it('reports enabled when the task query succeeds', async () => {
    const { autostart } = harness({ exitCode: 0 });

    await expect(autostart.status()).resolves.toBe('enabled');
  });

  it('reports disabled when the task query fails', async () => {
    const { autostart } = harness({ exitCode: 1, stderr: 'cannot find' });

    await expect(autostart.status()).resolves.toBe('disabled');
  });

  it('is unsupported off Windows and never spawns schtasks there', async () => {
    const { autostart, runCommand } = harness({}, 'linux');

    await expect(autostart.enable()).resolves.toBe('unsupported');
    await expect(autostart.disable()).resolves.toBe('unsupported');
    await expect(autostart.status()).resolves.toBe('unsupported');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
