import { ApplicationError } from '@luwi/runtime';

/**
 * Opt-in Windows autostart (ADR 0027).
 *
 * Registers a per-user logon Scheduled Task that runs `luwi start` — the same
 * idempotent start a developer runs by hand, so autostart adds no second startup
 * path. It is a task, not a service or a supervisor: no elevation, no detached
 * session, no persistent LUWI process. It never installs itself as a side effect
 * — the developer asks through `luwi setup --autostart`.
 *
 * Everything here is a fixed, safe `schtasks` invocation: the task name is a
 * constant and the command is the resolved node executable plus the CLI entry,
 * so no user-controlled string reaches the scheduler.
 */

/** The Scheduled Task name. A constant, never taken from input. */
export const AUTOSTART_TASK_NAME = 'LUWI Runtime';
/** Independent logon task for the managed wake supervisor. */
export const WAKE_AUTOSTART_TASK_NAME = 'LUWI Wake Dispatcher';

export type AutostartState = 'enabled' | 'disabled' | 'unsupported';

export type AutostartCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type AutostartCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<AutostartCommandResult>;

export type AutostartOptions = {
  platform: NodeJS.Platform;
  runCommand: AutostartCommandRunner;
  /** The node executable the task will run. */
  nodeExecutable: string;
  /** The CLI entry (`<installationRoot>/apps/cli/dist/main.js`) the task will run. */
  cliEntry: string;
};

export interface Autostart {
  enable(): Promise<AutostartState>;
  disable(): Promise<AutostartState>;
  status(): Promise<AutostartState>;
}

/** schtasks reports a missing task on delete/query with one of these; it means
 *  "already not there", which is success for an idempotent remove. */
const TASK_ABSENT = /cannot find|does not exist|the system cannot find/iu;

function createTaskAutostart(
  options: AutostartOptions,
  task: {
    name: string;
    cliArguments: readonly string[];
    registerErrorCode: string;
    removeErrorCode: string;
    label: string;
  },
): Autostart {
  const supported = options.platform === 'win32';
  // Quoted so the spaces in the node and CLI paths survive the scheduler's own
  // parse of the stored command.
  const taskCommand = [
    `"${options.nodeExecutable}"`,
    `"${options.cliEntry}"`,
    ...task.cliArguments,
  ].join(' ');

  const run = (args: readonly string[]): Promise<AutostartCommandResult> =>
    options.runCommand('schtasks', args);

  return {
    async enable() {
      if (!supported) return 'unsupported';
      // /F overwrites an existing task rather than failing, so enabling twice is a
      // successful no-op.
      const result = await run([
        '/Create',
        '/TN',
        task.name,
        '/TR',
        taskCommand,
        '/SC',
        'ONLOGON',
        '/F',
      ]);
      if (result.exitCode !== 0) {
        throw new ApplicationError(
          task.registerErrorCode,
          `Could not register the ${task.label} autostart task: ${result.stderr.trim() || `schtasks exited ${result.exitCode}`}`,
          500,
        );
      }
      return 'enabled';
    },

    async disable() {
      if (!supported) return 'unsupported';
      const result = await run(['/Delete', '/TN', task.name, '/F']);
      // A task that was never registered is already disabled, not a failure.
      if (result.exitCode !== 0 && !TASK_ABSENT.test(`${result.stderr}\n${result.stdout}`)) {
        throw new ApplicationError(
          task.removeErrorCode,
          `Could not remove the ${task.label} autostart task: ${result.stderr.trim() || `schtasks exited ${result.exitCode}`}`,
          500,
        );
      }
      return 'disabled';
    },

    async status() {
      if (!supported) return 'unsupported';
      const result = await run(['/Query', '/TN', task.name]);
      return result.exitCode === 0 ? 'enabled' : 'disabled';
    },
  };
}

export function createAutostart(options: AutostartOptions): Autostart {
  return createTaskAutostart(options, {
    name: AUTOSTART_TASK_NAME,
    cliArguments: ['start'],
    registerErrorCode: 'AUTOSTART_REGISTER_FAILED',
    removeErrorCode: 'AUTOSTART_REMOVE_FAILED',
    label: 'LUWI',
  });
}

export function createWakeAutostart(options: AutostartOptions): Autostart {
  return createTaskAutostart(options, {
    name: WAKE_AUTOSTART_TASK_NAME,
    cliArguments: ['wake', 'start'],
    registerErrorCode: 'WAKE_AUTOSTART_REGISTER_FAILED',
    removeErrorCode: 'WAKE_AUTOSTART_REMOVE_FAILED',
    label: 'LUWI wake dispatcher',
  });
}
