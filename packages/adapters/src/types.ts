import type {
  AdapterSupportLevel,
  AgentKind,
  CapabilityKind,
  DetectedAgentInstallation,
  EffectiveAgentConfiguration,
  NativeConfigInspection,
} from '@luwi/protocol';

export type AdapterCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  failure?: 'spawn' | 'timeout' | 'stdout_limit' | 'stderr_limit' | 'cleanup' | 'unavailable';
};

export interface AdapterFileSystem {
  canonicalize(path: string): Promise<string>;
  readFile(path: string): Promise<string | undefined>;
}

export interface AdapterExecutableResolver {
  resolve(name: string): Promise<string | undefined>;
}

export interface AdapterCommandRunner {
  run(executable: string, args: readonly string[]): Promise<AdapterCommandResult>;
}

export type AdapterContext = {
  homeDirectory: string;
  projectDirectory?: string;
  agentId?: string;
  projectId?: string;
  fileSystem: AdapterFileSystem;
  executableResolver: AdapterExecutableResolver;
  commandRunner: AdapterCommandRunner;
  now?: () => Date;
};

export type AdapterCapabilityMatrix = {
  detection: AdapterSupportLevel;
  inspection: AdapterSupportLevel;
  import: AdapterSupportLevel;
  render: AdapterSupportLevel;
  validation: AdapterSupportLevel;
  rollback: AdapterSupportLevel;
  driftDetection: AdapterSupportLevel;
  capabilityKinds: Record<CapabilityKind, AdapterSupportLevel>;
  policyMode: 'enforced-native' | 'rendered-instruction' | 'informational-only' | 'unsupported';
  telemetry: AdapterTelemetryCapabilities;
};

export type AdapterTelemetrySupport = 'exact' | 'reported' | 'estimated' | 'unsupported';

export type AdapterTelemetryCapabilities = {
  usage: AdapterTelemetrySupport;
  contextLoading: AdapterTelemetrySupport;
  sessionSummary: AdapterTelemetrySupport;
  supportedUsageFields: Array<
    | 'inputTokens'
    | 'outputTokens'
    | 'cachedInputTokens'
    | 'reasoningTokens'
    | 'totalTokens'
    | 'contextWindowTokens'
    | 'contextUsedTokens'
  >;
};

export type ImportedAgentConfiguration = {
  adapterId: string;
  settings: Record<string, unknown>;
  sourcePaths: string[];
  warnings: string[];
};

export type ProposedNativeFile = {
  path: string;
  content: string;
  managementMode: 'managed-fragment' | 'managed-file';
  renderedSettingKeys?: string[];
};

export type NativeConfigPlan = {
  adapterId: string;
  files: ProposedNativeFile[];
  warnings: string[];
};

export type NativeValidationResult = {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
};

export interface AgentAdapter {
  readonly id: string;
  readonly kind: AgentKind;

  detectInstallations(context: AdapterContext): Promise<DetectedAgentInstallation[]>;
  describeCapabilities(): AdapterCapabilityMatrix;
  inspectGlobalConfig(context: AdapterContext): Promise<NativeConfigInspection>;
  inspectProjectConfig(context: AdapterContext): Promise<NativeConfigInspection>;
  importConfig(
    inspection: NativeConfigInspection,
    context: AdapterContext,
  ): Promise<ImportedAgentConfiguration>;
  createRenderPlan(
    input: EffectiveAgentConfiguration,
    context: AdapterContext,
  ): Promise<NativeConfigPlan>;
  validateRenderedFiles(files: ProposedNativeFile[]): Promise<NativeValidationResult>;
}
