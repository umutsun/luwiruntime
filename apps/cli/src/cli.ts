import {
  agentMessageResponseSchema,
  evidenceTypeSchema,
  eventListResponseSchema,
  heartbeatResponseSchema,
  inboxClaimResponseSchema,
  leaseAcquireResponseSchema,
  leaseCollectionSchema,
  LUWI_RUNTIME_VERSION,
  messageCollectionResponseSchema,
  messageCreateResponseSchema,
  messageKindSchema,
  messageResponseSchema,
  messageStateSchema,
  nativeSessionRefSchema,
  projectCollectionResponseSchema,
  projectResponseSchema,
  publicErrorResponseSchema,
  realtimeEventMessageSchema,
  runtimeInfoResponseSchema,
  sessionCollectionResponseSchema,
  sessionResponseSchema,
  sessionStatusTargetSchema,
  workLeaseSchema,
  type AgentMessage,
  type InboxEnvelope,
  type NativeSessionRef,
  type RealtimeEventMessage,
} from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';

import { registerControlPlaneCli } from './control-plane-cli.js';
import { registerIntelligenceCli } from './intelligence-cli.js';

export type FetchInitLike = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
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
  wait: (milliseconds: number) => Promise<void>;
  confirm: (prompt: string) => Promise<boolean>;
};

const defaultDependencies: CliDependencies = {
  fetch: (url, init) => fetch(url, init as RequestInit),
  createWebSocket: (url) => new WebSocket(url) as unknown as CliWebSocket,
  signals: process,
  stdout: process.stdout,
  stderr: process.stderr,
  setInterval,
  clearInterval,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  confirm: async (prompt) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await terminal.question(`${prompt} [y/N] `)).trim().toLowerCase() === 'y';
    } finally {
      terminal.close();
    }
  },
};

type Parser<Output> = { parse(value: unknown): Output };

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

export function createCli(dependencies: CliDependencies): Command {
  const program = new Command()
    .name('luwi')
    .description('Inspect and operate the local LUWI Runtime daemon')
    .version(LUWI_RUNTIME_VERSION);

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

  registerControlPlaneCli(program, projects, dependencies);
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
        const query = new URLSearchParams({
          limit: options.limit,
          ...(options.project === undefined ? {} : { projectId: options.project }),
          ...(options.source === undefined ? {} : { sourceSessionId: options.source }),
          ...(options.target === undefined ? {} : { targetSessionId: options.target }),
          ...(options.state === undefined
            ? {}
            : { state: messageStateSchema.parse(options.state) }),
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
