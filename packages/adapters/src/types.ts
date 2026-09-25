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

export type TranscriptDirectoryEntry = {
  name: string;
  isDirectory: boolean;
};

export type TranscriptFileStat = {
  /** Modification time in epoch milliseconds. */
  modifiedAtMs: number;
  sizeBytes: number;
};

/**
 * The narrow read surface a transcript scan needs.
 *
 * Deliberately separate from `AdapterFileSystem`: directory listing and stat are
 * useless to every existing adapter and to both daemon config services, and
 * widening the shared interface would make four unrelated call sites carry
 * operations they never invoke. Ingest has no offset read — a scan re-reads a
 * file whole, and correctness comes from ingest-side deduplication rather than
 * from remembering a byte position. `readTail` exists only for the subagent
 * listing (ADR 0038), whose state is decided by a file's last record.
 */
export interface TranscriptFileSystem {
  listDirectory(path: string): Promise<TranscriptDirectoryEntry[] | undefined>;
  stat(path: string): Promise<TranscriptFileStat | undefined>;
  readLines(
    path: string,
    maxBytes: number,
  ): Promise<{ lines: string[]; truncated: boolean } | undefined>;
  /** The last `maxBytes` of a file; a partial first line is dropped when truncated. */
  readTail(
    path: string,
    maxBytes: number,
  ): Promise<{ lines: string[]; truncated: boolean } | undefined>;
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

/**
 * One request's token usage, as observed in a native transcript.
 *
 * The unit is the request, never the record: one `requestId` spans several
 * records and summing per record over-counts by 1.88x. Carries counters and
 * identifiers only — no prompt or response text is ever emitted out of the
 * reader, let alone stored.
 */
export type TranscriptUsageObservation = {
  /** The in-record `sessionId`, which is the join key. The filename never is. */
  nativeSessionId: string;
  requestId: string;
  model?: string | undefined;
  /** The timestamp of the record that won the disagreement rule. */
  observedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

/**
 * One file-changing tool call, as observed in a native transcript.
 *
 * Carries the path and nothing else from the tool input: `Write.content` and
 * `Edit.new_string` are prose, and only the path is ever read out of them. The
 * join key is the in-record `sessionId`, exactly as for usage.
 */
export type TranscriptFileObservation = {
  nativeSessionId: string;
  /** An allowlisted mutating tool name: Edit, Write, MultiEdit, or NotebookEdit. */
  toolName: string;
  /** The absolute path the tool changed, from `file_path` or `notebook_path`. */
  absolutePath: string;
  /** The timestamp of the tool_use record — when the change was made. */
  observedAt: string;
};

export type TranscriptScanCursor = {
  modifiedAtMs: number;
  sizeBytes: number;
};

export type TranscriptScanResult = {
  observations: TranscriptUsageObservation[];
  /** File-change observations from the same pass — the second extraction (B2). */
  fileObservations: TranscriptFileObservation[];
  /** Per-file cursors, for skipping unchanged files on the next scan only. */
  cursors: Record<string, TranscriptScanCursor>;
  filesScanned: number;
  filesSkippedUnchanged: number;
  /** Lines that could not be parsed; a partial final line is normal. */
  malformedLines: number;
  /** Files whose remaining lines were skipped after the malformed-line cap. */
  filesStoppedMalformedCap: number;
  /** Files cut short by the byte cap, so a bound never reads as completeness. */
  truncatedFiles: number;
  /** Files not opened because the per-scan cap was reached. */
  filesSkippedOverCap: number;
  /** Allowlisted mutating tool calls with a successful, paired result. */
  fileChangesObserved: number;
  /** Mutating tool calls whose paired result never arrived (a cut-off turn). */
  skippedUnresolved: number;
  /** Path-carrying tool calls outside the mutating allowlist (e.g. Read). */
  skippedUnknownTool: number;
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
