import {
  agentDefinitionCollectionSchema,
  agentKindSchema,
  agentMessageResponseSchema,
  evidenceTypeSchema,
  eventListResponseSchema,
  gitObservationSchema,
  heartbeatResponseSchema,
  inboxClaimResponseSchema,
  INBOX_MAX_CLAIM_LIMIT,
  leaseAcquireResponseSchema,
  leaseCollectionSchema,
  LUWI_RUNTIME_VERSION,
  messageCollectionResponseSchema,
  messageCreateResponseSchema,
  messageKindSchema,
  messageResponseSchema,
  messageStateSchema,
  MESSAGE_MAX_WAIT_MS,
  nativeDeclarationResponseSchema,
  nativeSessionRefSchema,
  projectCollectionResponseSchema,
  projectAgentBindingCollectionSchema,
  projectResponseSchema,
  publicErrorResponseSchema,
  realtimeEventMessageSchema,
  runtimeInfoResponseSchema,
  sessionCollectionResponseSchema,
  sessionResponseSchema,
  sessionStatusTargetSchema,
  workLeaseSchema,
  type AgentKind,
  type AgentMessage,
  type InboxEnvelope,
  type NativeSessionRef,
  type RealtimeEventMessage,
} from '@luwi/protocol';
import {
  ccdSessionsDir,
  findNativeSessionTitle,
  NodeTranscriptFileSystem,
  resolveNativeIdentity,
  resolveNativeIdentityFromDisk,
  type TranscriptFileSystem,
} from '@luwi/adapters';
import {
  ApplicationError,
  createProjectDiscoveryService,
  createSessionBootstrap,
  type ProjectCandidate,
  type ProjectDiscoveryPlan,
  type ProjectDiscoveryService,
  type SessionBootstrapChange,
} from '@luwi/runtime';
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { registerControlPlaneCli } from './control-plane-cli.js';
import {
  NodeNativeAgentProcessRunner,
  agentProvider,
  resolveAgentRunContext,
  type NativeAgentProcessRunner,
  resolveProject,
} from './agent-runner.js';
import type { BridgeDaemonClient } from './bridge-daemon.js';
import { createDeepSeekAcpFactory, type DeepSeekAcpFactoryOptions } from './deepseek-acp-client.js';
import {
  DeepSeekBridgeStartupCancelledError,
  createDeepSeekBridge,
  type DeepSeekBridgeDaemonClient,
} from './deepseek-bridge.js';
import {
  codexMcpBindingArgs,
  createNativeBridge,
  nativeHeadlessArguments,
  type NativeBridgeExecutor,
  type NativeBridgeRunResult,
} from './native-bridge.js';
import { registerIntelligenceCli } from './intelligence-cli.js';
import {
  createNodeLifecycleService,
  type DoctorReport,
  type LifecycleService,
  type LifecycleStatus,
  type RuntimeResetResult,
} from './lifecycle.js';
export type FetchInitLike = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type HttpResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export interface CliSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface CliWebSocket {
  readonly readyState: number;
  addEventListener(
    event: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ): void;
  close(code?: number, reason?: string): void;
}

export type CliDependencies = {
  fetch: (url: string, init?: FetchInitLike) => Promise<HttpResponseLike>;
  createWebSocket: (url: string) => CliWebSocket;
  signals: CliSignalSource;
  stdout: {
    write: (text: string) => unknown;
  };
  stderr: {
    write: (text: string) => unknown;
  };
  setInterval: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
  setTimeout: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout) => void;
  wait: (milliseconds: number) => Promise<void>;
  confirm: (prompt: string) => Promise<boolean>;
  createDeepSeekAcpFactory: (
    options: DeepSeekAcpFactoryOptions,
  ) => ReturnType<typeof createDeepSeekAcpFactory>;
  /**
   * The process environment, injected so `session attach` can resolve a native
   * identity without a test passing merely because it runs inside an agent
   * session.
   */
  environment: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  cwd: () => string;
  canonicalizePath: (path: string) => Promise<string>;
  /**
   * The read surface `session attach` uses to recover a vendor-native identity
   * that lives on disk (a Codex rollout tree; ADR 0028). Injected so a test does
   * not read the host's real sessions.
   */
  transcriptFileSystem: TranscriptFileSystem;
  /** The clock the disk identity resolver reads for its freshness window. */
  now: () => Date;
  agentProcessRunner: NativeAgentProcessRunner;
  setExitCode: (code: number) => void;
  lifecycle: LifecycleService;
  projectDiscovery: ProjectDiscoveryService;
};

const defaultConfirm = async (prompt: string): Promise<boolean> => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(`${prompt} [y/N] `)).trim().toLowerCase() === 'y';
  } finally {
    terminal.close();
  }
};

const defaultDependencies: CliDependencies = {
  fetch: (url, init) => fetch(url, init as RequestInit),
  createWebSocket: (url) => new WebSocket(url) as unknown as CliWebSocket,
  signals: process,
  environment: process.env,
  platform: process.platform,
  cwd: process.cwd,
  canonicalizePath: realpath,
  transcriptFileSystem: new NodeTranscriptFileSystem(),
  now: () => new Date(),
  agentProcessRunner: new NodeNativeAgentProcessRunner(),
  setExitCode: (code) => {
    process.exitCode = code;
  },
  stdout: process.stdout,
  stderr: process.stderr,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  confirm: defaultConfirm,
  lifecycle: createNodeLifecycleService({ confirm: defaultConfirm }),
  projectDiscovery: createProjectDiscoveryService(),
  createDeepSeekAcpFactory,
};

type Parser<Output> = { parse(value: unknown): Output };

/** How often `session attach` re-reads the desktop chat title. */
const TITLE_POLL_INTERVAL_MS = 15_000;

function baseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function endpoint(base: string, path: string): string {
  return new URL(path, `${baseUrl(base)}/`).toString();
}

async function request<Output>(
  dependencies: CliDependencies,
  base: string,
  path: string,
  parser: Parser<Output>,
  init?: FetchInitLike,
): Promise<Output> {
  const response = await dependencies.fetch(endpoint(base, path), init);
  const body = await response.json();
  if (!response.ok) {
    const parsed = publicErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      throw new ApplicationError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
        parsed.data.error.details,
      );
    }
    throw new ApplicationError(
      'DAEMON_REQUEST_FAILED',
      `Daemon request failed with status ${response.status}`,
      response.status,
    );
  }
  return parser.parse(body);
}

async function boundedRequest<Output>(
  dependencies: CliDependencies,
  base: string,
  path: string,
  parser: Parser<Output>,
  timeoutMs: number,
  init?: FetchInitLike,
): Promise<Output> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = dependencies.setTimeout(() => {
      controller.abort();
      reject(
        new ApplicationError(
          'DAEMON_REQUEST_TIMEOUT',
          'The LUWI daemon request exceeded its bounded timeout.',
          503,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      request(dependencies, base, path, parser, { ...init, signal: controller.signal }),
      timedOut,
    ]);
  } finally {
    if (timeout !== undefined) dependencies.clearTimeout(timeout);
  }
}

function loopbackDaemonUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApplicationError('CLI_OPTION_INVALID', '--url must be a valid loopback URL.', 400);
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (
    parsed.protocol !== 'http:' ||
    !loopback ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      '--url must be an HTTP loopback URL without credentials.',
      400,
    );
  }
  return baseUrl(value);
}

function positiveIntegerOption(
  value: string,
  option: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      `${option} must be an integer from ${minimum} through ${maximum}.`,
      400,
    );
  }
  return parsed;
}

// Client shapes a session can declare at attach, kept in step with the
// dashboard's own list. Free-form metadata, no protocol schema — a launcher hook
// stamps its kind so the dashboard tells a GUI/IDE attach from a CLI worker
// without guessing from a title.
const CLIENT_KINDS = ['cli', 'gui', 'ide', 'bridge'] as const;
function clientKindOption(value: string): (typeof CLIENT_KINDS)[number] {
  if ((CLIENT_KINDS as readonly string[]).includes(value)) {
    return value as (typeof CLIENT_KINDS)[number];
  }
  throw new ApplicationError(
    'CLI_OPTION_INVALID',
    `--client must be one of ${CLIENT_KINDS.join(', ')}.`,
    400,
  );
}

function safeErrorCode(error: unknown): string {
  return error instanceof ApplicationError ? error.code : 'DAEMON_UNAVAILABLE';
}

function printDoctor(dependencies: CliDependencies, report: DoctorReport, json: boolean): void {
  if (json) {
    printJson(dependencies, report);
    return;
  }
  for (const check of report.checks) {
    dependencies.stdout.write(`[${check.status}] ${check.id}: ${check.summary}\n`);
    if (check.hint !== undefined) dependencies.stdout.write(`  ${check.hint}\n`);
  }
  dependencies.stdout.write(`ready: ${report.ready ? 'yes' : 'no'}\n`);
}

function printLifecycleStatus(
  dependencies: CliDependencies,
  status: LifecycleStatus,
  json: boolean,
): void {
  if (json) {
    printJson(dependencies, status);
    return;
  }
  dependencies.stdout.write(
    `daemon: ${status.daemon.state} (${status.daemon.managed ? 'managed' : status.daemon.ownership})\n`,
  );
  dependencies.stdout.write(`redis: ${status.redis.state} (compose: ${status.redis.compose})\n`);
  dependencies.stdout.write(`endpoint: ${status.endpoints.daemon}\n`);
}

function printRuntimeResetResult(
  dependencies: CliDependencies,
  result: RuntimeResetResult,
  json: boolean,
): void {
  if (json) {
    printJson(dependencies, result);
    return;
  }
  dependencies.stdout.write(`namespace: ${result.namespace}\n`);
  dependencies.stdout.write(`matched: ${result.matched}\n`);
  dependencies.stdout.write(`deleted: ${result.deleted}\n`);
  dependencies.stdout.write(`status: ${result.status}\n`);
}

function printAgentDiagnostic(
  dependencies: CliDependencies,
  code: 'LUWI_OBSERVATION_DEGRADED' | 'LUWI_SESSION_RECOVERED' | 'AGENT_PROCESS_DIAGNOSTIC',
  error?: unknown,
): void {
  dependencies.stderr.write(
    `${JSON.stringify({
      code,
      ...(error === undefined ? {} : { cause: safeErrorCode(error) }),
    })}\n`,
  );
}

function jsonBody(value: unknown): FetchInitLike {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

function jsonBodyWithHeaders(value: unknown, headers: Record<string, string>): FetchInitLike {
  const init = jsonBody(value);
  return { ...init, headers: { ...init.headers, ...headers } };
}

function printJson(dependencies: CliDependencies, value: unknown): void {
  dependencies.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function appendOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseProjectNameMappings(
  values: readonly string[],
  platform: NodeJS.Platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const value of values) {
    const separator = value.indexOf('=');
    const directory = separator < 0 ? '' : value.slice(0, separator);
    const displayName = separator < 0 ? '' : value.slice(separator + 1).trim();
    const key = platform === 'win32' ? directory.toLowerCase() : directory;
    if (directory === '' || displayName === '' || seen.has(key)) {
      throw new ApplicationError(
        'CLI_OPTION_INVALID',
        '--name must use a unique exact directory=Display Name mapping.',
        400,
      );
    }
    seen.add(key);
    result[directory] = displayName;
  }
  return result;
}

type ProjectDiscoveryItemResult = {
  directoryName: string;
  projectId: string;
};

type ProjectDiscoveryFailure = {
  directoryName: string;
  code: string;
  message: string;
};

type ProjectDiscoveryGitResult = ProjectDiscoveryItemResult & {
  status: 'observed' | 'not_git' | 'failed';
};

function safeProjectDiscoveryFailure(
  candidate: ProjectCandidate,
  error: unknown,
): ProjectDiscoveryFailure {
  if (error instanceof ApplicationError) {
    return { directoryName: candidate.directoryName, code: error.code, message: error.message };
  }
  return {
    directoryName: candidate.directoryName,
    code: 'INTERNAL_ERROR',
    message: 'The project operation failed.',
  };
}

async function applyProjectDiscovery(
  dependencies: CliDependencies,
  url: string,
  plan: ProjectDiscoveryPlan,
): Promise<{
  mode: 'applied';
  plan: ProjectDiscoveryPlan;
  registered: ProjectDiscoveryItemResult[];
  unchanged: ProjectDiscoveryItemResult[];
  conflict: ProjectDiscoveryFailure[];
  failed: ProjectDiscoveryFailure[];
  git: ProjectDiscoveryGitResult[];
}> {
  const registered: ProjectDiscoveryItemResult[] = [];
  const unchanged: ProjectDiscoveryItemResult[] = [];
  const conflict: ProjectDiscoveryFailure[] = [];
  const failed: ProjectDiscoveryFailure[] = [];
  const observable: Array<{ candidate: ProjectCandidate; projectId: string }> = [];

  for (const candidate of plan.selected) {
    if (candidate.existingProjectId !== undefined) {
      unchanged.push({
        directoryName: candidate.directoryName,
        projectId: candidate.existingProjectId,
      });
      observable.push({ candidate, projectId: candidate.existingProjectId });
      continue;
    }
    try {
      const project = await request(
        dependencies,
        url,
        '/api/v1/projects',
        projectResponseSchema,
        jsonBody({ name: candidate.displayName, localPath: candidate.localPath }),
      );
      registered.push({ directoryName: candidate.directoryName, projectId: project.id });
      observable.push({ candidate, projectId: project.id });
    } catch (error) {
      const result = safeProjectDiscoveryFailure(candidate, error);
      if (error instanceof ApplicationError && error.statusCode === 409) conflict.push(result);
      else failed.push(result);
    }
  }

  const git: ProjectDiscoveryGitResult[] = [];
  for (const { candidate, projectId } of observable) {
    try {
      await request(
        dependencies,
        url,
        `/api/v1/projects/${encodeURIComponent(projectId)}/git/scan`,
        gitObservationSchema,
        jsonBody({}),
      );
      git.push({
        directoryName: candidate.directoryName,
        projectId,
        status: 'observed',
      });
    } catch (error) {
      git.push({
        directoryName: candidate.directoryName,
        projectId,
        status:
          error instanceof ApplicationError && error.statusCode === 404 ? 'not_git' : 'failed',
      });
    }
  }

  return { mode: 'applied', plan, registered, unchanged, conflict, failed, git };
}

function parseJsonObject(value: string, option: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApplicationError('CLI_OPTION_INVALID', `${option} must be a JSON object.`, 400);
  }
}

function parseJsonArray(value: string, option: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('not an array');
    }
    return parsed;
  } catch {
    throw new ApplicationError('CLI_OPTION_INVALID', `${option} must be a JSON array.`, 400);
  }
}

function parseStringArray(value: string, option: string): string[] {
  const parsed = parseJsonArray(value, option);
  if (!parsed.every((item) => typeof item === 'string')) {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      `${option} must be a JSON array of strings.`,
      400,
    );
  }
  return parsed;
}

/**
 * The optional native reference for `session register` and `session simulate`
 * (B0). Adapter and session id only mean anything together, so a half-supplied
 * pair is refused before any request leaves the process.
 */
function parseNativeRef(options: {
  nativeAdapter?: string;
  nativeSession?: string;
  nativeSubagent?: string;
}): NativeSessionRef | undefined {
  if (options.nativeAdapter === undefined && options.nativeSession === undefined) {
    if (options.nativeSubagent !== undefined) {
      throw new ApplicationError(
        'CLI_OPTION_INVALID',
        '--native-subagent requires --native-adapter and --native-session.',
        400,
      );
    }
    return undefined;
  }
  if (options.nativeAdapter === undefined || options.nativeSession === undefined) {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      '--native-adapter and --native-session must be supplied together.',
      400,
    );
  }
  return nativeSessionRefSchema.parse({
    adapterId: options.nativeAdapter,
    nativeSessionId: options.nativeSession,
    ...(options.nativeSubagent === undefined ? {} : { nativeSubagentId: options.nativeSubagent }),
  });
}

function parseEvidenceRequirements(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return value.split(',').map((item) => evidenceTypeSchema.parse(item.trim()));
}

async function runSimulation(
  dependencies: CliDependencies,
  options: {
    url: string;
    project: string;
    agent: string;
    workingDirectory: string;
    heartbeatMs: number;
    status?: string;
    ungraceful?: boolean;
    native?: NativeSessionRef;
  },
): Promise<void> {
  const registered = await request(
    dependencies,
    options.url,
    '/api/v1/sessions',
    sessionResponseSchema,
    jsonBody({
      projectId: options.project,
      agentId: options.agent,
      workingDirectory: options.workingDirectory,
      metadata: { simulation: true },
      ...(options.native === undefined ? {} : { native: options.native }),
    }),
  );
  printJson(dependencies, registered);
  if (options.status !== undefined) {
    const status = sessionStatusTargetSchema.parse(options.status);
    await request(
      dependencies,
      options.url,
      `/api/v1/sessions/${registered.id}/status`,
      sessionResponseSchema,
      jsonBody({ status }),
    );
  }

  let finishing = false;
  let timer: NodeJS.Timeout;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      dependencies.clearInterval(timer);
      dependencies.signals.off('SIGINT', onSignal);
      dependencies.signals.off('SIGTERM', onSignal);
    };
    const finish = async (): Promise<void> => {
      if (finishing) {
        return;
      }
      finishing = true;
      cleanup();
      try {
        if (options.ungraceful !== true) {
          const closed = await request(
            dependencies,
            options.url,
            `/api/v1/sessions/${registered.id}/close`,
            sessionResponseSchema,
            jsonBody({}),
          );
          printJson(dependencies, closed);
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const onSignal = (): void => {
      void finish();
    };
    timer = dependencies.setInterval(() => {
      void request(
        dependencies,
        options.url,
        `/api/v1/sessions/${registered.id}/heartbeat`,
        heartbeatResponseSchema,
        jsonBody({ metadata: { simulation: true } }),
      ).catch((error) => {
        if (!finishing) {
          finishing = true;
          cleanup();
          reject(error);
        }
      });
    }, options.heartbeatMs);
    dependencies.signals.once('SIGINT', onSignal);
    dependencies.signals.once('SIGTERM', onSignal);
  });
}

type InboxRequest = Extract<InboxEnvelope, { itemKind: 'request' }>;

function printableInboxItem(item: InboxEnvelope, includeContent: boolean): unknown {
  if (includeContent) {
    return item;
  }
  const identity = {
    streamId: item.streamId,
    itemKind: item.itemKind,
    messageId: item.messageId,
    correlationId: item.correlationId,
    sourceSessionId: item.sourceSessionId,
    targetSessionId: item.targetSessionId,
    createdAt: item.createdAt,
  };
  if (item.itemKind === 'request') {
    return {
      ...identity,
      payload: {
        kind: item.payload.kind,
        ...(item.payload.subject === undefined ? {} : { subject: item.payload.subject }),
        contentBytes: Buffer.byteLength(item.payload.content, 'utf8'),
        evidenceRequirements: item.payload.evidenceRequirements,
        deadlineAt: item.payload.deadlineAt,
        redacted: true,
      },
    };
  }
  return {
    ...identity,
    payload: {
      state: item.payload.state,
      hasResponse: item.payload.response !== undefined,
      redacted: true,
    },
  };
}

async function transitionBridgeMessage(
  dependencies: CliDependencies,
  base: string,
  action: 'acknowledge' | 'processing',
  sessionId: string,
  correlationId: string,
): Promise<AgentMessage> {
  return request(
    dependencies,
    base,
    `/api/v1/messages/${encodeURIComponent(correlationId)}/${action}`,
    messageResponseSchema,
    jsonBody({ responderSessionId: sessionId }),
  );
}

async function prepareBridgeMessage(
  dependencies: CliDependencies,
  options: {
    url: string;
    sessionId: string;
  },
  correlationId: string,
): Promise<boolean> {
  const current = await request(
    dependencies,
    options.url,
    `/api/v1/messages/${encodeURIComponent(correlationId)}`,
    messageResponseSchema,
  );
  let state = current.state;
  if (state === 'delivered') {
    state = (
      await transitionBridgeMessage(
        dependencies,
        options.url,
        'acknowledge',
        options.sessionId,
        correlationId,
      )
    ).state;
  }
  if (state === 'acknowledged') {
    state = (
      await transitionBridgeMessage(
        dependencies,
        options.url,
        'processing',
        options.sessionId,
        correlationId,
      )
    ).state;
  }
  return state === 'processing';
}

async function automaticBridgeResponse(
  dependencies: CliDependencies,
  options: {
    url: string;
    sessionId: string;
    mode: 'echo' | 'status-responder';
  },
  item: InboxRequest,
): Promise<void> {
  let answer: string;
  let evidence: unknown[] = [];
  if (options.mode === 'echo') {
    answer = `[simulated echo] ${item.payload.content}`;
  } else {
    const message = await request(
      dependencies,
      options.url,
      `/api/v1/messages/${encodeURIComponent(item.correlationId)}`,
      messageResponseSchema,
    );
    const snapshot = await request(
      dependencies,
      options.url,
      `/api/v1/projects/${encodeURIComponent(message.projectId)}/sessions`,
      sessionCollectionResponseSchema,
    );
    const online = snapshot.sessions.filter(({ presence }) => presence === 'online').length;
    answer = `[simulated status-responder] LUWI reports ${online} online session(s) in project ${message.projectId}.`;
    evidence = [
      {
        type: 'session_state',
        summary: 'Simulated status responder snapshot read from LUWI daemon APIs.',
        observedAt: new Date().toISOString(),
        metadata: {
          simulated: true,
          projectId: message.projectId,
          sessionCount: snapshot.sessions.length,
          onlineSessionCount: online,
        },
      },
    ];
  }
  const response = agentMessageResponseSchema.parse({
    status: 'answered',
    answer,
    evidence,
    verifiedAt: new Date().toISOString(),
  });
  await request(
    dependencies,
    options.url,
    `/api/v1/messages/${encodeURIComponent(item.correlationId)}/respond`,
    messageResponseSchema,
    jsonBody({ responderSessionId: options.sessionId, response }),
  );
}

async function runBridgeSimulation(
  dependencies: CliDependencies,
  options: {
    url: string;
    sessionId: string;
    bridgeInstanceId: string;
    mode: 'manual' | 'echo' | 'status-responder';
    limit: number;
    blockMs: number;
    minIdleMs: number;
    heartbeatMs: number;
    includeContent: boolean;
  },
): Promise<void> {
  let stopped = false;
  let heartbeatFailed = false;
  const handled = new Set<string>();
  const stop = (): void => {
    stopped = true;
  };
  dependencies.signals.once('SIGINT', stop);
  dependencies.signals.once('SIGTERM', stop);
  const heartbeatTimer = dependencies.setInterval(() => {
    void request(
      dependencies,
      options.url,
      `/api/v1/sessions/${encodeURIComponent(options.sessionId)}/heartbeat`,
      heartbeatResponseSchema,
      jsonBody({}),
    ).catch(() => {
      heartbeatFailed = true;
      stopped = true;
      dependencies.stderr.write(
        `${JSON.stringify({
          error: {
            code: 'BRIDGE_HEARTBEAT_FAILED',
            message: 'The simulated bridge heartbeat failed.',
          },
        })}\n`,
      );
    });
  }, options.heartbeatMs);
  try {
    while (!stopped) {
      const claimed = await request(
        dependencies,
        options.url,
        `/api/v1/sessions/${encodeURIComponent(options.sessionId)}/inbox/claim`,
        inboxClaimResponseSchema,
        jsonBody({
          bridgeInstanceId: options.bridgeInstanceId,
          limit: options.limit,
          blockMs: options.blockMs,
          minIdleMs: options.minIdleMs,
        }),
      );
      for (const item of claimed.items) {
        printJson(dependencies, {
          simulation: true,
          inboxItem: printableInboxItem(item, options.includeContent),
        });
        if (item.itemKind !== 'request' || handled.has(item.correlationId)) {
          continue;
        }
        const processing = await prepareBridgeMessage(
          dependencies,
          {
            url: options.url,
            sessionId: options.sessionId,
          },
          item.correlationId,
        );
        if (!processing) {
          handled.add(item.correlationId);
          continue;
        }
        if (options.mode === 'manual') {
          handled.add(item.correlationId);
          continue;
        }
        await automaticBridgeResponse(
          dependencies,
          {
            url: options.url,
            sessionId: options.sessionId,
            mode: options.mode,
          },
          item,
        );
        handled.add(item.correlationId);
      }
      if (claimed.items.length === 0 && options.blockMs === 0 && !stopped) {
        await dependencies.wait(100);
      }
    }
  } finally {
    dependencies.clearInterval(heartbeatTimer);
    dependencies.signals.off('SIGINT', stop);
    dependencies.signals.off('SIGTERM', stop);
  }
  if (heartbeatFailed) {
    throw new ApplicationError(
      'BRIDGE_HEARTBEAT_FAILED',
      'The simulated bridge heartbeat failed.',
      503,
    );
  }
}

function parseBridgeInteger(
  value: string,
  option: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      `${option} must be an integer from ${minimum} through ${maximum}.`,
      400,
    );
  }
  return parsed;
}

function exactLoopbackUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApplicationError('CLI_OPTION_INVALID', '--url must be a valid URL.', 400);
  }
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '[::1]') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      'The DeepSeek bridge --url must be an exact loopback HTTP origin.',
      400,
    );
  }
  return parsed.origin;
}

/**
 * The loopback daemon surface every CLI bridge drives (ADR 0025, ADR 0031). Message
 * claims long-poll for up to 30 s, so these are deliberately unbounded `request`s, not
 * the 2 s bounded ones the session bootstrap uses for register/heartbeat/close.
 */
function createBridgeDaemonClient(
  dependencies: CliDependencies,
  daemonUrl: string,
): BridgeDaemonClient {
  return {
    registerSession: async (input) =>
      request(dependencies, daemonUrl, '/api/v1/sessions', sessionResponseSchema, jsonBody(input)),
    heartbeatSession: async (sessionId) => {
      await request(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        heartbeatResponseSchema,
        jsonBody({}),
      );
    },
    setSessionStatus: async (sessionId, status) => {
      await request(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`,
        sessionResponseSchema,
        jsonBody({ status }),
      );
    },
    closeSession: async (sessionId) => {
      await request(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
        sessionResponseSchema,
        jsonBody({}),
      );
    },
    claimInbox: async (sessionId, input) =>
      request(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/inbox/claim`,
        inboxClaimResponseSchema,
        jsonBody(input),
      ),
    getMessage: async (correlationId) =>
      request(
        dependencies,
        daemonUrl,
        `/api/v1/messages/${encodeURIComponent(correlationId)}`,
        messageResponseSchema,
      ),
    listLeases: async (projectId) =>
      request(
        dependencies,
        daemonUrl,
        `/api/v1/leases?projectId=${encodeURIComponent(projectId)}&limit=200`,
        leaseCollectionSchema,
      ),
    transitionMessage: async (action, sessionId, correlationId) =>
      request(
        dependencies,
        daemonUrl,
        `/api/v1/messages/${encodeURIComponent(correlationId)}/${action}`,
        messageResponseSchema,
        jsonBody({ responderSessionId: sessionId }),
      ),
    completeMessage: async (action, sessionId, correlationId, response) =>
      request(
        dependencies,
        daemonUrl,
        `/api/v1/messages/${encodeURIComponent(correlationId)}/${action}`,
        messageResponseSchema,
        jsonBody({ responderSessionId: sessionId, response }),
      ),
  };
}

async function runDeepSeekBridge(
  dependencies: CliDependencies,
  options: {
    url: string;
    project: string;
    agent: string;
    workingDirectory: string;
    bridgeInstance: string;
    command: string;
    argsJson: string;
    permission: string;
    limit: string;
    blockMs: string;
    minIdleMs: string;
    heartbeatMs: string;
    closeGraceMs: string;
  },
): Promise<void> {
  if (!isAbsolute(options.workingDirectory)) {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      '--working-directory must be absolute for ACP.',
      400,
    );
  }
  if (options.permission !== 'reject' && options.permission !== 'allow-once') {
    throw new ApplicationError(
      'CLI_OPTION_INVALID',
      '--permission must be reject or allow-once.',
      400,
    );
  }
  const daemonUrl = exactLoopbackUrl(options.url);
  const claimLimit = parseBridgeInteger(options.limit, '--limit', 1, 100);
  const claimBlockMs = parseBridgeInteger(options.blockMs, '--block-ms', 0, 30_000);
  const claimMinIdleMs = parseBridgeInteger(options.minIdleMs, '--min-idle-ms', 0, 86_400_000);
  const heartbeatMs = parseBridgeInteger(options.heartbeatMs, '--heartbeat-ms', 100);
  const closeGraceMs = parseBridgeInteger(options.closeGraceMs, '--close-grace-ms', 100, 60_000);

  const daemon: DeepSeekBridgeDaemonClient = {
    ...createBridgeDaemonClient(dependencies, daemonUrl),
    declareNative: async (sessionId, native) => {
      await request(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/native`,
        nativeDeclarationResponseSchema,
        jsonBody({ native }),
      );
    },
  };
  const acp = dependencies.createDeepSeekAcpFactory({
    command: options.command,
    args: parseStringArray(options.argsJson, '--args-json'),
    permission: options.permission,
    environment: { ...dependencies.environment },
    closeGraceMs,
  });
  const bridge = createDeepSeekBridge({
    daemon,
    acp,
    daemonUrl,
    projectId: options.project,
    agentId: options.agent,
    workingDirectory: options.workingDirectory,
    bridgeInstanceId: options.bridgeInstance,
    claimLimit,
    claimBlockMs,
    claimMinIdleMs,
  });

  let stopped = false;
  let heartbeatError: unknown;
  let shutdown: Promise<void> | undefined;
  const stop = (): void => {
    stopped = true;
    shutdown ??= bridge.stop();
    shutdown.catch(() => undefined);
  };
  dependencies.signals.once('SIGINT', stop);
  dependencies.signals.once('SIGTERM', stop);
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatPending = false;
  try {
    try {
      await bridge.start();
    } catch (error) {
      if (!stopped || !(error instanceof DeepSeekBridgeStartupCancelledError)) throw error;
      await (shutdown ?? bridge.stop());
      return;
    }
    if (stopped) return;
    printJson(dependencies, {
      bridge: 'deepseek-harness-acp',
      experimental: true,
      sessionId: bridge.sessionId,
    });
    heartbeatTimer = dependencies.setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void bridge
        .heartbeat()
        .catch((error: unknown) => {
          heartbeatError = error;
          stop();
        })
        .finally(() => {
          heartbeatPending = false;
        });
    }, heartbeatMs);
    while (!stopped) {
      const count = await bridge.pollOnce();
      if (count === 0 && claimBlockMs === 0 && !stopped) await dependencies.wait(100);
    }
  } finally {
    if (heartbeatTimer !== undefined) dependencies.clearInterval(heartbeatTimer);
    dependencies.signals.off('SIGINT', stop);
    dependencies.signals.off('SIGTERM', stop);
    await (shutdown ?? bridge.stop());
  }
  if (heartbeatError !== undefined) {
    throw new ApplicationError(
      'BRIDGE_HEARTBEAT_FAILED',
      'The DeepSeek bridge heartbeat failed.',
      503,
    );
  }
}

function compareStreamIds(left: RealtimeEventMessage, right: RealtimeEventMessage): number {
  const [leftTime = '0', leftSequence = '0'] = left.streamId.split('-');
  const [rightTime = '0', rightSequence = '0'] = right.streamId.split('-');
  const timeDifference = BigInt(leftTime) - BigInt(rightTime);
  if (timeDifference !== 0n) {
    return timeDifference < 0n ? -1 : 1;
  }
  const sequenceDifference = BigInt(leftSequence) - BigInt(rightSequence);
  return sequenceDifference === 0n ? 0 : sequenceDifference < 0n ? -1 : 1;
}

function websocketUrl(base: string): string {
  const url = new URL('/api/v1/realtime', `${baseUrl(base)}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function eventData(event: unknown): unknown {
  return event !== null && typeof event === 'object' && 'data' in event
    ? (event as { data: unknown }).data
    : undefined;
}

async function watchEvents(dependencies: CliDependencies, options: { url: string }): Promise<void> {
  const recent = new Set<string>();
  const recentOrder: string[] = [];
  let stopped = false;
  let activeSocket: CliWebSocket | undefined;
  const stop = (): void => {
    stopped = true;
    activeSocket?.close(1000, 'CLI stopping');
  };
  dependencies.signals.once('SIGINT', stop);
  dependencies.signals.once('SIGTERM', stop);

  const remember = (message: RealtimeEventMessage): boolean => {
    if (recent.has(message.streamId)) {
      return false;
    }
    recent.add(message.streamId);
    recentOrder.push(message.streamId);
    if (recentOrder.length > 4_096) {
      const removed = recentOrder.shift();
      if (removed !== undefined) {
        recent.delete(removed);
      }
    }
    return true;
  };

  let backoff = 250;
  try {
    while (!stopped) {
      const socket = dependencies.createWebSocket(websocketUrl(options.url));
      activeSocket = socket;
      const buffered: RealtimeEventMessage[] = [];
      let snapshotComplete = false;
      let overflowError: Error | undefined;
      let resolveClosed: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const opened = new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('Realtime connection failed.')));
      });
      socket.addEventListener('message', (incoming) => {
        try {
          const data = eventData(incoming);
          const text =
            typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
          const message = realtimeEventMessageSchema.parse(JSON.parse(text) as unknown);
          if (!snapshotComplete) {
            if (buffered.length >= 256) {
              overflowError = new Error('Realtime pre-snapshot buffer overflow.');
              socket.close(1013, 'Snapshot buffer overflow');
              return;
            }
            buffered.push(message);
          } else if (remember(message)) {
            dependencies.stdout.write(`${JSON.stringify({ section: 'live', ...message })}\n`);
          }
        } catch {
          dependencies.stderr.write(`${JSON.stringify({ code: 'REALTIME_MESSAGE_INVALID' })}\n`);
        }
      });
      socket.addEventListener('close', () => resolveClosed?.());

      await opened;
      const [projects, sessions] = await Promise.all([
        request(dependencies, options.url, '/api/v1/projects', projectCollectionResponseSchema),
        request(dependencies, options.url, '/api/v1/sessions', sessionCollectionResponseSchema),
      ]);
      dependencies.stdout.write(
        `${JSON.stringify({ section: 'snapshot', projects: projects.projects, sessions: sessions.sessions })}\n`,
      );
      snapshotComplete = true;
      for (const message of buffered.sort(compareStreamIds)) {
        if (remember(message)) {
          dependencies.stdout.write(`${JSON.stringify({ section: 'live', ...message })}\n`);
        }
      }
      if (overflowError !== undefined) {
        throw overflowError;
      }
      await closed;
      if (!stopped) {
        dependencies.stderr.write(
          `${JSON.stringify({ code: 'REALTIME_GAP_POSSIBLE', retryInMs: backoff })}\n`,
        );
        await dependencies.wait(backoff);
        backoff = Math.min(backoff * 2, 5_000);
      }
    }
  } finally {
    dependencies.signals.off('SIGINT', stop);
    dependencies.signals.off('SIGTERM', stop);
  }
}

/** Project/agent/binding discovery `agent run` and the native bridge share to resolve context. */
function createAgentRunDiscoveryClient(
  dependencies: CliDependencies,
  daemonUrl: string,
  connectTimeoutMs: number,
) {
  const get = <Output>(path: string, parser: Parser<Output>) =>
    boundedRequest(dependencies, daemonUrl, path, parser, connectTimeoutMs);
  return {
    listProjects: async () =>
      (await get('/api/v1/projects', projectCollectionResponseSchema)).projects.map((project) => ({
        id: project.id,
        localPath: project.canonicalPath,
      })),
    listAgents: async () =>
      (await get('/api/v1/agents', agentDefinitionCollectionSchema)).agents.map((agent) => ({
        id: agent.id,
        kind: agent.kind,
        enabled: agent.enabled,
        ...(agent.executable === undefined ? {} : { executable: agent.executable }),
      })),
    listProjectAgentBindings: async (projectId: string) =>
      (
        await get(
          `/api/v1/projects/${encodeURIComponent(projectId)}/agents`,
          projectAgentBindingCollectionSchema,
        )
      ).bindings,
  };
}

/** The bounded register/heartbeat/close client `createSessionBootstrap` drives (ADR 0030). */
function createBootstrapSessionClient(
  dependencies: CliDependencies,
  daemonUrl: string,
  connectTimeoutMs: number,
) {
  return {
    register: (input: unknown) =>
      boundedRequest(
        dependencies,
        daemonUrl,
        '/api/v1/sessions',
        sessionResponseSchema,
        connectTimeoutMs,
        jsonBody(input),
      ),
    heartbeat: async (sessionId: string) => {
      await boundedRequest(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
        heartbeatResponseSchema,
        connectTimeoutMs,
        jsonBody({}),
      );
    },
    inspect: async (sessionId: string) => {
      const session = await boundedRequest(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        sessionResponseSchema,
        connectTimeoutMs,
      );
      return { status: session.status };
    },
    close: async (sessionId: string) => {
      await boundedRequest(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
        sessionResponseSchema,
        connectTimeoutMs,
        jsonBody({}),
      );
    },
  };
}

/** The bounded held-lease renewal client the bootstrap runs on its second timer (ADR 0026). */
function createBootstrapLeaseClient(
  dependencies: CliDependencies,
  daemonUrl: string,
  connectTimeoutMs: number,
) {
  return {
    listSessionLeases: async (sessionId: string) =>
      (
        await boundedRequest(
          dependencies,
          daemonUrl,
          `/api/v1/leases?sessionId=${encodeURIComponent(sessionId)}&limit=1000`,
          leaseCollectionSchema,
          connectTimeoutMs,
        )
      ).leases.map((lease) => ({
        id: lease.id,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        ...(lease.renewedAt === undefined ? {} : { renewedAt: lease.renewedAt }),
      })),
    renewLease: async (leaseId: string, sessionId: string, durationMs: number) => {
      await boundedRequest(
        dependencies,
        daemonUrl,
        `/api/v1/leases/${encodeURIComponent(leaseId)}/renew`,
        workLeaseSchema,
        connectTimeoutMs,
        jsonBody({ sessionId, durationMs }),
      );
    },
  };
}

/**
 * ADR 0031: `luwi session bridge native <provider>` serves one agent's inbox unattended.
 * The session bootstrap owns identity, heartbeat, rotation, lease renewal and close; the
 * native bridge claims the inbox and runs the native CLI headless once per message, with
 * everything after `--` passed to that CLI unchanged as its permission model.
 */
async function runNativeBridge(
  dependencies: CliDependencies,
  providerValue: string,
  nativeArgs: string[],
  options: {
    project?: string;
    agentId?: string;
    workingDirectory: string;
    executable?: string;
    model?: string;
    bridgeInstance: string;
    limit: number;
    blockMs: number;
    minIdleMs: number;
    heartbeatMs: number;
    leaseRenewMs: number;
    connectTimeoutMs: number;
    url: string;
  },
): Promise<void> {
  const provider = agentProvider(providerValue);
  const daemonUrl = loopbackDaemonUrl(options.url);
  let workingDirectory: string;
  try {
    workingDirectory = await dependencies.canonicalizePath(options.workingDirectory);
  } catch {
    throw new ApplicationError(
      'AGENT_WORKING_DIRECTORY_INVALID',
      'The native agent working directory could not be canonicalized.',
      400,
    );
  }

  const context = await resolveAgentRunContext({
    provider,
    workingDirectory,
    ...(options.project === undefined ? {} : { projectId: options.project }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    platform: dependencies.platform,
    client: createAgentRunDiscoveryClient(dependencies, daemonUrl, options.connectTimeoutMs),
  });

  const bootstrap = createSessionBootstrap({
    client: createBootstrapSessionClient(dependencies, daemonUrl, options.connectTimeoutMs),
    projectId: context.projectId,
    agentId: context.agentId,
    workingDirectory,
    metadata: {
      client: 'bridge',
      bridge: 'native-headless',
      provider: provider.name,
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    heartbeatIntervalMs: options.heartbeatMs,
    leaseRenewIntervalMs: options.leaseRenewMs,
    leaseClient: createBootstrapLeaseClient(dependencies, daemonUrl, options.connectTimeoutMs),
    onError: (error) => printAgentDiagnostic(dependencies, 'LUWI_OBSERVATION_DEGRADED', error),
    setInterval: dependencies.setInterval,
    clearInterval: dependencies.clearInterval,
  });

  await bootstrap.start();

  // Both codex and claude bind LUWI's native reference to one persistent native
  // session so the transcript/rollout reader can attribute the worker's token
  // usage. They differ only in where the id comes from: codex `exec` is stateless
  // per run, so the bridge recovers the id from the rollout after the first run
  // (ADR: codex usage ingestion) and resumes it thereafter; claude accepts a
  // caller-chosen id, so the bridge mints one up front, forces it with
  // `--session-id`/`--resume`, and declares it after the first run creates the
  // transcript. antigravity/gemini stay unbound — neither exposes a per-process id
  // the bridge can force or recover without guessing (an agy fleet worker shares
  // the GUI IDE's working directory, so a disk guess would steal its conversation).
  let codexNativeSessionId: string | undefined;
  // Minted up front for claude; `undefined` for every other provider.
  const claudeNativeSessionId = provider.name === 'claude' ? randomUUID() : undefined;
  let claudeSessionStarted = false;
  let nativeDeclared = false;
  const resolveNativeRefOnce = async (): Promise<NativeSessionRef | undefined> => {
    if (provider.name === 'claude') {
      return claudeNativeSessionId === undefined
        ? undefined
        : { adapterId: 'claude-code', nativeSessionId: claudeNativeSessionId };
    }
    if (provider.name !== 'codex') return undefined;
    const ref = await resolveNativeIdentityFromDisk('codex', {
      environment: dependencies.environment,
      workingDirectory,
      platform: dependencies.platform,
      fileSystem: dependencies.transcriptFileSystem,
      now: dependencies.now,
    });
    if (ref === undefined) return undefined;
    // Lock onto the first session found and keep resuming it thereafter.
    codexNativeSessionId ??= ref.nativeSessionId;
    return {
      adapterId: ref.adapterId,
      nativeSessionId: codexNativeSessionId,
      ...(ref.nativeSubagentId === undefined ? {} : { nativeSubagentId: ref.nativeSubagentId }),
    };
  };
  const declareNativeOnce = async (): Promise<void> => {
    if (nativeDeclared) return;
    const sessionId = bootstrap.sessionId;
    if (sessionId === undefined) return;
    try {
      const native = await resolveNativeRefOnce();
      if (native === undefined) return;
      await boundedRequest(
        dependencies,
        daemonUrl,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/native`,
        nativeDeclarationResponseSchema,
        options.connectTimeoutMs,
        jsonBody({ native }),
      );
      nativeDeclared = true;
    } catch (error) {
      printAgentDiagnostic(dependencies, 'LUWI_OBSERVATION_DEGRADED', error);
    }
  };

  let activeRun: EventEmitter | undefined;
  const executor: NativeBridgeExecutor = {
    run: async ({ prompt, deadlineAt }): Promise<NativeBridgeRunResult> => {
      const runSignals = new EventEmitter();
      activeRun = runSignals;
      let deadlineFired = false;
      const delayMs = Math.max(0, Date.parse(deadlineAt) - Date.now());
      const timer = dependencies.setTimeout(() => {
        deadlineFired = true;
        runSignals.emit('SIGTERM');
      }, delayMs);
      const inherited: Record<string, string | undefined> = { ...dependencies.environment };
      delete inherited['LUWI_DAEMON_URL'];
      delete inherited['LUWI_SESSION_ID'];
      let tail = '';
      // codex needs the LUWI session injected into its MCP server's env and its tool
      // calls auto-approved; claude/gemini bind through the inherited LUWI_SESSION_ID.
      const providerNativeArgs =
        provider.name === 'codex' && bootstrap.sessionId !== undefined
          ? [...codexMcpBindingArgs(bootstrap.sessionId, daemonUrl), ...nativeArgs]
          : nativeArgs;
      // codex learns its id only after the first run, so it passes nothing until
      // then; claude forces its minted id, creating on the first run and resuming
      // after. Everything else stays a fresh, unbound run.
      const nativeSession: { id: string; resume: boolean } | undefined =
        provider.name === 'codex'
          ? codexNativeSessionId === undefined
            ? undefined
            : { id: codexNativeSessionId, resume: true }
          : claudeNativeSessionId === undefined
            ? undefined
            : { id: claudeNativeSessionId, resume: claudeSessionStarted };
      try {
        const result = await dependencies.agentProcessRunner.run({
          executable: options.executable ?? context.executable ?? provider.executable,
          args: nativeHeadlessArguments(provider.name, prompt, providerNativeArgs, nativeSession),
          workingDirectory,
          environment: {
            ...inherited,
            LUWI_DAEMON_URL: daemonUrl,
            ...(bootstrap.sessionId === undefined ? {} : { LUWI_SESSION_ID: bootstrap.sessionId }),
          },
          signals: runSignals,
          captureOutput: (chunk) => {
            tail = (tail + chunk).slice(-4096);
          },
          onDiagnostic: (error) =>
            printAgentDiagnostic(dependencies, 'AGENT_PROCESS_DIAGNOSTIC', error),
        });
        // The first run has now created the native session (codex's rollout on
        // disk, claude's transcript under the forced id), so flip claude to resume
        // and bind the reference once — best-effort, and only after a run that
        // actually started, so a child that never launched is not resumed next time.
        if (provider.name === 'claude') claudeSessionStarted = true;
        await declareNativeOnce();
        return {
          result: deadlineFired ? 'deadline' : 'completed',
          exitCode: result.exitCode,
          outputTail: tail,
        };
      } finally {
        dependencies.clearTimeout(timer);
        if (activeRun === runSignals) activeRun = undefined;
      }
    },
  };

  const bridge = createNativeBridge({
    daemon: createBridgeDaemonClient(dependencies, daemonUrl),
    executor,
    currentSessionId: () => bootstrap.sessionId,
    agentId: context.agentId,
    projectId: context.projectId,
    bridgeInstanceId: options.bridgeInstance,
    claimLimit: options.limit,
    claimBlockMs: options.blockMs,
    claimMinIdleMs: options.minIdleMs,
    report: (line) => printJson(dependencies, { bridge: 'native-headless', ...line }),
  });

  let stopped = false;
  const stop = (): void => {
    stopped = true;
    void bridge.stop();
    activeRun?.emit('SIGTERM');
  };
  dependencies.signals.once('SIGINT', stop);
  dependencies.signals.once('SIGTERM', stop);
  printJson(dependencies, {
    bridge: 'native-headless',
    provider: provider.name,
    sessionId: bootstrap.sessionId,
    agentId: context.agentId,
    projectId: context.projectId,
  });
  let pollBackoffMs = 250;
  try {
    while (!stopped) {
      try {
        const count = await bridge.pollOnce();
        pollBackoffMs = 250;
        if (count === 0 && options.blockMs === 0 && !stopped) await dependencies.wait(100);
      } catch (error) {
        // A transient daemon error (DAEMON_REQUEST_TIMEOUT / _UNAVAILABLE / RUNTIME_NOT_READY)
        // must not kill the bridge: exiting here makes the manager retire and relaunch the
        // worker (respawn storm). Back off and retry so the session rides out brief daemon
        // unavailability. A genuine stop is never swallowed — we break as soon as it is set.
        if (stopped) break;
        const code = error instanceof ApplicationError ? error.code : 'BRIDGE_POLL_FAILED';
        dependencies.stderr.write(
          `${JSON.stringify({
            error: { code, message: error instanceof Error ? error.message : String(error) },
            retryInMs: pollBackoffMs,
          })}\n`,
        );
        await dependencies.wait(pollBackoffMs);
        pollBackoffMs = Math.min(pollBackoffMs * 2, 5_000);
      }
    }
  } finally {
    dependencies.signals.off('SIGINT', stop);
    dependencies.signals.off('SIGTERM', stop);
    await bootstrap.stop();
  }
}

function registerAgentRunCli(agents: Command, dependencies: CliDependencies): void {
  agents
    .command('run <provider> [nativeArgs...]')
    .description('Run Claude, Codex, or Gemini with optional LUWI session observation')
    .option('--project <projectId>', 'Explicit registered project ID')
    .option('--agent-id <agentId>', 'Explicit LUWI AgentDefinition ID')
    .option('--working-directory <path>', 'Native agent working directory', dependencies.cwd())
    .option('--executable <path>', 'Explicit native agent executable')
    .option('--heartbeat-ms <milliseconds>', 'Session heartbeat interval', '5000')
    .option('--lease-renew-ms <milliseconds>', 'Held work-lease renewal interval', '150000')
    .option('--connect-timeout-ms <milliseconds>', 'Per-request LUWI connection timeout', '2000')
    .option('-u, --url <url>', 'LUWI daemon loopback URL', 'http://127.0.0.1:4782')
    .action(
      async (
        providerValue: string,
        nativeArgs: string[] | undefined,
        options: {
          project?: string;
          agentId?: string;
          workingDirectory: string;
          executable?: string;
          heartbeatMs: string;
          leaseRenewMs: string;
          connectTimeoutMs: string;
          url: string;
        },
      ) => {
        const provider = agentProvider(providerValue);
        const daemonUrl = loopbackDaemonUrl(options.url);
        const heartbeatMs = positiveIntegerOption(
          options.heartbeatMs,
          '--heartbeat-ms',
          100,
          10_000,
        );
        const leaseRenewMs = positiveIntegerOption(
          options.leaseRenewMs,
          '--lease-renew-ms',
          1_000,
          3_600_000,
        );
        const connectTimeoutMs = positiveIntegerOption(
          options.connectTimeoutMs,
          '--connect-timeout-ms',
          100,
          30_000,
        );
        let workingDirectory: string;
        try {
          workingDirectory = await dependencies.canonicalizePath(options.workingDirectory);
        } catch {
          throw new ApplicationError(
            'AGENT_WORKING_DIRECTORY_INVALID',
            'The native agent working directory could not be canonicalized.',
            400,
          );
        }

        let context: { projectId: string; agentId: string; executable: string } | undefined;
        try {
          context = await resolveAgentRunContext({
            provider,
            workingDirectory,
            ...(options.project === undefined ? {} : { projectId: options.project }),
            ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
            ...(options.executable === undefined ? {} : { executable: options.executable }),
            platform: dependencies.platform,
            client: createAgentRunDiscoveryClient(dependencies, daemonUrl, connectTimeoutMs),
          });
        } catch (error) {
          printAgentDiagnostic(dependencies, 'LUWI_OBSERVATION_DEGRADED', error);
        }

        let childStarted = false;
        const bootstrap =
          context === undefined
            ? undefined
            : createSessionBootstrap({
                client: createBootstrapSessionClient(dependencies, daemonUrl, connectTimeoutMs),
                projectId: context.projectId,
                agentId: context.agentId,
                workingDirectory,
                // A headless CLI worker wrapping a native agent (`agent run`).
                metadata: { client: 'cli' },
                heartbeatIntervalMs: heartbeatMs,
                leaseRenewIntervalMs: leaseRenewMs,
                leaseClient: createBootstrapLeaseClient(dependencies, daemonUrl, connectTimeoutMs),
                onError: (error) =>
                  printAgentDiagnostic(dependencies, 'LUWI_OBSERVATION_DEGRADED', error),
                onSessionChanged: (change) => {
                  if (
                    (change.reason === 'registered' || change.reason === 'recovered') &&
                    childStarted &&
                    change.sessionId !== environmentSessionId
                  ) {
                    printAgentDiagnostic(dependencies, 'LUWI_SESSION_RECOVERED');
                  }
                },
                setInterval: dependencies.setInterval,
                clearInterval: dependencies.clearInterval,
              });

        await bootstrap?.start();
        const environmentSessionId = bootstrap?.sessionId;
        const inheritedEnvironment: Record<string, string | undefined> = {
          ...dependencies.environment,
        };
        delete inheritedEnvironment['LUWI_DAEMON_URL'];
        delete inheritedEnvironment['LUWI_SESSION_ID'];
        const childEnvironment = {
          ...inheritedEnvironment,
          LUWI_DAEMON_URL: daemonUrl,
          ...(environmentSessionId === undefined ? {} : { LUWI_SESSION_ID: environmentSessionId }),
        };
        childStarted = true;
        try {
          const result = await dependencies.agentProcessRunner.run({
            executable: context?.executable ?? options.executable ?? provider.executable,
            args: nativeArgs ?? [],
            workingDirectory,
            environment: childEnvironment,
            signals: dependencies.signals,
            onDiagnostic: (error) =>
              printAgentDiagnostic(dependencies, 'AGENT_PROCESS_DIAGNOSTIC', error),
          });
          dependencies.setExitCode(result.exitCode);
        } finally {
          childStarted = false;
          await bootstrap?.stop();
        }
      },
    );
}

export function createCli(dependencies: CliDependencies): Command {
  const program = new Command()
    .name('luwi')
    .description('Inspect and operate the local LUWI Runtime daemon')
    .version(LUWI_RUNTIME_VERSION);

  program
    .command('doctor')
    .description('Check local LUWI, Docker, Redis, daemon, and native-agent readiness')
    .option('--json', 'Print a machine-readable report')
    .action(async (options: { json?: boolean }) => {
      printDoctor(dependencies, await dependencies.lifecycle.doctor(), options.json === true);
    });

  program
    .command('setup')
    .description('Prepare LUWI-owned local lifecycle configuration')
    .option('--yes', 'Approve the scoped LUWI lifecycle configuration write')
    .option('--print-hooks', 'Print optional native-agent wrapper snippets')
    .option('--autostart', 'Register a per-user logon task that starts LUWI (Windows)')
    .option('--no-autostart', 'Remove the LUWI autostart task')
    .action(async (options: { yes?: boolean; printHooks?: boolean; autostart?: boolean }) => {
      printJson(
        dependencies,
        await dependencies.lifecycle.setup({
          approved: options.yes === true,
          printHooks: options.printHooks === true,
          autostart: options.autostart === true,
          noAutostart: options.autostart === false,
        }),
      );
    });

  program
    .command('start')
    .description('Start Compose Redis when applicable and one owned LUWI daemon')
    .action(async () => {
      printLifecycleStatus(dependencies, await dependencies.lifecycle.start({}), false);
    });

  program
    .command('status')
    .description('Report daemon, ownership, Redis, and Compose state')
    .option('--json', 'Print a machine-readable report')
    .action(async (options: { json?: boolean }) => {
      printLifecycleStatus(
        dependencies,
        await dependencies.lifecycle.status(),
        options.json === true,
      );
    });

  program
    .command('stop')
    .description('Stop the owned daemon; preserve Redis unless explicitly requested')
    .option('--with-redis', 'Also stop the Compose Redis service without deleting its volume')
    .action(async (options: { withRedis?: boolean }) => {
      printLifecycleStatus(
        dependencies,
        await dependencies.lifecycle.stop({ withRedis: options.withRedis === true }),
        false,
      );
    });

  program
    .command('reset')
    .description('Reset only the fixed LUWI Redis runtime namespace')
    .requiredOption('--runtime-state', 'Authorize only the LUWI runtime-state reset surface')
    .option('--yes', 'Approve deletion of the fixed LUWI runtime namespace')
    .option('--json', 'Print machine-readable output without prompting')
    .action(async (options: { runtimeState: boolean; yes?: boolean; json?: boolean }) => {
      const result = await dependencies.lifecycle.resetRuntimeState({
        approved: options.yes === true,
        interactive: options.json !== true,
      });
      printRuntimeResetResult(dependencies, result, options.json === true);
    });

  program
    .command('runtime')
    .description('Print validated runtime information from the daemon')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (options: { url: string }) => {
      printJson(
        dependencies,
        await request(dependencies, options.url, '/api/v1/runtime', runtimeInfoResponseSchema),
      );
    });

  const projects = program.command('project').description('Manage registered projects');
  projects
    .command('discover <root>')
    .description('Preview or apply one-level local project discovery')
    .option('--exclude <directory>', 'Exclude an exact immediate-child directory', appendOption, [])
    .option('--name <mapping>', 'Set an exact directory=Display Name mapping', appendOption, [])
    .option('--apply', 'Register new candidates and refresh read-only Git observations')
    .option('--json', 'Print machine-readable output')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (
        root: string,
        options: {
          exclude: string[];
          name: string[];
          apply?: boolean;
          json?: boolean;
          url: string;
        },
      ) => {
        const existingProjects = (
          await request(
            dependencies,
            options.url,
            '/api/v1/projects',
            projectCollectionResponseSchema,
          )
        ).projects;
        const plan = await dependencies.projectDiscovery.createPlan({
          root,
          excludes: options.exclude,
          names: parseProjectNameMappings(options.name, dependencies.platform),
          existingProjects,
        });
        if (options.apply !== true) {
          printJson(dependencies, { mode: 'dry_run', plan });
          return;
        }
        printJson(dependencies, await applyProjectDiscovery(dependencies, options.url, plan));
      },
    );
  projects
    .command('register')
    .requiredOption('-n, --name <name>', 'Project display name')
    .requiredOption('-p, --path <path>', 'Existing local project path')
    .option('--repository-url <url>', 'Repository URL')
    .option('--default-branch <branch>', 'Default branch')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        name: string;
        path: string;
        repositoryUrl?: string;
        defaultBranch?: string;
        url: string;
      }) => {
        printJson(
          dependencies,
          await request(
            dependencies,
            options.url,
            '/api/v1/projects',
            projectResponseSchema,
            jsonBody({
              name: options.name,
              localPath: options.path,
              ...(options.repositoryUrl === undefined
                ? {}
                : { repositoryUrl: options.repositoryUrl }),
              ...(options.defaultBranch === undefined
                ? {}
                : { defaultBranch: options.defaultBranch }),
            }),
          ),
        );
      },
    );
  projects
    .command('list')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (options: { url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          '/api/v1/projects',
          projectCollectionResponseSchema,
        ),
      );
    });
  projects
    .command('get <projectId>')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (projectId: string, options: { url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${encodeURIComponent(projectId)}`,
          projectResponseSchema,
        ),
      );
    });

  const agents = registerControlPlaneCli(program, projects, dependencies);
  registerAgentRunCli(agents, dependencies);
  registerIntelligenceCli(program, dependencies);

  const sessions = program.command('session').description('Manage agent sessions');
  sessions
    .command('register')
    .requiredOption('--project <projectId>', 'Registered project ID')
    .requiredOption('--agent <agentId>', 'Opaque agent ID')
    .requiredOption('--working-directory <path>', 'Existing working directory')
    .option('--task-summary <summary>', 'Short task summary')
    .option('--branch <branch>', 'Current branch')
    .option('--worktree-path <path>', 'Worktree path')
    .option('--metadata <json>', 'Bounded metadata JSON object', '{}')
    .option('--native-adapter <adapterId>', 'Adapter namespace of the native session reference')
    .option('--native-session <nativeSessionId>', 'Vendor-native session identifier')
    .option('--native-subagent <nativeSubagentId>', 'Vendor-native subagent identifier')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        project: string;
        agent: string;
        workingDirectory: string;
        taskSummary?: string;
        branch?: string;
        worktreePath?: string;
        metadata: string;
        nativeAdapter?: string;
        nativeSession?: string;
        nativeSubagent?: string;
        url: string;
      }) => {
        const native = parseNativeRef(options);
        printJson(
          dependencies,
          await request(
            dependencies,
            options.url,
            '/api/v1/sessions',
            sessionResponseSchema,
            jsonBody({
              projectId: options.project,
              agentId: options.agent,
              workingDirectory: options.workingDirectory,
              metadata: parseJsonObject(options.metadata, '--metadata'),
              ...(options.taskSummary === undefined ? {} : { taskSummary: options.taskSummary }),
              ...(options.branch === undefined ? {} : { branch: options.branch }),
              ...(options.worktreePath === undefined ? {} : { worktreePath: options.worktreePath }),
              ...(native === undefined ? {} : { native }),
            }),
          ),
        );
      },
    );
  sessions
    .command('list')
    .option('--project <projectId>', 'Filter by project')
    .option('--online', 'Show only online sessions')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (options: { project?: string; online?: boolean; url: string }) => {
      const path =
        options.project === undefined
          ? '/api/v1/sessions'
          : `/api/v1/projects/${encodeURIComponent(options.project)}/sessions`;
      const result = await request(
        dependencies,
        options.url,
        path,
        sessionCollectionResponseSchema,
      );
      printJson(dependencies, {
        sessions:
          options.online === true
            ? result.sessions.filter(({ presence }) => presence === 'online')
            : result.sessions,
      });
    });
  sessions
    .command('get <sessionId>')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (sessionId: string, options: { url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
          sessionResponseSchema,
        ),
      );
    });
  sessions
    .command('heartbeat <sessionId>')
    .option('--metadata <json>', 'Replacement metadata JSON object')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (sessionId: string, options: { metadata?: string; url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
          heartbeatResponseSchema,
          jsonBody(
            options.metadata === undefined
              ? {}
              : { metadata: parseJsonObject(options.metadata, '--metadata') },
          ),
        ),
      );
    });
  sessions
    .command('status <sessionId> <status>')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (sessionId: string, statusValue: string, options: { url: string }) => {
      const status = sessionStatusTargetSchema.parse(statusValue);
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`,
          sessionResponseSchema,
          jsonBody({ status }),
        ),
      );
    });
  sessions
    .command('close <sessionId>')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (sessionId: string, options: { url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
          sessionResponseSchema,
          jsonBody({}),
        ),
      );
    });
  /**
   * Attaches the *calling* process to LUWI: it resolves this session's own
   * native identity from the environment, registers, heartbeats while it runs,
   * and closes on SIGINT or SIGTERM.
   *
   * This is the surface that turns a running agent into a visible one. It
   * differs from `session simulate` in that it declares nothing it was not
   * given: an identity that cannot be resolved registers with no native block
   * rather than a fabricated one.
   */
  /** Kinds whose identity LUWI can recognise unprompted, in resolution order. */
  const DETECTABLE_AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex'];
  sessions
    .command('attach')
    .option(
      '--project <projectId>',
      'Registered project ID (default: the registered project containing the working directory)',
    )
    .option('--agent <agentId>', 'Opaque agent ID (default: the agent kind)')
    .option('--working-directory <path>', 'Working directory', dependencies.cwd())
    .option(
      '--agent-kind <kind>',
      'Vendor whose identity to resolve (default: whichever identity resolves here, else claude-code)',
    )
    .option('--model <model>', 'Model the agent runs, recorded as session metadata')
    .option(
      '--client <kind>',
      `How the session reached the runtime (${CLIENT_KINDS.join('|')}); a launcher hook stamps its kind`,
    )
    .option(
      '--native-adapter <adapterId>',
      'Adapter namespace of a native session reference the launcher already knows',
    )
    .option('--native-session <nativeSessionId>', 'Vendor-native session identifier')
    .option('--native-subagent <nativeSubagentId>', 'Vendor-native subagent identifier')
    .option('--heartbeat-ms <milliseconds>', 'Heartbeat interval', '5000')
    .option('--lease-renew-ms <milliseconds>', 'Held work-lease renewal interval', '150000')
    .option('--connect-timeout-ms <milliseconds>', 'Per-request LUWI connection timeout', '2000')
    .option(
      '--session-out <path>',
      'Machine-readable file atomically rewritten with the current LUWI session id on every (re)registration, so an MCP launcher rebinds after a rotation instead of holding a terminal id',
    )
    .option('--dry-run', 'Print what would be declared and exit without registering')
    .option('-u, --url <url>', 'LUWI daemon loopback URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        project?: string;
        agent?: string;
        workingDirectory: string;
        agentKind?: string;
        model?: string;
        client?: string;
        nativeAdapter?: string;
        nativeSession?: string;
        nativeSubagent?: string;
        heartbeatMs: string;
        leaseRenewMs: string;
        connectTimeoutMs: string;
        sessionOut?: string;
        dryRun?: boolean;
        url: string;
      }) => {
        const daemonUrl = loopbackDaemonUrl(options.url);
        const connectTimeoutMs = positiveIntegerOption(
          options.connectTimeoutMs,
          '--connect-timeout-ms',
          100,
          30_000,
        );
        if (options.sessionOut !== undefined && !isAbsolute(options.sessionOut)) {
          throw new ApplicationError(
            'CLI_OPTION_INVALID',
            '--session-out must be an absolute path.',
            400,
          );
        }
        const callDaemon = <Output>(
          path: string,
          parser: Parser<Output>,
          init?: FetchInitLike,
        ): Promise<Output> =>
          boundedRequest(dependencies, daemonUrl, path, parser, connectTimeoutMs, init);
        // Canonicalize the working directory so the Codex cwd-match compares like
        // for like against the absolute path the rollout records (a junction,
        // subst drive, or relative value would otherwise never match). Best-effort:
        // attach must stay visible even when the path cannot be canonicalized, so a
        // failure falls back to the raw value rather than aborting.
        let workingDirectory: string;
        try {
          workingDirectory = await dependencies.canonicalizePath(options.workingDirectory);
        } catch {
          workingDirectory = options.workingDirectory;
        }
        // Which vendor this is, and its native identity. With --agent-kind that
        // kind is resolved environment-first (deterministic), then from disk
        // (ADR 0028). Without it, the kinds LUWI can recognise are tried in the
        // same order and the first identity that resolves names the kind; nothing
        // resolving keeps the previous default, unattributed — an absent binding
        // is honest, a fabricated one is not.
        const resolve = async (candidate: AgentKind) =>
          resolveNativeIdentity(candidate, dependencies.environment) ??
          (await resolveNativeIdentityFromDisk(candidate, {
            environment: dependencies.environment,
            workingDirectory,
            platform: dependencies.platform,
            fileSystem: dependencies.transcriptFileSystem,
            now: dependencies.now,
          }));
        // A launcher that already holds the vendor's own id — an Antigravity hook
        // is handed its conversationId — declares it outright, and nothing is
        // resolved on its behalf. The kind then defaults to `other`: an explicit
        // reference says which adapter namespace it lives in, not which of the
        // kinds LUWI can recognise unprompted this is.
        const declared = parseNativeRef(options);
        let kind: AgentKind = declared === undefined ? 'claude-code' : 'other';
        let native: NativeSessionRef | undefined = declared;
        if (declared !== undefined) {
          if (options.agentKind !== undefined) kind = agentKindSchema.parse(options.agentKind);
        } else {
          for (const candidate of options.agentKind === undefined
            ? DETECTABLE_AGENT_KINDS
            : [agentKindSchema.parse(options.agentKind)]) {
            native = await resolve(candidate);
            if (native !== undefined || options.agentKind !== undefined) {
              kind = candidate;
              break;
            }
          }
        }
        // The project is derived from where the agent runs unless named; the
        // daemon already knows every registered path.
        const projectId = await resolveProject(
          {
            workingDirectory,
            ...(options.project === undefined ? {} : { projectId: options.project }),
            client: {
              listProjects: async () =>
                (
                  await callDaemon('/api/v1/projects', projectCollectionResponseSchema)
                ).projects.map((project) => ({ id: project.id, localPath: project.canonicalPath })),
            },
          },
          dependencies.platform,
        );
        const metadata: Record<string, string> = {};
        if (options.model !== undefined) metadata.model = options.model;
        if (options.client !== undefined) metadata.client = clientKindOption(options.client);
        const request_ = {
          projectId,
          agentId: options.agent ?? kind,
          workingDirectory,
          ...(native === undefined ? {} : { native }),
          ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
        };

        if (options.dryRun === true) {
          printJson(dependencies, request_);
          return;
        }

        // Atomically rewrite --session-out with whatever session id is current now.
        // A daemon restart rotates the id (bootstrap re-registers), and an MCP
        // launcher that keeps reading the first id binds to a terminal session; this
        // keeps the file pointing at the live one, temp-then-rename so a poll never
        // reads a half-written path.
        const writeSessionOut = async (id: string): Promise<void> => {
          if (options.sessionOut === undefined) return;
          const temporary = `${options.sessionOut}.${randomUUID()}.tmp`;
          try {
            // The native reference rides along so a reader that must register a
            // successor after a drop can re-declare it (ADR 0034); the view a
            // session answers with does not carry it.
            const record = { attached: id, ...(native === undefined ? {} : { native }) };
            await writeFile(temporary, `${JSON.stringify(record)}\n`, {
              encoding: 'utf8',
              flag: 'wx',
              mode: 0o600,
            });
            await rename(temporary, options.sessionOut);
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
        };
        let sessionOutGeneration = 0;
        let sessionOutOperation = Promise.resolve();
        const publishSessionChange = (change: SessionBootstrapChange): void => {
          if (change.reason === 'dropped') {
            // The runtime reaped a session no reader ever bound (starting past its
            // grace). Nothing is re-registered — a replacement nobody binds is the
            // same zombie again — and the file keeps naming the dropped id so an
            // MCP server reports it as terminal rather than as missing.
            dependencies.stderr.write(
              `LUWI session ${change.previousSessionId} was dropped by the runtime before any reader bound it; not re-registering.\n`,
            );
            return;
          }
          if (options.sessionOut === undefined) return;
          const generation = ++sessionOutGeneration;
          sessionOutOperation = sessionOutOperation
            .then(async () => {
              if (generation !== sessionOutGeneration && change.reason !== 'stopped') return;
              if (change.reason === 'registered' || change.reason === 'recovered') {
                await writeSessionOut(change.sessionId);
              } else {
                await rm(options.sessionOut!, { force: true });
              }
            })
            .catch((error: unknown) => {
              dependencies.stderr.write(`${String(error)}\n`);
            });
        };

        const bootstrap = createSessionBootstrap({
          client: {
            register: async (input) =>
              callDaemon('/api/v1/sessions', sessionResponseSchema, jsonBody(input)),
            heartbeat: async (sessionId) => {
              await callDaemon(
                `/api/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
                heartbeatResponseSchema,
                jsonBody({}),
              );
            },
            inspect: async (sessionId) => {
              const session = await callDaemon(
                `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
                sessionResponseSchema,
              );
              return { status: session.status };
            },
            close: async (sessionId) => {
              await callDaemon(
                `/api/v1/sessions/${encodeURIComponent(sessionId)}/close`,
                sessionResponseSchema,
                jsonBody({}),
              );
            },
          },
          ...request_,
          // The reader of an attached session is the MCP server, not this process.
          // A lost session that never left `starting` had no reader; re-registering
          // it would recreate the zombie the runtime just reaped.
          recoverUnready: false,
          heartbeatIntervalMs: Number.parseInt(options.heartbeatMs, 10),
          leaseRenewIntervalMs: Number.parseInt(options.leaseRenewMs, 10),
          leaseClient: {
            listSessionLeases: async (sessionId) =>
              (
                await callDaemon(
                  `/api/v1/leases?sessionId=${encodeURIComponent(sessionId)}&limit=1000`,
                  leaseCollectionSchema,
                )
              ).leases.map((lease) => ({
                id: lease.id,
                acquiredAt: lease.acquiredAt,
                expiresAt: lease.expiresAt,
                ...(lease.renewedAt === undefined ? {} : { renewedAt: lease.renewedAt }),
              })),
            renewLease: async (leaseId, sessionId, durationMs) => {
              await callDaemon(
                `/api/v1/leases/${encodeURIComponent(leaseId)}/renew`,
                workLeaseSchema,
                jsonBody({ sessionId, durationMs }),
              );
            },
          },
          onError: (error: unknown) => {
            // Reported, never thrown: LUWI must not stop the tool it coordinates.
            dependencies.stderr.write(`${String(error)}\n`);
          },
          onSessionChanged: publishSessionChange,
          setInterval: dependencies.setInterval,
          clearInterval: dependencies.clearInterval,
        });

        let stopRequested = false;
        let resolveStop: (() => void) | undefined;
        const stopped = new Promise<void>((resolve) => {
          resolveStop = resolve;
        });
        const stop = (): void => {
          if (stopRequested) return;
          stopRequested = true;
          dependencies.signals.off('SIGINT', stop);
          dependencies.signals.off('SIGTERM', stop);
          resolveStop?.();
        };
        dependencies.signals.once('SIGINT', stop);
        dependencies.signals.once('SIGTERM', stop);

        // Mirror the Claude Code desktop chat title onto the LUWI session so the
        // dashboard names the session as the GUI does (ADR: native GUI title).
        // The title is auto-generated after the first turns, so it is polled and
        // pushed through the heartbeat's metadata replacement. Best-effort and
        // claude-code-only: no store, no title, or a failed push changes nothing.
        const titleDir =
          native !== undefined ? ccdSessionsDir(dependencies.environment) : undefined;
        const cliSessionId = native?.nativeSessionId;
        let titleFilePath: string | undefined;
        let pushedTitle: string | undefined;
        let pushedForSessionId: string | undefined;
        let titleTimer: NodeJS.Timeout | undefined;
        const pollTitle = async (): Promise<void> => {
          const sessionId = bootstrap.sessionId;
          if (titleDir === undefined || cliSessionId === undefined || sessionId === undefined) {
            return;
          }
          try {
            const found = await findNativeSessionTitle(
              dependencies.transcriptFileSystem,
              titleDir,
              cliSessionId,
              titleFilePath,
            );
            if (found === undefined) return;
            titleFilePath = found.filePath;
            // Re-push after a rotation even when the title is unchanged, so the
            // successor session carries it too.
            if (found.title === pushedTitle && sessionId === pushedForSessionId) return;
            await callDaemon(
              `/api/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
              heartbeatResponseSchema,
              jsonBody({ metadata: { ...(request_.metadata ?? {}), title: found.title } }),
            );
            pushedTitle = found.title;
            pushedForSessionId = sessionId;
          } catch (error) {
            dependencies.stderr.write(`${String(error)}\n`);
          }
        };

        try {
          await bootstrap.start();
          if (bootstrap.sessionId !== undefined) {
            printJson(dependencies, { attached: bootstrap.sessionId, ...request_ });
          }
          if (titleDir !== undefined && cliSessionId !== undefined) {
            void pollTitle();
            titleTimer = dependencies.setInterval(() => {
              void pollTitle();
            }, TITLE_POLL_INTERVAL_MS);
          }
          await stopped;
        } finally {
          if (titleTimer !== undefined) dependencies.clearInterval(titleTimer);
          dependencies.signals.off('SIGINT', stop);
          dependencies.signals.off('SIGTERM', stop);
          await bootstrap.stop();
          await sessionOutOperation;
        }
      },
    );
  sessions
    .command('simulate')
    .requiredOption('--project <projectId>', 'Registered project ID')
    .requiredOption('--agent <agentId>', 'Opaque agent ID')
    .requiredOption('--working-directory <path>', 'Existing working directory')
    .option('--heartbeat-ms <milliseconds>', 'Heartbeat interval', '5000')
    .option('--status <status>', 'Initial status after registration')
    .option('--ungraceful', 'Stop without closing the session')
    .option('--native-adapter <adapterId>', 'Adapter namespace of the native session reference')
    .option('--native-session <nativeSessionId>', 'Vendor-native session identifier')
    .option('--native-subagent <nativeSubagentId>', 'Vendor-native subagent identifier')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        project: string;
        agent: string;
        workingDirectory: string;
        heartbeatMs: string;
        status?: string;
        ungraceful?: boolean;
        nativeAdapter?: string;
        nativeSession?: string;
        nativeSubagent?: string;
        url: string;
      }) => {
        const native = parseNativeRef(options);
        return runSimulation(dependencies, {
          ...options,
          heartbeatMs: Number(options.heartbeatMs),
          ...(native === undefined ? {} : { native }),
        });
      },
    );
  const sessionBridge = sessions
    .command('bridge')
    .description('Simulate a daemon-only Session Bridge');
  sessionBridge
    .command('simulate')
    .requiredOption('--session <sessionId>', 'Existing online session ID')
    .requiredOption('--bridge-instance <id>', 'Stable bridge process identity')
    .option('--mode <mode>', 'manual, echo, or status-responder', 'manual')
    .option('--limit <count>', 'Maximum inbox items per claim', '10')
    .option('--block-ms <milliseconds>', 'Bounded claim block interval', '5000')
    .option('--min-idle-ms <milliseconds>', 'Pending recovery minimum idle time', '15000')
    .option('--heartbeat-ms <milliseconds>', 'Session heartbeat interval', '5000')
    .option('--include-content', 'Print complete simulated inbox payloads')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        session: string;
        bridgeInstance: string;
        mode: string;
        limit: string;
        blockMs: string;
        minIdleMs: string;
        heartbeatMs: string;
        includeContent?: boolean;
        url: string;
      }) => {
        if (
          options.mode !== 'manual' &&
          options.mode !== 'echo' &&
          options.mode !== 'status-responder'
        ) {
          throw new ApplicationError(
            'CLI_OPTION_INVALID',
            '--mode must be manual, echo, or status-responder.',
            400,
          );
        }
        const heartbeatMs = Number(options.heartbeatMs);
        if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100) {
          throw new ApplicationError(
            'CLI_OPTION_INVALID',
            '--heartbeat-ms must be an integer of at least 100.',
            400,
          );
        }
        await runBridgeSimulation(dependencies, {
          url: options.url,
          sessionId: options.session,
          bridgeInstanceId: options.bridgeInstance,
          mode: options.mode,
          limit: Number(options.limit),
          blockMs: Number(options.blockMs),
          minIdleMs: Number(options.minIdleMs),
          heartbeatMs,
          includeContent: options.includeContent === true,
        });
      },
    );
  sessionBridge
    .command('deepseek')
    .description('Run one experimental DeepSeek Harness ACP process as one LUWI session')
    .requiredOption('--project <projectId>', 'Registered project ID')
    .requiredOption('--agent <agentId>', 'Opaque agent ID')
    .requiredOption('--working-directory <path>', 'Absolute ACP session workspace')
    .requiredOption('--bridge-instance <id>', 'Stable bridge process identity')
    .requiredOption('--command <executable>', 'DeepSeek Harness ACP executable')
    .option('--args-json <json>', 'JSON string array passed directly to the ACP executable', '[]')
    .option('--permission <policy>', 'reject or allow-once', 'reject')
    .option('--limit <count>', 'Maximum inbox items per claim', '1')
    .option('--block-ms <milliseconds>', 'Bounded claim block interval', '5000')
    .option('--min-idle-ms <milliseconds>', 'Pending recovery minimum idle time', '15000')
    .option('--heartbeat-ms <milliseconds>', 'Session heartbeat interval', '5000')
    .option('--close-grace-ms <milliseconds>', 'ACP cooperative shutdown grace', '6000')
    .option('-u, --url <url>', 'LUWI daemon loopback origin', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        project: string;
        agent: string;
        workingDirectory: string;
        bridgeInstance: string;
        command: string;
        argsJson: string;
        permission: string;
        limit: string;
        blockMs: string;
        minIdleMs: string;
        heartbeatMs: string;
        closeGraceMs: string;
        url: string;
      }) => runDeepSeekBridge(dependencies, options),
    );
  sessionBridge
    .command('native <provider> [nativeArgs...]')
    .description(
      'Serve one agent inbox unattended by running Claude, Codex, Gemini, or Antigravity headless',
    )
    .option('--project <projectId>', 'Explicit registered project ID')
    .option('--agent-id <agentId>', 'Explicit LUWI AgentDefinition ID')
    .option('--working-directory <path>', 'Native agent working directory', dependencies.cwd())
    .option('--executable <path>', 'Explicit native agent executable')
    .option('--model <model>', 'Model the agent runs, recorded as session metadata')
    .option('--bridge-instance <id>', 'Stable inbox consumer identity', 'native-bridge')
    .option('--limit <count>', 'Maximum inbox items per claim', '1')
    .option('--block-ms <milliseconds>', 'Bounded claim block interval', '30000')
    .option('--min-idle-ms <milliseconds>', 'Pending recovery minimum idle time', '15000')
    .option('--heartbeat-ms <milliseconds>', 'Session heartbeat interval', '5000')
    .option('--lease-renew-ms <milliseconds>', 'Held work-lease renewal interval', '150000')
    .option('--connect-timeout-ms <milliseconds>', 'Per-request LUWI connection timeout', '2000')
    .option('-u, --url <url>', 'LUWI daemon loopback URL', 'http://127.0.0.1:4782')
    .action(
      async (
        providerValue: string,
        nativeArgs: string[] | undefined,
        options: {
          project?: string;
          agentId?: string;
          workingDirectory: string;
          executable?: string;
          model?: string;
          bridgeInstance: string;
          limit: string;
          blockMs: string;
          minIdleMs: string;
          heartbeatMs: string;
          leaseRenewMs: string;
          connectTimeoutMs: string;
          url: string;
        },
      ) =>
        runNativeBridge(dependencies, providerValue, nativeArgs ?? [], {
          ...(options.project === undefined ? {} : { project: options.project }),
          ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
          workingDirectory: options.workingDirectory,
          ...(options.executable === undefined ? {} : { executable: options.executable }),
          ...(options.model === undefined ? {} : { model: options.model }),
          bridgeInstance: options.bridgeInstance,
          limit: positiveIntegerOption(options.limit, '--limit', 1, INBOX_MAX_CLAIM_LIMIT),
          blockMs: positiveIntegerOption(options.blockMs, '--block-ms', 0, MESSAGE_MAX_WAIT_MS),
          minIdleMs: positiveIntegerOption(options.minIdleMs, '--min-idle-ms', 0, 86_400_000),
          heartbeatMs: positiveIntegerOption(options.heartbeatMs, '--heartbeat-ms', 100, 10_000),
          leaseRenewMs: positiveIntegerOption(
            options.leaseRenewMs,
            '--lease-renew-ms',
            1_000,
            3_600_000,
          ),
          connectTimeoutMs: positiveIntegerOption(
            options.connectTimeoutMs,
            '--connect-timeout-ms',
            100,
            30_000,
          ),
          url: options.url,
        }),
    );

  const messages = program.command('message').description('Exchange durable session messages');
  messages
    .command('ask')
    .requiredOption('--source <sessionId>', 'Source session ID')
    .option('--target-session <sessionId>', 'Direct target session ID')
    .option('--target-agent <agentId>', 'Select an online session for this opaque agent ID')
    .requiredOption('--kind <kind>', 'question, status_request, or instruction')
    .option('--subject <subject>', 'Short subject')
    .requiredOption('--content <content>', 'Question or instruction')
    .option('--evidence <types>', 'Comma-separated evidence requirements')
    .option('--timeout-ms <milliseconds>', 'Message deadline')
    .option('--idempotency-key <key>', 'Retry idempotency key')
    .option('--wait-ms <milliseconds>', 'Wait up to 30000 ms for terminal state', '0')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        source: string;
        targetSession?: string;
        targetAgent?: string;
        kind: string;
        subject?: string;
        content: string;
        evidence?: string;
        timeoutMs?: string;
        idempotencyKey?: string;
        waitMs: string;
        url: string;
      }) => {
        const result = await request(
          dependencies,
          options.url,
          '/api/v1/messages',
          messageCreateResponseSchema,
          jsonBodyWithHeaders(
            {
              sourceSessionId: options.source,
              ...(options.targetSession === undefined
                ? {}
                : { targetSessionId: options.targetSession }),
              ...(options.targetAgent === undefined ? {} : { targetAgentId: options.targetAgent }),
              kind: messageKindSchema.parse(options.kind),
              ...(options.subject === undefined ? {} : { subject: options.subject }),
              content: options.content,
              evidenceRequirements: parseEvidenceRequirements(options.evidence),
              ...(options.timeoutMs === undefined ? {} : { timeoutMs: Number(options.timeoutMs) }),
            },
            options.idempotencyKey === undefined
              ? {}
              : { 'idempotency-key': options.idempotencyKey },
          ),
        );
        const waitMs = Number(options.waitMs);
        if (waitMs > 0) {
          printJson(
            dependencies,
            await request(
              dependencies,
              options.url,
              `/api/v1/messages/${encodeURIComponent(result.message.correlationId)}/wait?waitMs=${encodeURIComponent(String(waitMs))}`,
              messageResponseSchema,
            ),
          );
          return;
        }
        printJson(dependencies, result);
      },
    );
  messages
    .command('list')
    .option('--project <projectId>', 'Filter by project')
    .option('--source <sessionId>', 'Filter by source session')
    .option('--target <sessionId>', 'Filter by target session')
    .option('--state <state>', 'Filter by message state')
    .option('--limit <count>', 'Maximum result count', '100')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        project?: string;
        source?: string;
        target?: string;
        state?: string;
        limit: string;
        url: string;
      }) => {
        // A state outside the vocabulary is the caller's mistake, named as
        // such: `parse` would throw a ZodError that the entry point reports as
        // INTERNAL_ERROR, which reads as a daemon fault (an agent asking for
        // `pending` concluded the runtime was unreachable).
        const state =
          options.state === undefined ? undefined : messageStateSchema.safeParse(options.state);
        if (state !== undefined && !state.success) {
          throw new ApplicationError(
            'CLI_OPTION_INVALID',
            `--state must be one of ${messageStateSchema.options.join(', ')}.`,
            400,
          );
        }
        const query = new URLSearchParams({
          limit: options.limit,
          ...(options.project === undefined ? {} : { projectId: options.project }),
          ...(options.source === undefined ? {} : { sourceSessionId: options.source }),
          ...(options.target === undefined ? {} : { targetSessionId: options.target }),
          ...(state === undefined ? {} : { state: state.data }),
        });
        printJson(
          dependencies,
          await request(
            dependencies,
            options.url,
            `/api/v1/messages?${query.toString()}`,
            messageCollectionResponseSchema,
          ),
        );
      },
    );
  messages
    .command('get <correlationId>')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (correlationId: string, options: { url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/messages/${encodeURIComponent(correlationId)}`,
          messageResponseSchema,
        ),
      );
    });
  messages
    .command('await <correlationId>')
    .option('--wait-ms <milliseconds>', 'Wait up to 30000 ms', '30000')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (correlationId: string, options: { waitMs: string; url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/messages/${encodeURIComponent(correlationId)}/wait?waitMs=${encodeURIComponent(options.waitMs)}`,
          messageResponseSchema,
        ),
      );
    });
  for (const action of ['acknowledge', 'processing'] as const) {
    messages
      .command(`${action} <correlationId>`)
      .requiredOption('--session <sessionId>', 'Responder session ID')
      .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
      .action(async (correlationId: string, options: { session: string; url: string }) => {
        printJson(
          dependencies,
          await request(
            dependencies,
            options.url,
            `/api/v1/messages/${encodeURIComponent(correlationId)}/${action}`,
            messageResponseSchema,
            jsonBody({ responderSessionId: options.session }),
          ),
        );
      });
  }
  for (const action of ['respond', 'reject', 'fail'] as const) {
    messages
      .command(`${action} <correlationId>`)
      .requiredOption('--session <sessionId>', 'Responder session ID')
      .requiredOption('--answer <text>', 'Response answer')
      .option('--confidence <value>', 'Optional confidence from 0 to 1')
      .option('--evidence <json>', 'Evidence JSON array', '[]')
      .option('--verified-at <timestamp>', 'UTC verification timestamp')
      .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
      .action(
        async (
          correlationId: string,
          options: {
            session: string;
            answer: string;
            confidence?: string;
            evidence: string;
            verifiedAt?: string;
            url: string;
          },
        ) => {
          const status =
            action === 'respond' ? 'answered' : action === 'reject' ? 'rejected' : 'failed';
          const response = agentMessageResponseSchema.parse({
            status,
            answer: options.answer,
            ...(options.confidence === undefined ? {} : { confidence: Number(options.confidence) }),
            evidence: parseJsonArray(options.evidence, '--evidence'),
            verifiedAt: options.verifiedAt ?? new Date().toISOString(),
          });
          printJson(
            dependencies,
            await request(
              dependencies,
              options.url,
              `/api/v1/messages/${encodeURIComponent(correlationId)}/${action}`,
              messageResponseSchema,
              jsonBody({ responderSessionId: options.session, response }),
            ),
          );
        },
      );
  }

  const inbox = program.command('inbox').description('Claim durable session inbox work');
  inbox
    .command('claim')
    .requiredOption('--session <sessionId>', 'Session inbox owner')
    .requiredOption('--bridge-instance <id>', 'Stable bridge process identity')
    .option('--limit <count>', 'Maximum inbox items')
    .option('--block-ms <milliseconds>', 'Bounded blocking read')
    .option('--min-idle-ms <milliseconds>', 'Pending recovery minimum idle time')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        session: string;
        bridgeInstance: string;
        limit?: string;
        blockMs?: string;
        minIdleMs?: string;
        url: string;
      }) => {
        printJson(
          dependencies,
          await request(
            dependencies,
            options.url,
            `/api/v1/sessions/${encodeURIComponent(options.session)}/inbox/claim`,
            inboxClaimResponseSchema,
            jsonBody({
              bridgeInstanceId: options.bridgeInstance,
              ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
              ...(options.blockMs === undefined ? {} : { blockMs: Number(options.blockMs) }),
              ...(options.minIdleMs === undefined ? {} : { minIdleMs: Number(options.minIdleMs) }),
            }),
          ),
        );
      },
    );

  const leases = program.command('lease').description('Hold and inspect advisory work leases');
  leases
    .command('acquire')
    .requiredOption('--project <projectId>', 'Project ID')
    .requiredOption('--session <sessionId>', 'Holding session ID')
    .requiredOption('--path <path>', 'Project-relative path to claim')
    .requiredOption('--reason <reason>', 'Why the path is held')
    .option('--duration-ms <milliseconds>', 'Lease duration in milliseconds')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        project: string;
        session: string;
        path: string;
        reason: string;
        durationMs?: string;
        url: string;
      }) => {
        printJson(
          dependencies,
          await request(
            dependencies,
            options.url,
            '/api/v1/leases',
            leaseAcquireResponseSchema,
            jsonBody({
              projectId: options.project,
              sessionId: options.session,
              path: options.path,
              reason: options.reason,
              ...(options.durationMs === undefined
                ? {}
                : { durationMs: Number(options.durationMs) }),
            }),
          ),
        );
      },
    );
  leases
    .command('renew <leaseId>')
    .requiredOption('--session <sessionId>', 'Holding session ID')
    .option('--duration-ms <milliseconds>', 'Lease duration in milliseconds')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (leaseId: string, options: { session: string; durationMs?: string; url: string }) => {
        printJson(
          dependencies,
          await request(
            dependencies,
            options.url,
            `/api/v1/leases/${encodeURIComponent(leaseId)}/renew`,
            workLeaseSchema,
            jsonBody({
              sessionId: options.session,
              ...(options.durationMs === undefined
                ? {}
                : { durationMs: Number(options.durationMs) }),
            }),
          ),
        );
      },
    );
  leases
    .command('release <leaseId>')
    .requiredOption('--session <sessionId>', 'Holding session ID')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (leaseId: string, options: { session: string; url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/leases/${encodeURIComponent(leaseId)}/release`,
          workLeaseSchema,
          jsonBody({ sessionId: options.session }),
        ),
      );
    });
  leases
    .command('list')
    .option('--project <projectId>', 'Filter by project')
    .option('--session <sessionId>', 'Filter by holding session')
    .option('--limit <count>', 'Maximum result count', '100')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (options: { project?: string; session?: string; limit: string; url: string }) => {
      const query = new URLSearchParams({
        limit: options.limit,
        ...(options.project === undefined ? {} : { projectId: options.project }),
        ...(options.session === undefined ? {} : { sessionId: options.session }),
      });
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/leases?${query.toString()}`,
          leaseCollectionSchema,
        ),
      );
    });
  leases
    .command('get <leaseId>')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (leaseId: string, options: { url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/leases/${encodeURIComponent(leaseId)}`,
          workLeaseSchema,
        ),
      );
    });

  const events = program.command('events').description('Inspect Runtime events');
  events
    .command('list')
    .option('-l, --limit <limit>', 'Newest event count', '100')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(async (options: { limit: string; url: string }) => {
      printJson(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/events?limit=${encodeURIComponent(options.limit)}`,
          eventListResponseSchema,
        ),
      );
    });
  events
    .command('watch')
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action((options: { url: string }) => watchEvents(dependencies, options));

  return program;
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: Partial<CliDependencies> = {},
): Promise<void> {
  const program = createCli({ ...defaultDependencies, ...dependencies });
  await program.parseAsync([...arguments_], { from: 'user' });
}
