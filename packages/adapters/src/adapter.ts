import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  AdapterSupportLevel,
  AgentKind,
  ContextSource,
  DetectedAgentInstallation,
  EffectiveAgentConfiguration,
  NativeConfigInspection,
} from '@luwi/protocol';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type {
  AdapterCapabilityMatrix,
  AdapterContext,
  AgentAdapter,
  ImportedAgentConfiguration,
  NativeConfigPlan,
  NativeValidationResult,
  ProposedNativeFile,
} from './types.js';

type NativeFormat = 'json' | 'toml';

type AdapterDefinition = {
  id: string;
  kind: Exclude<AgentKind, 'other'>;
  executableName: string;
  globalFiles: Array<{ relativePath: string; format: NativeFormat }>;
  projectFiles: Array<{ relativePath: string; format: NativeFormat }>;
  globalContextFiles: string[];
  projectContextFiles: string[];
  renderSupport: AdapterSupportLevel;
  renderableSettingKeys: string[];
};

const definitions: Record<Exclude<AgentKind, 'other'>, AdapterDefinition> = {
  codex: {
    id: 'codex-native-v1',
    kind: 'codex',
    executableName: 'codex',
    globalFiles: [{ relativePath: '.codex/config.toml', format: 'toml' }],
    projectFiles: [{ relativePath: '.codex/config.toml', format: 'toml' }],
    globalContextFiles: ['.codex/AGENTS.md'],
    projectContextFiles: ['AGENTS.md'],
    renderSupport: 'full',
    renderableSettingKeys: ['approval_policy', 'model', 'sandbox_mode', 'sandbox_workspace_write'],
  },
  'claude-code': {
    id: 'claude-code-native-v1',
    kind: 'claude-code',
    executableName: 'claude',
    globalFiles: [{ relativePath: '.claude/settings.json', format: 'json' }],
    projectFiles: [
      { relativePath: '.claude/settings.json', format: 'json' },
      { relativePath: '.claude/settings.local.json', format: 'json' },
    ],
    globalContextFiles: ['.claude/CLAUDE.md'],
    projectContextFiles: ['CLAUDE.md'],
    renderSupport: 'full',
    renderableSettingKeys: ['model', 'permissions'],
  },
  'gemini-cli': {
    id: 'gemini-cli-native-v1',
    kind: 'gemini-cli',
    executableName: 'gemini',
    globalFiles: [{ relativePath: '.gemini/settings.json', format: 'json' }],
    projectFiles: [{ relativePath: '.gemini/settings.json', format: 'json' }],
    globalContextFiles: ['.gemini/GEMINI.md'],
    projectContextFiles: ['GEMINI.md'],
    renderSupport: 'read-only',
    renderableSettingKeys: [],
  },
  kimi: {
    id: 'kimi-native-v1',
    kind: 'kimi',
    executableName: 'kimi',
    globalFiles: [{ relativePath: '.kimi/config.toml', format: 'toml' }],
    projectFiles: [],
    globalContextFiles: [],
    projectContextFiles: ['AGENTS.md', '.kimi/AGENTS.md'],
    renderSupport: 'read-only',
    renderableSettingKeys: [],
  },
};

const secretFieldPattern =
  /(?:api[_-]?key|token|secret|password|credential|authorization|apiKeyHelper)$/i;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortObject(item)]),
    );
  }
  return value;
}

function secretPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => secretPaths(item, `${prefix}[${String(index)}]`));
  }
  const output: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (secretFieldPattern.test(key) || secretFieldPattern.test(path)) {
      output.push(path);
    } else {
      output.push(...secretPaths(item, path));
    }
  }
  return output.sort();
}

function withoutSecrets(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutSecrets(item, parentKey));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !secretFieldPattern.test(key) &&
          !(parentKey === 'env' && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)),
      )
      .map(([key, item]) => [key, withoutSecrets(item, key)]),
  );
}

function parseContent(format: NativeFormat, content: string): unknown {
  return format === 'json' ? JSON.parse(content) : parseToml(content);
}

function renderContent(format: NativeFormat, settings: Record<string, unknown>): string {
  const ordered = sortObject(settings) as Record<string, unknown>;
  return format === 'json' ? `${JSON.stringify(ordered, null, 2)}\n` : stringifyToml(ordered);
}

function nowIso(context: AdapterContext): string {
  return (context.now?.() ?? new Date()).toISOString();
}

function supportMatrix(
  kind: Exclude<AgentKind, 'other'>,
  render: AdapterSupportLevel,
): AdapterCapabilityMatrix {
  const readOnlyCapabilities = {
    skill: 'read-only',
    plugin: 'read-only',
    hook: 'read-only',
    mcp: 'read-only',
    policy: 'read-only',
    profile: 'read-only',
    instruction: 'read-only',
  } as const;
  return {
    detection: 'full',
    inspection: 'full',
    import: render === 'full' ? 'partial' : 'read-only',
    render,
    validation: render === 'full' ? 'full' : 'read-only',
    rollback: render === 'full' ? 'full' : 'unsupported',
    driftDetection: render === 'full' ? 'full' : 'read-only',
    capabilityKinds: {
      ...readOnlyCapabilities,
      ...(kind === 'codex' ? { plugin: 'unsupported' as const, hook: 'unsupported' as const } : {}),
      ...(kind === 'gemini-cli' ? { hook: 'unsupported' as const } : {}),
      ...(kind === 'kimi'
        ? {
            plugin: 'unsupported' as const,
            hook: 'unsupported' as const,
            policy: 'unsupported' as const,
          }
        : {}),
    },
    policyMode: 'informational-only',
    telemetry: {
      usage: 'unsupported',
      contextLoading: 'unsupported',
      sessionSummary: 'unsupported',
      supportedUsageFields: [],
    },
  };
}

class NativeAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly kind: AgentKind;

  constructor(private readonly definition: AdapterDefinition) {
    this.id = definition.id;
    this.kind = definition.kind;
  }

  async detectInstallations(context: AdapterContext): Promise<DetectedAgentInstallation[]> {
    const executable = await context.executableResolver.resolve(this.definition.executableName);
    if (executable === undefined) return [];
    const versionResult = await context.commandRunner
      .run(executable, ['--version'])
      .catch(() => undefined);
    if (versionResult === undefined) return [];
    if (versionResult.failure !== undefined || versionResult.exitCode !== 0) return [];
    const version = (versionResult.stdout.trim() || versionResult.stderr.trim()).slice(0, 200);
    if (version === '') return [];
    const configRoots = [
      ...new Set([
        ...this.definition.globalFiles.map((file) =>
          join(context.homeDirectory, file.relativePath),
        ),
        ...(context.projectDirectory === undefined
          ? []
          : this.definition.projectFiles.map((file) =>
              join(context.projectDirectory as string, file.relativePath),
            )),
      ]),
    ];
    return [
      {
        kind: this.kind,
        adapterId: this.id,
        executable,
        detectedVersion: version,
        configRoots,
        supportLevel: 'full',
        warnings: [],
      },
    ];
  }

  describeCapabilities(): AdapterCapabilityMatrix {
    return supportMatrix(this.definition.kind, this.definition.renderSupport);
  }

  async inspectGlobalConfig(context: AdapterContext): Promise<NativeConfigInspection> {
    return await this.inspectNativeConfiguration(
      context,
      context.homeDirectory,
      this.definition.globalFiles,
      this.definition.globalContextFiles,
      false,
    );
  }

  async inspectProjectConfig(context: AdapterContext): Promise<NativeConfigInspection> {
    if (context.projectDirectory === undefined) {
      return this.emptyInspection(context, ['No project directory was supplied.']);
    }
    return await this.inspectNativeConfiguration(
      context,
      context.projectDirectory,
      this.definition.projectFiles,
      this.definition.projectContextFiles,
      true,
    );
  }

  async importConfig(
    inspection: NativeConfigInspection,
    context: AdapterContext,
  ): Promise<ImportedAgentConfiguration> {
    const settings: Record<string, unknown> = {};
    const warnings = [...inspection.warnings];
    for (const file of inspection.files) {
      if (file.parseStatus !== 'parsed') continue;
      const content = await context.fileSystem.readFile(file.path);
      if (content === undefined) continue;
      const format: NativeFormat = file.path.endsWith('.json') ? 'json' : 'toml';
      const parsed = parseContent(format, content);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(settings, withoutSecrets(parsed));
      }
    }
    return {
      adapterId: this.id,
      settings: sortObject(settings) as Record<string, unknown>,
      sourcePaths: inspection.files.map((file) => file.canonicalPath).sort(),
      warnings,
    };
  }

  async createRenderPlan(
    input: EffectiveAgentConfiguration,
    context: AdapterContext,
  ): Promise<NativeConfigPlan> {
    if (this.definition.renderSupport !== 'full') {
      return {
        adapterId: this.id,
        files: [],
        warnings: ['Native rendering is read-only for this adapter in Phase 3.'],
      };
    }
    const projectScoped = input.projectId !== undefined && context.projectDirectory !== undefined;
    const definition = projectScoped
      ? this.definition.projectFiles[0]
      : this.definition.globalFiles[0];
    if (definition === undefined) {
      return {
        adapterId: this.id,
        files: [],
        warnings: ['No proven native configuration target is available.'],
      };
    }
    const root = projectScoped ? (context.projectDirectory as string) : context.homeDirectory;
    const renderedSettings = Object.fromEntries(
      Object.entries(input.settings).filter(([key]) =>
        this.definition.renderableSettingKeys.includes(key),
      ),
    );
    const unsupportedSettingKeys = Object.keys(input.settings)
      .filter((key) => !this.definition.renderableSettingKeys.includes(key))
      .sort();
    return {
      adapterId: this.id,
      files: [
        {
          path: join(root, definition.relativePath),
          content: renderContent(definition.format, renderedSettings),
          managementMode: 'managed-file',
          renderedSettingKeys: Object.keys(renderedSettings).sort(),
        },
      ],
      warnings:
        unsupportedSettingKeys.length === 0
          ? []
          : [
              `Unsupported effective settings were not rendered: ${unsupportedSettingKeys.join(', ')}`,
            ],
    };
  }

  async validateRenderedFiles(files: ProposedNativeFile[]): Promise<NativeValidationResult> {
    const errors: Array<{ path: string; message: string }> = [];
    for (const file of files) {
      try {
        parseContent(file.path.endsWith('.json') ? 'json' : 'toml', file.content);
      } catch {
        errors.push({
          path: file.path,
          message: 'The rendered native configuration is malformed.',
        });
      }
    }
    return { valid: errors.length === 0, errors };
  }

  private emptyInspection(context: AdapterContext, warnings: string[]): NativeConfigInspection {
    return {
      agentId: context.agentId ?? `${this.definition.kind}-detected`,
      ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
      adapterId: this.id,
      supportLevel: 'full',
      files: [],
      contextSources: [],
      warnings,
      inspectedAt: nowIso(context),
    };
  }

  private async inspectNativeConfiguration(
    context: AdapterContext,
    root: string,
    files: Array<{ relativePath: string; format: NativeFormat }>,
    contextFiles: string[],
    projectScoped: boolean,
  ): Promise<NativeConfigInspection> {
    const inspectedFiles: NativeConfigInspection['files'] = [];
    const warnings: string[] = [];
    for (const definition of files) {
      const path = join(root, definition.relativePath);
      const content = await context.fileSystem.readFile(path);
      if (content === undefined) continue;
      let parseStatus: 'parsed' | 'malformed' = 'parsed';
      let redactedFields: string[] = [];
      let unsupportedFields: string[] = [];
      try {
        const parsed = parseContent(definition.format, content);
        redactedFields = secretPaths(parsed);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          unsupportedFields = Object.keys(parsed)
            .filter((key) => !this.definition.renderableSettingKeys.includes(key))
            .sort();
        }
      } catch {
        parseStatus = 'malformed';
        warnings.push(`Malformed native configuration: ${path}`);
      }
      inspectedFiles.push({
        path,
        canonicalPath: await context.fileSystem.canonicalize(path),
        hash: sha256(content),
        sizeBytes: Buffer.byteLength(content),
        parseStatus,
        managementMode: 'observed',
        detectedCapabilityIds: [],
        unsupportedFields,
        warnings: [],
        redactedFields,
      });
    }

    const sources: ContextSource[] = [];
    for (const relativePath of contextFiles) {
      const path = join(root, relativePath);
      const content = await context.fileSystem.readFile(path);
      if (content === undefined) continue;
      const hash = sha256(content);
      const canonicalPath = await context.fileSystem.canonicalize(path);
      const sourceIdentity = sha256(
        `${context.agentId ?? `${this.definition.kind}-detected`}\0${
          projectScoped ? 'project' : 'global'
        }\0${canonicalPath}`,
      ).slice(0, 24);
      sources.push({
        id: `context:${this.definition.kind}:${sourceIdentity}`,
        ...(projectScoped && context.projectId !== undefined
          ? { projectId: context.projectId }
          : {}),
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        agentKind: this.kind,
        sourceType: 'instruction',
        path: canonicalPath,
        byteCount: Buffer.byteLength(content),
        lineCount: lineCount(content),
        hash,
        loadingScope: projectScoped ? 'project' : 'global',
        loadingMode: 'automatic',
        managementMode: 'observed',
        estimatedTokenCount: Math.ceil(Buffer.byteLength(content) / 4),
        estimationSource: 'estimated',
        estimationMethod: 'generic-character-estimate',
        measuredAt: nowIso(context),
      });
    }
    return {
      agentId: context.agentId ?? `${this.definition.kind}-detected`,
      ...(projectScoped && context.projectId !== undefined ? { projectId: context.projectId } : {}),
      adapterId: this.id,
      supportLevel: 'full',
      files: inspectedFiles,
      contextSources: sources,
      warnings,
      inspectedAt: nowIso(context),
    };
  }
}

export function createCodexAdapter(): AgentAdapter {
  return new NativeAgentAdapter(definitions.codex);
}

export function createClaudeCodeAdapter(): AgentAdapter {
  return new NativeAgentAdapter(definitions['claude-code']);
}

export function createGeminiCliAdapter(): AgentAdapter {
  return new NativeAgentAdapter(definitions['gemini-cli']);
}

export function createKimiAdapter(): AgentAdapter {
  return new NativeAgentAdapter(definitions.kimi);
}

export function createBuiltInAdapters(): AgentAdapter[] {
  return [
    createCodexAdapter(),
    createClaudeCodeAdapter(),
    createGeminiCliAdapter(),
    createKimiAdapter(),
  ];
}
