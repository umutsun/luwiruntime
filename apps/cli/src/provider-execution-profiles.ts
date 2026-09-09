import {
  nativeBridgeExecutionProfileSchema,
  type AgentKind,
  type BridgeExecutionProfile,
  type BridgeProvider,
} from '@luwi/protocol';
import { posix, win32 } from 'node:path';

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

const providerKinds: Record<BridgeProvider, AgentKind> = {
  codex: 'codex',
  'claude-code': 'claude-code',
  'gemini-cli': 'gemini-cli',
  antigravity: 'other',
};

/**
 * Codex needs the LUWI binding injected into its MCP subprocess and automatic
 * approval for the bounded MCP response calls.
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
  if (
    ['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'bash'].includes(
      base,
    )
  ) {
    return false;
  }
  return !['.cmd', '.bat', '.ps1'].some((extension) => base.endsWith(extension));
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
export function resolveProviderExecutionProfile(
  input: ResolveProviderExecutionProfileInput,
): ProviderLaunchPlan | ProviderProfileRejection {
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

  const args = [
    'exec',
    ...codexMcpBindingArgs(input.sessionId, input.daemonUrl),
    '--strict-config',
    '--sandbox',
    parsed.data.executionProfile,
    '--color',
    'never',
    '-C',
    input.workingDirectory,
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
    executable,
    args: Object.freeze(args),
    promptIndex,
    workingDirectory: input.workingDirectory,
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
