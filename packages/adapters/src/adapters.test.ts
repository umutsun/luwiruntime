import { describe, expect, it, vi } from 'vitest';

import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  createGeminiCliAdapter,
  createKimiAdapter,
  type AdapterContext,
  type AdapterFileSystem,
} from './index.js';

class MemoryFileSystem implements AdapterFileSystem {
  readonly #files = new Map<string, string>();

  constructor(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      this.#files.set(path.replaceAll('\\', '/'), content);
    }
  }

  async canonicalize(path: string): Promise<string> {
    return path.replaceAll('\\', '/');
  }

  async readFile(path: string): Promise<string | undefined> {
    return this.#files.get(path.replaceAll('\\', '/'));
  }
}

function createContext(files: Record<string, string>): {
  context: AdapterContext;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async () => ({ exitCode: 0, stdout: '1.2.3\n', stderr: '' }));
  return {
    context: {
      homeDirectory: '/fake/home',
      projectDirectory: '/fake/project',
      fileSystem: new MemoryFileSystem(files),
      executableResolver: {
        resolve: vi.fn(async (name: string) => `/fake/bin/${name}`),
      },
      commandRunner: { run },
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    },
    run,
  };
}

describe('native coding-agent adapters', () => {
  it.each([
    [
      createCodexAdapter(),
      {
        '/fake/home/.codex/config.toml': 'model = "gpt-test"\napi_key = "secret"\n',
        '/fake/project/.codex/config.toml': 'approval_policy = "on-request"\n',
        '/fake/project/AGENTS.md': '# Instructions\n',
      },
      '.codex/config.toml',
    ],
    [
      createClaudeCodeAdapter(),
      {
        '/fake/home/.claude/settings.json':
          '{"model":"claude-test","env":{"ANTHROPIC_API_KEY":"secret"}}',
        '/fake/project/.claude/settings.json': '{"permissions":{"deny":["Read(.env)"]}}',
        '/fake/project/CLAUDE.md': '# Instructions\n',
      },
      '.claude/settings.json',
    ],
    [
      createGeminiCliAdapter(),
      {
        '/fake/home/.gemini/settings.json': '{"selectedAuthType":"oauth-personal"}',
        '/fake/project/.gemini/settings.json': '{"context":{"fileName":"GEMINI.md"}}',
        '/fake/project/GEMINI.md': '# Instructions\n',
      },
      '.gemini/settings.json',
    ],
    [
      createKimiAdapter(),
      {
        '/fake/home/.kimi/config.toml':
          '[providers.test]\napi_key = "secret"\nbase_url = "https://example.invalid"\n',
        '/fake/project/AGENTS.md': '# Instructions\n',
      },
      undefined,
    ],
  ])(
    'inspects %s without executing the CLI or discovered content',
    async (adapter, files, expectedPath) => {
      const { context, run } = createContext(files);

      const inspection = await adapter.inspectProjectConfig(context);

      if (expectedPath !== undefined) {
        expect(
          inspection.files.some((file) => file.path.replaceAll('\\', '/').includes(expectedPath)),
        ).toBe(true);
      } else {
        expect(inspection.files).toEqual([]);
      }
      expect(inspection.contextSources).toHaveLength(1);
      expect(inspection.contextSources[0]?.estimatedTokenCount).toBeGreaterThan(0);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('detects installations and reads versions only through injected collaborators', async () => {
    const { context, run } = createContext({});

    const installations = await createCodexAdapter().detectInstallations(context);

    expect(installations).toEqual([
      expect.objectContaining({
        kind: 'codex',
        executable: '/fake/bin/codex',
        detectedVersion: '1.2.3',
      }),
    ]);
    expect(run).toHaveBeenCalledWith('/fake/bin/codex', ['--version']);
  });

  it('keeps sibling detection available when a bounded command fails', async () => {
    const failed = createContext({});
    failed.context.commandRunner = {
      run: vi.fn(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: '',
        failure: 'timeout' as const,
      })),
    };
    const healthy = createContext({});

    const [failedInstallations, healthyInstallations] = await Promise.all([
      createCodexAdapter().detectInstallations(failed.context),
      createGeminiCliAdapter().detectInstallations(healthy.context),
    ]);

    expect(failedInstallations).toEqual([]);
    expect(healthyInstallations).toEqual([
      expect.objectContaining({ kind: 'gemini-cli', detectedVersion: '1.2.3' }),
    ]);
  });

  it('normalizes a rejected command-runner promise to an unavailable installation', async () => {
    const failed = createContext({});
    failed.context.commandRunner = {
      run: vi.fn(async () => await Promise.reject(new Error('spawn EINVAL'))),
    };

    await expect(createCodexAdapter().detectInstallations(failed.context)).resolves.toEqual([]);
  });

  it.each([
    [{ exitCode: 1, stdout: 'failed', stderr: '' }, 'non-zero exit'],
    [{ exitCode: 0, stdout: '   ', stderr: '\n' }, 'empty version output'],
  ])('normalizes %s to unavailable instead of an unversioned installation', async (result) => {
    const failed = createContext({});
    failed.context.commandRunner = { run: vi.fn(async () => result) };

    await expect(createCodexAdapter().detectInstallations(failed.context)).resolves.toEqual([]);
  });

  it('redacts secret-bearing field names from native inspection metadata', async () => {
    const { context } = createContext({
      '/fake/home/.claude/settings.json':
        '{"env":{"ANTHROPIC_API_KEY":"secret","SAFE_FLAG":"1"},"apiKeyHelper":"helper"}',
    });

    const inspection = await createClaudeCodeAdapter().inspectGlobalConfig(context);

    expect(inspection.files[0]?.redactedFields).toEqual(['apiKeyHelper', 'env.ANTHROPIC_API_KEY']);
    expect(inspection.files[0]?.unsupportedFields).toEqual(['apiKeyHelper', 'env']);
    expect(JSON.stringify(inspection)).not.toContain('secret');
  });

  it('uses a stable context-source identity when instruction content changes', async () => {
    const adapter = createCodexAdapter();
    const first = createContext({ '/fake/project/AGENTS.md': 'first\n' });
    const second = createContext({ '/fake/project/AGENTS.md': 'second\n' });

    const firstSource = (await adapter.inspectProjectConfig(first.context)).contextSources[0];
    const secondSource = (await adapter.inspectProjectConfig(second.context)).contextSources[0];

    expect(firstSource?.id).toBe(secondSource?.id);
    expect(firstSource?.hash).not.toBe(secondSource?.hash);
  });

  it('inspects the documented Kimi user config without inventing a project config path', async () => {
    const adapter = createKimiAdapter();
    const { context } = createContext({
      '/fake/home/.kimi/config.toml': 'default_model = "test"\napi_key = "secret"\n',
    });

    const globalInspection = await adapter.inspectGlobalConfig(context);
    const projectInspection = await adapter.inspectProjectConfig(context);

    expect(globalInspection.files[0]?.path.replaceAll('\\', '/')).toContain('.kimi/config.toml');
    expect(projectInspection.files).toEqual([]);
  });

  it('omits secret-bearing native values during import', async () => {
    const adapter = createClaudeCodeAdapter();
    const { context } = createContext({
      '/fake/home/.claude/settings.json':
        '{"model":"claude-test","env":{"ANTHROPIC_API_KEY":"secret","SAFE_FLAG":"1"}}',
    });
    const inspection = await adapter.inspectGlobalConfig(context);

    const imported = await adapter.importConfig(inspection, context);

    expect(imported.settings).toEqual({
      env: { SAFE_FLAG: '1' },
      model: 'claude-test',
    });
    expect(JSON.stringify(imported)).not.toContain('secret');
  });

  it.each([createCodexAdapter(), createClaudeCodeAdapter()])(
    'creates deterministic, validated render plans for writable adapters',
    async (adapter) => {
      const { context } = createContext({});
      const input = {
        projectId: 'project-1',
        agentId: `${adapter.id}-agent`,
        agentKind: adapter.kind,
        valid: true,
        capabilities: [],
        profileIds: [],
        settings: { model: 'fixture-model', nested: { unsupported: true } },
        provenance: [],
        conflicts: [],
        missingDependencies: [],
        unsupportedCapabilities: [],
        nativeCapabilitySupport: [],
        estimatedContextFootprint: {
          projectId: 'project-1',
          agentId: `${adapter.id}-agent`,
          source: 'estimated' as const,
          method: 'generic-character-estimate' as const,
          totalBytes: 0,
          totalLines: 0,
          estimatedTokens: 0,
          categories: {},
          exactDuplicateGroups: [],
          measuredAt: '2026-07-29T12:00:00.000Z',
        },
      };

      const first = await adapter.createRenderPlan(input, context);
      const second = await adapter.createRenderPlan(input, context);

      expect(first).toEqual(second);
      expect(first.files).toHaveLength(1);
      expect((await adapter.validateRenderedFiles(first.files)).valid).toBe(true);
      expect(first.files[0]?.content).toContain('fixture-model');
      expect(first.files[0]?.content).not.toContain('nested');
      expect(first.warnings).toEqual(['Unsupported effective settings were not rendered: nested']);
    },
  );

  it.each([createGeminiCliAdapter(), createKimiAdapter()])(
    'keeps unproven native writes disabled for %s',
    async (adapter) => {
      expect(adapter.describeCapabilities().render).toBe('read-only');
    },
  );

  it('reports explicit native capability and policy support without emulation', () => {
    expect(createCodexAdapter().describeCapabilities()).toMatchObject({
      capabilityKinds: {
        plugin: 'unsupported',
        hook: 'unsupported',
        mcp: 'read-only',
      },
      policyMode: 'informational-only',
    });
    expect(createClaudeCodeAdapter().describeCapabilities()).toMatchObject({
      capabilityKinds: { hook: 'read-only', plugin: 'read-only' },
      policyMode: 'informational-only',
    });
    for (const adapter of [
      createCodexAdapter(),
      createClaudeCodeAdapter(),
      createGeminiCliAdapter(),
      createKimiAdapter(),
    ]) {
      expect(adapter.describeCapabilities().telemetry).toEqual({
        usage: 'unsupported',
        contextLoading: 'unsupported',
        sessionSummary: 'unsupported',
        supportedUsageFields: [],
      });
    }
  });
});
