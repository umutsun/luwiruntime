import { describe, expect, it } from 'vitest';

import {
  providerLaunchArguments,
  resolveProviderExecutionProfile,
  type ProviderExecutionProfileDependencies,
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

const dependencies: ProviderExecutionProfileDependencies = {
  canonicalizePath: async (value) => value,
  nodeExecutable: 'C:/tools/node.exe',
  mcpServerEntry: 'C:/luwi/apps/mcp-server/dist/main.js',
};

describe('supervised provider execution profiles', () => {
  it.each(['read-only', 'workspace-write'] as const)(
    'builds an isolated no-shell Codex %s plan with one prompt slot',
    async (executionProfile) => {
      const result = await resolveProviderExecutionProfile(
        { ...input(), profile: { ...profile, executionProfile } },
        dependencies,
      );
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
        '-a',
        'never',
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '--strict-config',
        '-c',
        'sandbox_workspace_write.writable_roots=[]',
        '-c',
        'sandbox_workspace_write.network_access=false',
        '-c',
        'mcp_servers.luwi-runtime.command="C:/tools/node.exe"',
        '-c',
        'mcp_servers.luwi-runtime.args=["C:/luwi/apps/mcp-server/dist/main.js"]',
        '-c',
        'mcp_servers.luwi-runtime.enabled_tools=["luwi_respond_to_message"]',
        '-c',
        'mcp_servers.luwi-runtime.default_tools_approval_mode="prompt"',
        '-c',
        'mcp_servers.luwi-runtime.tools.luwi_respond_to_message.approval_mode="approve"',
        '-c',
        'mcp_servers.luwi-runtime.env.LUWI_SESSION_ID="session-1"',
        '-c',
        'mcp_servers.luwi-runtime.env.LUWI_DAEMON_URL="http://127.0.0.1:4782"',
        '--sandbox',
        executionProfile,
        '--color',
        'never',
        '-C',
        'C:/work/project/feature',
        '__LUWI_SUPERVISED_MESSAGE_PROMPT__',
      ]);
      expect(result.args).not.toContain('--approve-for-me');
      expect(result.args).not.toContain('sandbox_permissions=[]');
      expect(result.args.join('\n')).not.toContain('luwi_ask_agent');
      expect(result.args.join('\n')).not.toContain('luwi_acquire_lease');
      expect(result.args.join('\n')).not.toContain('luwi_continue_workflow');
      expect(providerLaunchArguments(result, 'Perform the bounded task.')).toEqual([
        ...result.args.slice(0, result.promptIndex),
        'Perform the bounded task.',
        ...result.args.slice(result.promptIndex + 1),
      ]);
      expect(result.args).not.toContain('Perform the bounded task.');
    },
  );

  it('rejects free arguments and unknown configuration fields', async () => {
    await expect(
      resolveProviderExecutionProfile(
        { ...input(), profile: { ...profile, additionalArgs: ['cmd.exe', '/c'] } },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'rejected', reasonCode: 'effective_config_invalid' });
  });

  it.each([
    ['claude-code', 'claude-code'],
    ['gemini-cli', 'gemini-cli'],
    ['antigravity', 'other'],
  ] as const)('keeps %s supervised execution unavailable', async (provider, kind) => {
    await expect(
      resolveProviderExecutionProfile(
        {
          ...input(),
          profile: { ...profile, provider },
          definition: { kind, enabled: true, executable: 'C:/tools/provider.exe' },
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'rejected', reasonCode: 'provider_unsupported' });
  });

  it('rejects disabled and mismatched definitions without exposing input values', async () => {
    await expect(
      resolveProviderExecutionProfile(
        {
          ...input(),
          definition: { kind: 'codex', enabled: false, executable: 'C:/secret/codex.exe' },
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'rejected', reasonCode: 'agent_definition_disabled' });
    await expect(
      resolveProviderExecutionProfile(
        {
          ...input(),
          definition: { kind: 'claude-code', enabled: true, executable: 'C:/secret/claude.exe' },
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'rejected', reasonCode: 'provider_mismatch' });
  });

  it.each([
    [undefined, 'executable_missing'],
    ['codex.cmd', 'executable_unsafe'],
    ['C:/tools/codex.cmd', 'executable_unsafe'],
    ['C:/Windows/System32/cmd.exe', 'executable_unsafe'],
    ['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'executable_unsafe'],
    ['C:/Program Files/Git/bin/bash.exe', 'executable_unsafe'],
    ['C:/tools/sh.exe', 'executable_unsafe'],
  ] as const)('rejects unsafe executable %s', async (executable, reasonCode) => {
    await expect(
      resolveProviderExecutionProfile(
        {
          ...input(),
          definition: {
            kind: 'codex',
            enabled: true,
            ...(executable === undefined ? {} : { executable }),
          },
        },
        dependencies,
      ),
    ).resolves.toEqual({ kind: 'rejected', reasonCode });
  });

  it('validates the canonical executable identity immediately before launch', async () => {
    await expect(
      resolveProviderExecutionProfile(input(), {
        ...dependencies,
        canonicalizePath: async (value) =>
          value === 'C:/tools/codex.exe' ? 'C:/Program Files/Git/bin/bash.exe' : value,
      }),
    ).resolves.toEqual({ kind: 'rejected', reasonCode: 'executable_unsafe' });
  });

  it.each(['C:/work/other', 'C:/work/project-escape'])(
    'rejects a working directory outside the registered root: %s',
    async (workingDirectory) => {
      await expect(
        resolveProviderExecutionProfile(input({ workingDirectory }), dependencies),
      ).resolves.toEqual({
        kind: 'rejected',
        reasonCode: 'working_directory_outside_root',
      });
    },
  );

  it('rejects a child path whose canonical target escapes through a junction', async () => {
    await expect(
      resolveProviderExecutionProfile(input(), {
        ...dependencies,
        canonicalizePath: async (value) =>
          value === 'C:/work/project/feature' ? 'C:/outside/feature' : value,
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      reasonCode: 'working_directory_outside_root',
    });
  });

  it.each([
    { sessionId: 'session"-injection' },
    { daemonUrl: 'http://localhost:4782' },
    { daemonUrl: 'http://127.0.0.1:4782/path' },
    { daemonUrl: 'https://127.0.0.1:4782' },
  ])('rejects an unsafe binding without echoing it', async (override) => {
    await expect(resolveProviderExecutionProfile(input(override), dependencies)).resolves.toEqual({
      kind: 'rejected',
      reasonCode: 'binding_invalid',
    });
  });

  it('rejects a corrupted prompt template before process invocation', async () => {
    const result = await resolveProviderExecutionProfile(input(), dependencies);
    if (result.kind !== 'ready') throw new Error('Expected a ready plan.');
    const corrupted = { ...result, args: result.args.slice(0, -1) };
    expect(() => providerLaunchArguments(corrupted, 'prompt')).toThrow(
      'The supervised provider launch plan is invalid.',
    );
  });
});
