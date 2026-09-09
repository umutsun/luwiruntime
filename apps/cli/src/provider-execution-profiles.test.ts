import { describe, expect, it } from 'vitest';

import {
  providerLaunchArguments,
  resolveProviderExecutionProfile,
  type ResolveProviderExecutionProfileInput,
} from './provider-execution-profiles.js';

const profile = {
  enabled: true,
  provider: 'codex',
  executionProfile: 'workspace-write',
};

function input(
  overrides: Partial<ResolveProviderExecutionProfileInput> = {},
): ResolveProviderExecutionProfileInput {
  return {
    profile,
    definition: { kind: 'codex', enabled: true, executable: 'C:/tools/codex.exe' },
    registeredRoot: 'C:/work/project',
    workingDirectory: 'C:/work/project/feature',
    sessionId: 'session-1',
    daemonUrl: 'http://127.0.0.1:4782',
    environment: {
      PATH: 'C:/tools',
      LUWI_SESSION_ID: 'hostile-session',
      LUWI_DAEMON_URL: 'http://attacker.invalid',
    },
    platform: 'win32',
    ...overrides,
  };
}

describe('supervised provider execution profiles', () => {
  it.each(['read-only', 'workspace-write'] as const)(
    'builds an immutable no-shell Codex %s plan with one prompt slot',
    (executionProfile) => {
      const result = resolveProviderExecutionProfile({
        ...input(),
        profile: { ...profile, executionProfile },
      });
      expect(result).toMatchObject({
        kind: 'ready',
        provider: 'codex',
        executionProfile,
        executable: 'C:/tools/codex.exe',
        workingDirectory: 'C:/work/project/feature',
        shell: false,
        environment: {
          PATH: 'C:/tools',
          LUWI_SESSION_ID: 'session-1',
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
        },
      });
      if (result.kind !== 'ready') throw new Error('Expected a ready plan.');
      expect(result.args).toEqual([
        'exec',
        '--approve-for-me',
        '--skip-git-repo-check',
        '-c',
        'mcp_servers.luwi-runtime.env.LUWI_SESSION_ID="session-1"',
        '-c',
        'mcp_servers.luwi-runtime.env.LUWI_DAEMON_URL="http://127.0.0.1:4782"',
        '--strict-config',
        '--sandbox',
        executionProfile,
        '--color',
        'never',
        '-C',
        'C:/work/project/feature',
        '__LUWI_SUPERVISED_MESSAGE_PROMPT__',
      ]);
      expect(providerLaunchArguments(result, 'Perform the bounded task.')).toEqual([
        ...result.args.slice(0, result.promptIndex),
        'Perform the bounded task.',
        ...result.args.slice(result.promptIndex + 1),
      ]);
      expect(result.args).not.toContain('Perform the bounded task.');
    },
  );

  it('rejects free arguments and unknown configuration fields', () => {
    expect(
      resolveProviderExecutionProfile({
        ...input(),
        profile: { ...profile, additionalArgs: ['cmd.exe', '/c'] },
      }),
    ).toEqual({ kind: 'rejected', reasonCode: 'effective_config_invalid' });
  });

  it.each([
    ['claude-code', 'claude-code'],
    ['gemini-cli', 'gemini-cli'],
    ['antigravity', 'other'],
  ] as const)('keeps %s supervised execution unavailable', (provider, kind) => {
    expect(
      resolveProviderExecutionProfile({
        ...input(),
        profile: { ...profile, provider },
        definition: { kind, enabled: true, executable: 'C:/tools/provider.exe' },
      }),
    ).toEqual({ kind: 'rejected', reasonCode: 'provider_unsupported' });
  });

  it('rejects disabled and mismatched definitions without exposing input values', () => {
    expect(
      resolveProviderExecutionProfile({
        ...input(),
        definition: { kind: 'codex', enabled: false, executable: 'C:/secret/codex.exe' },
      }),
    ).toEqual({ kind: 'rejected', reasonCode: 'agent_definition_disabled' });
    expect(
      resolveProviderExecutionProfile({
        ...input(),
        definition: { kind: 'claude-code', enabled: true, executable: 'C:/secret/claude.exe' },
      }),
    ).toEqual({ kind: 'rejected', reasonCode: 'provider_mismatch' });
  });

  it.each([
    [undefined, 'executable_missing'],
    ['codex.cmd', 'executable_unsafe'],
    ['C:/tools/codex.cmd', 'executable_unsafe'],
    ['C:/Windows/System32/cmd.exe', 'executable_unsafe'],
    ['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'executable_unsafe'],
  ] as const)('rejects unsafe executable %s', (executable, reasonCode) => {
    expect(
      resolveProviderExecutionProfile({
        ...input(),
        definition: {
          kind: 'codex',
          enabled: true,
          ...(executable === undefined ? {} : { executable }),
        },
      }),
    ).toEqual({ kind: 'rejected', reasonCode });
  });

  it.each(['C:/work/other', 'C:/work/project-escape'])(
    'rejects a working directory outside the registered root: %s',
    (workingDirectory) => {
      expect(resolveProviderExecutionProfile(input({ workingDirectory }))).toEqual({
        kind: 'rejected',
        reasonCode: 'working_directory_outside_root',
      });
    },
  );

  it.each([
    { sessionId: 'session"-injection' },
    { daemonUrl: 'http://localhost:4782' },
    { daemonUrl: 'http://127.0.0.1:4782/path' },
    { daemonUrl: 'https://127.0.0.1:4782' },
  ])('rejects an unsafe binding without echoing it', (override) => {
    expect(resolveProviderExecutionProfile(input(override))).toEqual({
      kind: 'rejected',
      reasonCode: 'binding_invalid',
    });
  });

  it('rejects a corrupted prompt template before process invocation', () => {
    const result = resolveProviderExecutionProfile(input());
    if (result.kind !== 'ready') throw new Error('Expected a ready plan.');
    const corrupted = { ...result, args: result.args.slice(0, -1) };
    expect(() => providerLaunchArguments(corrupted, 'prompt')).toThrow(
      'The supervised provider launch plan is invalid.',
    );
  });
});
