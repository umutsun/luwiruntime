import {
  NodeWindowsProcessTreeIo,
  PathExecutableResolver,
  WindowsOwnedProcessTreeCleaner,
  resolveTrustedWindowsUtilities,
  type TrustedWindowsUtilities,
  type WindowsProcessCleanupRequest,
} from '@luwi/adapters';
import type { AgentKind } from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, posix, win32 } from 'node:path';

export type NativeAgentName = 'claude' | 'codex' | 'gemini' | 'antigravity';

export type NativeAgentProvider = {
  name: NativeAgentName;
  kind: AgentKind;
  executable: string;
};

const AGENT_PROVIDERS: Record<NativeAgentName, NativeAgentProvider> = {
  claude: { name: 'claude', kind: 'claude-code', executable: 'claude' },
  codex: { name: 'codex', kind: 'codex', executable: 'codex' },
  gemini: { name: 'gemini', kind: 'gemini-cli', executable: 'gemini' },
  // Google Antigravity's `agy` CLI (kind 'other'): Claude-Code-flavoured headless
  // (`--print`, `--dangerously-skip-permissions`) and it forwards LUWI_SESSION_ID
  // to its MCP subprocess, so it binds through antigravity-mcp-launch.mjs unchanged.
  antigravity: { name: 'antigravity', kind: 'other', executable: 'agy' },
};

export function agentProvider(value: string): NativeAgentProvider {
  if (value === 'claude' || value === 'codex' || value === 'gemini' || value === 'antigravity') {
    return AGENT_PROVIDERS[value];
  }
  throw new ApplicationError(
    'AGENT_PROVIDER_UNSUPPORTED',
    'Agent provider must be claude, codex, gemini, or antigravity.',
    400,
  );
}

export interface NativeAgentSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface NativeAgentReadableStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface NativeAgentChildProcess {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout?: NativeAgentReadableStream;
  readonly stderr?: NativeAgentReadableStream;
  kill(signal?: number | NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

type NativeAgentSpawnOptions = {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  shell: false;
  stdio: 'inherit' | ['ignore', 'pipe', 'pipe'];
  windowsHide: false;
  windowsVerbatimArguments: boolean;
};

type NativeAgentSpawn = (
  executable: string,
  args: readonly string[],
  options: NativeAgentSpawnOptions,
) => NativeAgentChildProcess;

export type NativeAgentProcessInput = {
  executable: string;
  args: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  signals: NativeAgentSignalSource;
  onDiagnostic?: (error: unknown) => void;
  /** When set, stdout/stderr are piped (not inherited) and every chunk is forwarded as UTF-8. */
  captureOutput?: (chunk: string) => void;
};

export type NativeAgentProcessResult = {
  exitCode: number;
  signal?: NodeJS.Signals;
};

export interface NativeAgentProcessRunner {
  run(input: NativeAgentProcessInput): Promise<NativeAgentProcessResult>;
}

export type NodeNativeAgentProcessRunnerOptions = {
  platform?: NodeJS.Platform;
  environment?: Readonly<Record<string, string | undefined>>;
  parentPid?: number;
  cleanupTimeoutMs?: number;
  shutdownGraceMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  resolveExecutable?: (name: string) => Promise<string | undefined>;
  canonicalizeExecutable?: (path: string) => Promise<string>;
  resolveWindowsUtilities?: () => Promise<TrustedWindowsUtilities>;
  windowsProcessCleanup?: (request: WindowsProcessCleanupRequest) => Promise<boolean>;
  spawnProcess?: NativeAgentSpawn;
};

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const unsafeCmdValue = /["%!]/u;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 0x1f || point === 0x7f);
  });
}

function safeCmdValue(value: string): boolean {
  return !unsafeCmdValue.test(value) && !hasControlCharacter(value);
}

function cmdCommandLine(executable: string, args: readonly string[]): string {
  if (!safeCmdValue(executable) || args.some((argument) => !safeCmdValue(argument))) {
    throw new ApplicationError(
      'AGENT_ARGUMENT_UNSAFE',
      'Windows command-shim arguments contain characters cmd.exe could expand.',
      400,
    );
  }
  const quoted = [executable, ...args].map((value) => `"${value}"`).join(' ');
  return `"${quoted}"`;
}

function signalExitCode(signal: NodeJS.Signals | null | undefined): number {
  switch (signal) {
    case 'SIGINT':
      return 130;
    case 'SIGTERM':
      return 143;
    case 'SIGKILL':
      return 137;
    default:
      return 1;
  }
}

function safeKill(child: NativeAgentChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The owned child may already have exited between observation and forwarding.
  }
}

export class NodeNativeAgentProcessRunner implements NativeAgentProcessRunner {
  readonly #platform: NodeJS.Platform;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #parentPid: number;
  readonly #cleanupTimeoutMs: number;
  readonly #shutdownGraceMs: number;
  readonly #now: () => number;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #resolveExecutable: (name: string) => Promise<string | undefined>;
  readonly #canonicalizeExecutable: (path: string) => Promise<string>;
  readonly #resolveWindowsUtilities: () => Promise<TrustedWindowsUtilities>;
  readonly #windowsProcessCleanup: (request: WindowsProcessCleanupRequest) => Promise<boolean>;
  readonly #spawnProcess: NativeAgentSpawn;

  constructor(options: NodeNativeAgentProcessRunnerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#environment = options.environment ?? process.env;
    this.#parentPid = options.parentPid ?? process.pid;
    this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.#now = options.now ?? Date.now;
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const resolver = new PathExecutableResolver(this.#environment['PATH'] ?? '', this.#platform);
    this.#resolveExecutable = options.resolveExecutable ?? ((name) => resolver.resolve(name));
    this.#canonicalizeExecutable = options.canonicalizeExecutable ?? realpath;
    this.#resolveWindowsUtilities =
      options.resolveWindowsUtilities ??
      (() => resolveTrustedWindowsUtilities(this.#environment as NodeJS.ProcessEnv));
    const cleaner = new WindowsOwnedProcessTreeCleaner(new NodeWindowsProcessTreeIo());
    this.#windowsProcessCleanup =
      options.windowsProcessCleanup ??
      (async (request) => (await cleaner.cleanup(request)).cleaned);
    this.#spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) =>
        spawn(executable, [...args], spawnOptions) as NativeAgentChildProcess);
  }

  async run(input: NativeAgentProcessInput): Promise<NativeAgentProcessResult> {
    const candidate = isAbsolute(input.executable)
      ? input.executable
      : await this.#resolveExecutable(input.executable);
    if (candidate === undefined) {
      throw new ApplicationError(
        'AGENT_EXECUTABLE_NOT_FOUND',
        'The native agent executable could not be resolved.',
        404,
      );
    }

    let canonicalExecutable: string;
    try {
      canonicalExecutable = await this.#canonicalizeExecutable(candidate);
    } catch {
      throw new ApplicationError(
        'AGENT_EXECUTABLE_NOT_FOUND',
        'The native agent executable could not be canonicalized.',
        404,
      );
    }

    const windowsUtilities =
      this.#platform === 'win32' ? await this.#resolveWindowsUtilities() : undefined;
    const extension = extname(canonicalExecutable).toLowerCase();
    const commandShim =
      this.#platform === 'win32' && (extension === '.cmd' || extension === '.bat');
    if (commandShim && windowsUtilities?.cmdPath === undefined) {
      throw new ApplicationError(
        'AGENT_WINDOWS_SHELL_UNAVAILABLE',
        'A trusted Windows command interpreter is unavailable.',
        503,
      );
    }

    const executable = commandShim ? windowsUtilities!.cmdPath! : canonicalExecutable;
    const args = commandShim
      ? ['/d', '/s', '/c', cmdCommandLine(canonicalExecutable, input.args)]
      : [...input.args];
    const rootExecutableName =
      this.#platform === 'win32'
        ? win32.basename(executable.replaceAll('/', '\\'))
        : posix.basename(executable);
    const rootCanonicalExecutablePath = executable;
    const rootSpawnedAtMs = this.#now();
    let child: NativeAgentChildProcess;
    try {
      child = this.#spawnProcess(executable, args, {
        cwd: input.workingDirectory,
        env: input.environment,
        shell: false,
        stdio: input.captureOutput === undefined ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        windowsVerbatimArguments: commandShim,
      });
    } catch {
      throw new ApplicationError('AGENT_SPAWN_FAILED', 'The native agent could not start.', 500);
    }
    if (input.captureOutput !== undefined) {
      const forward = (chunk: Buffer | string): void =>
        input.captureOutput?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      child.stdout?.on('data', forward);
      child.stderr?.on('data', forward);
    }
    const rootObservedBeforeMs = this.#now();

    let settled = false;
    let requestedSignal: NodeJS.Signals | undefined;
    let termination: Promise<void> | undefined;
    let resolveExitSeen: (() => void) | undefined;
    let rejectOutcome: ((error: Error) => void) | undefined;
    const exitSeen = new Promise<void>((resolve) => {
      resolveExitSeen = resolve;
    });
    const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        rejectOutcome = reject;
        const onError = (): void => {
          if (settled) return;
          settled = true;
          reject(
            new ApplicationError('AGENT_SPAWN_FAILED', 'The native agent could not start.', 500),
          );
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          resolveExitSeen?.();
          if (settled) return;
          settled = true;
          resolve({ code, signal });
        };
        child.once('error', onError);
        child.once('exit', onExit);
      },
    );

    const exitedWithin = async (milliseconds: number): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      return await Promise.race([
        exitSeen.then(() => true),
        this.#wait(milliseconds).then(() => false),
      ]);
    };

    const terminate = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
      if (this.#platform === 'win32' && child.pid !== undefined) {
        let cleaned: boolean;
        try {
          cleaned = await this.#windowsProcessCleanup({
            rootPid: child.pid,
            rootParentPid: this.#parentPid,
            rootExecutableName,
            rootSpawnedAtMs,
            rootObservedBeforeMs,
            rootCanonicalExecutablePath,
            taskkillPath: windowsUtilities?.taskkillPath,
            powershellPath: windowsUtilities?.powershellPath,
            timeoutMs: this.#cleanupTimeoutMs,
          });
        } catch {
          cleaned = false;
        }
        if (!cleaned) {
          input.onDiagnostic?.(
            new ApplicationError(
              'AGENT_CLEANUP_UNVERIFIED',
              'Owned Windows process-tree cleanup could not be verified.',
              500,
            ),
          );
          safeKill(child, 'SIGKILL');
        }
      } else {
        safeKill(child, signal);
      }

      if (await exitedWithin(this.#shutdownGraceMs)) return;
      safeKill(child, 'SIGKILL');
      if (await exitedWithin(this.#shutdownGraceMs)) return;
      if (!settled) {
        settled = true;
        rejectOutcome?.(
          new ApplicationError(
            'AGENT_CLEANUP_FAILED',
            'The owned native agent process did not exit after bounded cleanup.',
            500,
          ),
        );
      }
    };

    const onSignal = (signal: 'SIGINT' | 'SIGTERM') => (): void => {
      if (termination !== undefined) return;
      requestedSignal = signal;
      termination = terminate(signal);
    };
    const onSigint = onSignal('SIGINT');
    const onSigterm = onSignal('SIGTERM');
    input.signals.once('SIGINT', onSigint);
    input.signals.once('SIGTERM', onSigterm);

    try {
      const result = await outcome;
      await termination;
      const signal = result.signal ?? requestedSignal;
      return {
        exitCode: result.code ?? signalExitCode(signal),
        ...(signal === undefined ? {} : { signal }),
      };
    } finally {
      input.signals.off('SIGINT', onSigint);
      input.signals.off('SIGTERM', onSigterm);
    }
  }
}

export type AgentRunProject = { id: string; localPath: string };
export type AgentRunDefinition = {
  id: string;
  kind: AgentKind;
  enabled: boolean;
  executable?: string;
};
export type AgentRunBinding = { agentId: string; enabled: boolean };

export type AgentRunDiscoveryClient = {
  listProjects(): Promise<readonly AgentRunProject[]>;
  listAgents(): Promise<readonly AgentRunDefinition[]>;
  listProjectAgentBindings(projectId: string): Promise<readonly AgentRunBinding[]>;
};

export type ResolveAgentRunContextInput = {
  provider: NativeAgentProvider;
  workingDirectory: string;
  projectId?: string;
  agentId?: string;
  executable?: string;
  platform?: NodeJS.Platform;
  client: AgentRunDiscoveryClient;
};

export type AgentRunContext = {
  projectId: string;
  agentId: string;
  executable: string;
};

function pathContains(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relativePath = path.relative(normalizedRoot, normalizedCandidate);
  if (platform === 'win32') {
    const same = normalizedRoot.toLowerCase() === normalizedCandidate.toLowerCase();
    return same || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  }
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function projectDepth(path: string, platform: NodeJS.Platform): number {
  const separator = platform === 'win32' ? /[\\/]+/u : /\/+|\\+/u;
  return path.split(separator).filter(Boolean).length;
}

/**
 * The registered project that contains a working directory — the deepest one,
 * and exactly one. Shared with `session attach`, so an agent never has to be
 * told a project id the daemon can derive from where it is running.
 */
export async function resolveProject(
  input: {
    workingDirectory: string;
    projectId?: string;
    client: Pick<AgentRunDiscoveryClient, 'listProjects'>;
  },
  platform: NodeJS.Platform,
): Promise<string> {
  if (input.projectId !== undefined) return input.projectId;
  const candidates = (await input.client.listProjects())
    .filter((project) => pathContains(project.localPath, input.workingDirectory, platform))
    .sort(
      (left, right) =>
        projectDepth(right.localPath, platform) - projectDepth(left.localPath, platform),
    );
  const selected = candidates[0];
  if (
    selected === undefined ||
    (candidates[1] !== undefined &&
      projectDepth(candidates[1].localPath, platform) ===
        projectDepth(selected.localPath, platform))
  ) {
    throw new ApplicationError(
      'AGENT_PROJECT_UNRESOLVED',
      'The working directory does not identify exactly one registered LUWI project.',
      409,
    );
  }
  return selected.id;
}

export async function resolveAgentRunContext(
  input: ResolveAgentRunContextInput,
): Promise<AgentRunContext> {
  const platform = input.platform ?? process.platform;
  const projectId = await resolveProject(input, platform);
  if (input.agentId !== undefined) {
    return {
      projectId,
      agentId: input.agentId,
      executable: input.executable ?? input.provider.executable,
    };
  }

  const [agents, bindings] = await Promise.all([
    input.client.listAgents(),
    input.client.listProjectAgentBindings(projectId),
  ]);
  const enabledBoundIds = new Set(
    bindings.filter((binding) => binding.enabled).map((binding) => binding.agentId),
  );
  const matches = agents.filter(
    (agent) => agent.enabled && agent.kind === input.provider.kind && enabledBoundIds.has(agent.id),
  );
  if (matches.length !== 1) {
    throw new ApplicationError(
      'AGENT_BINDING_UNRESOLVED',
      'The project does not have exactly one enabled binding for this agent provider.',
      409,
    );
  }
  const selected = matches[0]!;
  return {
    projectId,
    agentId: selected.id,
    executable: input.executable ?? selected.executable ?? input.provider.executable,
  };
}
