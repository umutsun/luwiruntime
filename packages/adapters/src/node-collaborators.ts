import { access, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { spawn } from 'node:child_process';

import type { AntigravityFileSystem } from './antigravity-native.js';
import type {
  AdapterCommandResult,
  AdapterCommandRunner,
  AdapterExecutableResolver,
  AdapterFileSystem,
  TranscriptDirectoryEntry,
  TranscriptFileStat,
  TranscriptFileSystem,
} from './types.js';
import {
  NodeWindowsProcessTreeIo,
  WindowsOwnedProcessTreeCleaner,
  type WindowsProcessCleanupRequest,
} from './windows-process-cleanup.js';

export const NATIVE_VERSION_TIMEOUT_MS = 2_500;
export const NATIVE_VERSION_MAX_STDOUT_BYTES = 64 * 1024;
export const NATIVE_VERSION_MAX_STDERR_BYTES = 64 * 1024;
// Descendant discovery and two absence checks require bounded PowerShell startups on Windows.
const PROCESS_CLEANUP_TIMEOUT_MS = 5_000;
const unsafeCommandPathMetacharacter = /["%!]/u;

function hasUnsafeCommandPathCharacter(value: string): boolean {
  return (
    unsafeCommandPathMetacharacter.test(value) ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  );
}

export type TrustedWindowsUtilities = {
  systemDirectory?: string | undefined;
  cmdPath?: string | undefined;
  taskkillPath?: string | undefined;
  powershellPath?: string | undefined;
};

type WindowsUtilityFileSystem = {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
};

const nodeWindowsUtilityFileSystem: WindowsUtilityFileSystem = { realpath, stat };

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isContainedWindowsPath(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function canonicalDirectory(
  value: string | undefined,
  fileSystem: WindowsUtilityFileSystem,
): Promise<string | undefined> {
  if (value === undefined || !isAbsolute(value) || hasUnsafeCommandPathCharacter(value)) {
    return undefined;
  }
  try {
    const canonical = await fileSystem.realpath(value);
    return (await fileSystem.stat(canonical)).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalUtility(
  candidate: string,
  expectedBasename: string,
  trustedDirectory: string,
  fileSystem: WindowsUtilityFileSystem,
  requireDirectChild = true,
): Promise<string | undefined> {
  if (!isAbsolute(candidate) || hasUnsafeCommandPathCharacter(candidate)) return undefined;
  try {
    const canonical = await fileSystem.realpath(candidate);
    const info = await fileSystem.stat(canonical);
    if (
      !info.isFile() ||
      basename(canonical).toLowerCase() !== expectedBasename.toLowerCase() ||
      (requireDirectChild
        ? !sameWindowsPath(dirname(canonical), trustedDirectory)
        : !isContainedWindowsPath(trustedDirectory, canonical))
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

export async function resolveTrustedWindowsUtilities(
  environment: NodeJS.ProcessEnv = process.env,
  fileSystem: WindowsUtilityFileSystem = nodeWindowsUtilityFileSystem,
): Promise<TrustedWindowsUtilities> {
  let systemRoot: string | undefined;
  for (const candidate of [environment['SystemRoot'], environment['windir']]) {
    systemRoot = await canonicalDirectory(candidate, fileSystem);
    if (systemRoot !== undefined) break;
  }
  if (systemRoot === undefined) return {};
  const systemDirectory = await canonicalDirectory(join(systemRoot, 'System32'), fileSystem);
  if (systemDirectory === undefined || !isContainedWindowsPath(systemRoot, systemDirectory)) {
    return {};
  }
  const systemCmd = await canonicalUtility(
    join(systemDirectory, 'cmd.exe'),
    'cmd.exe',
    systemDirectory,
    fileSystem,
  );
  const configuredCmd =
    environment['ComSpec'] === undefined
      ? undefined
      : await canonicalUtility(environment['ComSpec'], 'cmd.exe', systemDirectory, fileSystem);
  const taskkillPath = await canonicalUtility(
    join(systemDirectory, 'taskkill.exe'),
    'taskkill.exe',
    systemDirectory,
    fileSystem,
  );
  const powershellPath = await canonicalUtility(
    join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    systemDirectory,
    fileSystem,
    false,
  );
  return {
    systemDirectory,
    cmdPath: configuredCmd ?? systemCmd,
    taskkillPath,
    powershellPath,
  };
}

const ignoreLateProcessError = (): void => undefined;

function killProcessSafely(
  target: { kill(signal?: number | NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
): void {
  try {
    target.kill(signal);
  } catch {
    // The probe already has a bounded failure result; cleanup must not escape or hang it.
  }
}

export type SpawnCommandRunnerOptions = {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  cleanupTimeoutMs?: number;
  /** Narrow process seam used by deterministic lifecycle tests. */
  spawnProcess?: typeof spawn;
  /** Narrow environment seam used by trusted Windows utility tests. */
  environment?: NodeJS.ProcessEnv;
  /** Prevalidated utility seam used only by deterministic lifecycle tests. */
  trustedWindowsUtilities?: TrustedWindowsUtilities;
  /** Narrow owned-tree cleanup seam used by deterministic lifecycle tests. */
  windowsProcessCleanup?: (request: WindowsProcessCleanupRequest) => Promise<boolean>;
};

export class NodeAdapterFileSystem implements AdapterFileSystem {
  async canonicalize(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'EACCES')
      ) {
        return undefined;
      }
      throw error;
    }
  }
}

function isMissingOrForbidden(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')
  );
}

/**
 * Real filesystem access for the transcript reader.
 *
 * Follows `NodeAdapterFileSystem`'s convention exactly: a missing or unreadable
 * path is `undefined`, and anything else rethrows. A developer's transcript tree
 * routinely contains directories the daemon may not read, and that is an absence
 * of evidence rather than a fault.
 */
export class NodeTranscriptFileSystem implements TranscriptFileSystem {
  async listDirectory(path: string): Promise<TranscriptDirectoryEntry[] | undefined> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch (error) {
      if (
        isMissingOrForbidden(error) ||
        (error instanceof Error && 'code' in error && error.code === 'ENOTDIR')
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async stat(path: string): Promise<TranscriptFileStat | undefined> {
    try {
      const stats = await stat(path);
      return {
        modifiedAtMs: stats.mtimeMs,
        sizeBytes: stats.size,
        // 0 where the filesystem keeps no birth time.
        ...(stats.birthtimeMs > 0 ? { createdAtMs: stats.birthtimeMs } : {}),
      };
    } catch (error) {
      if (isMissingOrForbidden(error)) return undefined;
      throw error;
    }
  }

  async readLines(
    path: string,
    maxBytes: number,
  ): Promise<{ lines: string[]; truncated: boolean } | undefined> {
    const read = await readWindow(path, maxBytes, false);
    // The final line of a byte-bounded read may be partial by construction.
    if (read?.truncated) read.lines.pop();
    return read;
  }

  async readTail(
    path: string,
    maxBytes: number,
  ): Promise<{ lines: string[]; truncated: boolean } | undefined> {
    const read = await readWindow(path, maxBytes, true);
    // A truncated tail carries the byte before its window: the first split
    // element is then either a partial line or '' (a line starting exactly at
    // the edge), and either way it is not a whole line.
    if (read?.truncated) read.lines.shift();
    return read;
  }
}

/**
 * Reads at most `maxBytes` from the start of a file, or from its end when
 * `fromEnd` — plus, when a tail window starts mid-file, the one byte before it.
 */
async function readWindow(
  path: string,
  maxBytes: number,
  fromEnd: boolean,
): Promise<{ lines: string[]; truncated: boolean } | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const stats = await file.stat();
    const start = fromEnd ? Math.max(0, stats.size - maxBytes - 1) : 0;
    const buffer = Buffer.alloc(fromEnd ? stats.size - start : Math.min(stats.size, maxBytes));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      lines: buffer.subarray(0, offset).toString('utf8').split('\n'),
      truncated: stats.size > maxBytes,
    };
  } catch (error) {
    if (isMissingOrForbidden(error)) return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

/**
 * Node byte read for the Antigravity summaries reader. The summaries file is a
 * binary protobuf, which `readLines`' utf8 decode would corrupt; a missing or
 * forbidden path is `undefined`, following the transcript convention.
 */
export class NodeAntigravityFileSystem implements AntigravityFileSystem {
  async readFileBytes(path: string, maxBytes: number): Promise<Uint8Array | undefined> {
    try {
      const buffer = await readFile(path);
      return buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
    } catch (error) {
      if (isMissingOrForbidden(error)) return undefined;
      throw error;
    }
  }
}

export class PathExecutableResolver implements AdapterExecutableResolver {
  constructor(
    private readonly environmentPath = process.env['PATH'] ?? '',
    private readonly platform = process.platform,
  ) {}

  async resolve(name: string): Promise<string | undefined> {
    const extensions =
      this.platform === 'win32'
        ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
        : [''];
    for (const directory of this.environmentPath.split(delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = `${directory}/${name}${extension}`;
        try {
          await access(candidate);
          return candidate;
        } catch {
          // Continue through the bounded PATH candidates.
        }
      }
    }
    return undefined;
  }
}

export class SpawnCommandRunner implements AdapterCommandRunner {
  readonly #timeoutMs: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;
  readonly #cleanupTimeoutMs: number;
  readonly #spawnProcess: typeof spawn;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #trustedWindowsUtilities: TrustedWindowsUtilities | undefined;
  readonly #windowsProcessCleanup: (request: WindowsProcessCleanupRequest) => Promise<boolean>;

  constructor(options: SpawnCommandRunnerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? NATIVE_VERSION_TIMEOUT_MS;
    this.#maxStdoutBytes = options.maxStdoutBytes ?? NATIVE_VERSION_MAX_STDOUT_BYTES;
    this.#maxStderrBytes = options.maxStderrBytes ?? NATIVE_VERSION_MAX_STDERR_BYTES;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? PROCESS_CLEANUP_TIMEOUT_MS;
    this.#spawnProcess = options.spawnProcess ?? spawn;
    this.#environment = options.environment ?? process.env;
    this.#trustedWindowsUtilities = options.trustedWindowsUtilities;
    const cleaner = new WindowsOwnedProcessTreeCleaner(
      new NodeWindowsProcessTreeIo(this.#spawnProcess),
    );
    this.#windowsProcessCleanup =
      options.windowsProcessCleanup ??
      (async (request) => (await cleaner.cleanup(request)).cleaned);
  }

  async run(executable: string, args: readonly string[]): Promise<AdapterCommandResult> {
    let command = executable;
    let commandArguments = [...args];
    let windowsVerbatimArguments = false;
    const extension = extname(executable).toLowerCase();
    let windowsUtilities: TrustedWindowsUtilities | undefined;
    if (process.platform === 'win32') {
      windowsUtilities =
        this.#trustedWindowsUtilities ?? (await resolveTrustedWindowsUtilities(this.#environment));
    }
    if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
      if (
        !isAbsolute(executable) ||
        hasUnsafeCommandPathCharacter(executable) ||
        args.length !== 1 ||
        args[0] !== '--version'
      ) {
        return { exitCode: 1, stdout: '', stderr: '', failure: 'spawn' };
      }
      if (windowsUtilities?.cmdPath === undefined) {
        return { exitCode: 1, stdout: '', stderr: '', failure: 'unavailable' };
      }
      command = windowsUtilities.cmdPath;
      commandArguments = ['/d', '/s', '/c', `""${executable}" --version"`];
      windowsVerbatimArguments = true;
    }
    let rootCanonicalExecutablePath: string | undefined;
    if (process.platform === 'win32') {
      if (this.#trustedWindowsUtilities !== undefined) {
        rootCanonicalExecutablePath = command;
      } else {
        try {
          rootCanonicalExecutablePath = await realpath(command);
          command = rootCanonicalExecutablePath;
        } catch {
          return { exitCode: 1, stdout: '', stderr: '', failure: 'spawn' };
        }
      }
    }
    const rootExecutableName = basename(command);
    const rootSpawnedAtMs = Date.now();
    return await new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = this.#spawnProcess(command, commandArguments, {
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        resolve({ exitCode: 1, stdout: '', stderr: '', failure: 'spawn' });
        return;
      }
      const rootObservedBeforeMs = Date.now();
      const rootParentPid = process.pid;
      if (child.stdout === null || child.stderr === null) {
        child.removeListener('error', ignoreLateProcessError);
        child.on('error', ignoreLateProcessError);
        killProcessSafely(child, 'SIGKILL');
        resolve({ exitCode: 1, stdout: '', stderr: '', failure: 'spawn' });
        return;
      }
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: AdapterCommandResult['failure'];
      let settled = false;
      const cleanupTimeoutMs = this.#cleanupTimeoutMs;
      const timeoutTimer = setTimeout(() => terminate('timeout'), this.#timeoutMs);
      timeoutTimer.unref();

      const onStdout = (chunk: Buffer): void => {
        stdoutBytes = collect(stdout, chunk, stdoutBytes, this.#maxStdoutBytes, 'stdout_limit');
      };
      const onStderr = (chunk: Buffer): void => {
        stderrBytes = collect(stderr, chunk, stderrBytes, this.#maxStderrBytes, 'stderr_limit');
      };
      const detach = (): void => {
        childStdout.removeListener('data', onStdout);
        childStderr.removeListener('data', onStderr);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        child.removeListener('error', ignoreLateProcessError);
        child.on('error', ignoreLateProcessError);
      };
      const settle = (result: AdapterCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        detach();
        stdout.length = 0;
        stderr.length = 0;
        resolve(result);
      };
      const failedResult = (): AdapterCommandResult => ({
        exitCode: 1,
        stdout: '',
        stderr: '',
        failure: failure ?? 'spawn',
      });
      const finishTermination = (): void => settle(failedResult());
      const finishCleanupFailure = (): void => {
        failure = 'cleanup';
        killProcessSafely(child, 'SIGKILL');
        settle(failedResult());
      };
      const terminate = (reason: NonNullable<AdapterCommandResult['failure']>): void => {
        if (settled || failure !== undefined) return;
        failure = reason;
        childStdout.removeListener('data', onStdout);
        childStderr.removeListener('data', onStderr);
        stdout.length = 0;
        stderr.length = 0;
        if (process.platform === 'win32' && child.pid !== undefined) {
          void this.#windowsProcessCleanup({
            rootPid: child.pid,
            rootParentPid,
            rootExecutableName,
            rootSpawnedAtMs,
            rootObservedBeforeMs,
            rootCanonicalExecutablePath,
            taskkillPath: windowsUtilities?.taskkillPath,
            powershellPath: windowsUtilities?.powershellPath,
            timeoutMs: cleanupTimeoutMs,
          })
            .then((cleaned) => {
              if (settled) return;
              if (cleaned) finishTermination();
              else finishCleanupFailure();
            })
            .catch(() => finishCleanupFailure());
        } else {
          killProcessSafely(child, 'SIGTERM');
        }
      };
      const collect = (
        target: Buffer[],
        chunk: Buffer,
        currentBytes: number,
        maximumBytes: number,
        reason: 'stdout_limit' | 'stderr_limit',
      ): number => {
        const nextBytes = currentBytes + chunk.byteLength;
        if (nextBytes > maximumBytes) {
          terminate(reason);
          return nextBytes;
        }
        target.push(chunk);
        return nextBytes;
      };
      const onError = (): void => {
        if (failure !== undefined) {
          child.removeListener('error', ignoreLateProcessError);
          child.on('error', ignoreLateProcessError);
          return;
        }
        failure = 'spawn';
        settle(failedResult());
      };
      const onClose = (exitCode: number | null): void => {
        if (failure !== undefined) {
          if (process.platform !== 'win32') finishTermination();
          return;
        }
        settle({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      };
      childStdout.on('data', onStdout);
      childStderr.on('data', onStderr);
      child.once('error', onError);
      child.once('close', onClose);
    });
  }
}
