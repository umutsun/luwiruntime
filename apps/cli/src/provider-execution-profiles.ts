import {
  nativeBridgeExecutionProfileSchema,
  type AgentKind,
  type BridgeExecutionProfile,
  type BridgeProvider,
} from '@luwi/protocol';
import { realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathContains } from './agent-runner.js';

const PROMPT_SLOT = '__LUWI_SUPERVISED_MESSAGE_PROMPT__';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOOPBACK_HOST = '127.0.0.1';

export type ProviderProfileReason =
  | 'effective_config_invalid'
  | 'agent_definition_disabled'
  | 'provider_mismatch'
  | 'provider_unsupported'
  | 'executable_missing'
  | 'executable_unsafe'
  | 'working_directory_outside_root'
  | 'binding_invalid';

export type ProviderProfileRejection = {
  kind: 'rejected';
  reasonCode: ProviderProfileReason;
};

export type ProviderProfileAgentDefinition = {
  kind: AgentKind;
  enabled: boolean;
  executable?: string;
};

export type ProviderLaunchPlan = {
  kind: 'ready';
  provider: BridgeProvider;
  executionProfile: BridgeExecutionProfile;
  executable: string;
  args: readonly string[];
  promptIndex: number;
  workingDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  shell: false;
};

export type ResolveProviderExecutionProfileInput = {
  profile: unknown;
  definition: ProviderProfileAgentDefinition;
  registeredRoot: string;
  workingDirectory: string;
  sessionId: string;
  daemonUrl: string;
  environment: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
};

export type ProviderExecutionProfileDependencies = {
  canonicalizePath?: (value: string) => Promise<string>;
  nodeExecutable?: string;
  mcpServerEntry?: string;
};

const providerKinds: Record<BridgeProvider, AgentKind> = {
  codex: 'codex',
  'claude-code': 'claude-code',
  'gemini-cli': 'gemini-cli',
  antigravity: 'other',
};

/**
 * Arguments for the existing operator-driven native bridge. Supervised
 * profiles use the isolated binding below and never inherit this approval mode.
 */
export function codexMcpBindingArgs(sessionId: string, daemonUrl: string): string[] {
  return [
    '--approve-for-me',
    '--skip-git-repo-check',
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_SESSION_ID="${sessionId}"`,
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_DAEMON_URL="${daemonUrl}"`,
  ];
}

function rejection(reasonCode: ProviderProfileReason): ProviderProfileRejection {
  return { kind: 'rejected', reasonCode };
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 0x1f || point === 0x7f);
  });
}

function safeExecutable(executable: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(executable) || hasControlCharacter(executable)) return false;
  const base = path.basename(executable).toLowerCase();
  return platform === 'win32' ? base === 'codex.exe' : base === 'codex';
}

function safeNodeExecutable(executable: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(executable) || hasControlCharacter(executable)) return false;
  const base = path.basename(executable).toLowerCase();
  return platform === 'win32' ? base === 'node.exe' : base === 'node';
}

function safeMcpEntry(entry: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  return (
    path.isAbsolute(entry) && !hasControlCharacter(entry) && path.basename(entry) === 'main.js'
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function supervisedCodexBindingArgs(input: {
  sessionId: string;
  daemonUrl: string;
  nodeExecutable: string;
  mcpServerEntry: string;
}): string[] {
  return [
    '-c',
    `mcp_servers.luwi-runtime.command=${tomlString(input.nodeExecutable)}`,
    '-c',
    `mcp_servers.luwi-runtime.args=[${tomlString(input.mcpServerEntry)}]`,
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_SESSION_ID=${tomlString(input.sessionId)}`,
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_DAEMON_URL=${tomlString(input.daemonUrl)}`,
  ];
}

function safeDaemonUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === LOOPBACK_HOST &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === '' &&
      parsed.pathname === '/' &&
      parsed.search === ''
    );
  } catch {
    return false;
  }
}

/**
 * Resolve an already-effective profile into an immutable, no-shell launch plan.
 * The caller supplies canonical project paths and a resolved native executable.
 */
export async function resolveProviderExecutionProfile(
  input: ResolveProviderExecutionProfileInput,
  dependencies: ProviderExecutionProfileDependencies = {},
): Promise<ProviderLaunchPlan | ProviderProfileRejection> {
  const parsed = nativeBridgeExecutionProfileSchema.safeParse(input.profile);
  if (!parsed.success) return rejection('effective_config_invalid');
  if (!input.definition.enabled) return rejection('agent_definition_disabled');
  if (providerKinds[parsed.data.provider] !== input.definition.kind) {
    return rejection('provider_mismatch');
  }
  if (parsed.data.provider !== 'codex') return rejection('provider_unsupported');

  const executable = input.definition.executable;
  if (executable === undefined || executable.trim() === '') return rejection('executable_missing');
  const platform = input.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  if (!safeExecutable(executable, platform)) return rejection('executable_unsafe');
  if (
    !path.isAbsolute(input.registeredRoot) ||
    !path.isAbsolute(input.workingDirectory) ||
    !pathContains(input.registeredRoot, input.workingDirectory, platform)
  ) {
    return rejection('working_directory_outside_root');
  }
  if (!SAFE_ID.test(input.sessionId) || !safeDaemonUrl(input.daemonUrl)) {
    return rejection('binding_invalid');
  }

  const canonicalizePath = dependencies.canonicalizePath ?? realpath;
  let canonicalExecutable: string;
  let canonicalRoot: string;
  let canonicalWorkingDirectory: string;
  let canonicalNodeExecutable: string;
  let canonicalMcpServerEntry: string;
  try {
    [
      canonicalExecutable,
      canonicalRoot,
      canonicalWorkingDirectory,
      canonicalNodeExecutable,
      canonicalMcpServerEntry,
    ] = await Promise.all([
      canonicalizePath(executable),
      canonicalizePath(input.registeredRoot),
      canonicalizePath(input.workingDirectory),
      canonicalizePath(dependencies.nodeExecutable ?? process.execPath),
      canonicalizePath(
        dependencies.mcpServerEntry ??
          fileURLToPath(new URL('../../mcp-server/dist/main.js', import.meta.url)),
      ),
    ]);
  } catch {
    return rejection('executable_missing');
  }
  if (!safeExecutable(canonicalExecutable, platform)) return rejection('executable_unsafe');
  if (
    !pathContains(canonicalRoot, canonicalWorkingDirectory, platform) ||
    !path.isAbsolute(canonicalRoot) ||
    !path.isAbsolute(canonicalWorkingDirectory)
  ) {
    return rejection('working_directory_outside_root');
  }
  if (
    !safeNodeExecutable(canonicalNodeExecutable, platform) ||
    !safeMcpEntry(canonicalMcpServerEntry, platform)
  ) {
    return rejection('binding_invalid');
  }

  const args = [
    '-a',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--strict-config',
    '-c',
    'sandbox_permissions=[]',
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'sandbox_workspace_write.network_access=false',
    ...supervisedCodexBindingArgs({
      sessionId: input.sessionId,
      daemonUrl: input.daemonUrl,
      nodeExecutable: canonicalNodeExecutable,
      mcpServerEntry: canonicalMcpServerEntry,
    }),
    '--sandbox',
    parsed.data.executionProfile,
    '--color',
    'never',
    '-C',
    canonicalWorkingDirectory,
    PROMPT_SLOT,
  ];
  const promptIndex = args.indexOf(PROMPT_SLOT);
  const environment = Object.freeze({
    ...input.environment,
    LUWI_DAEMON_URL: input.daemonUrl,
    LUWI_SESSION_ID: input.sessionId,
  });

  return Object.freeze({
    kind: 'ready',
    provider: parsed.data.provider,
    executionProfile: parsed.data.executionProfile,
    executable: canonicalExecutable,
    args: Object.freeze(args),
    promptIndex,
    workingDirectory: canonicalWorkingDirectory,
    environment,
    shell: false,
  });
}

export function providerLaunchArguments(
  plan: ProviderLaunchPlan,
  prompt: string,
): readonly string[] {
  if (
    prompt.includes('\u0000') ||
    plan.promptIndex < 0 ||
    plan.promptIndex >= plan.args.length ||
    plan.args[plan.promptIndex] !== PROMPT_SLOT ||
    plan.args.filter((argument) => argument === PROMPT_SLOT).length !== 1
  ) {
    throw new TypeError('The supervised provider launch plan is invalid.');
  }
  const args = [...plan.args];
  args[plan.promptIndex] = prompt;
  return args;
}
