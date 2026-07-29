import {
  eventListResponseSchema,
  heartbeatResponseSchema,
  LUWI_RUNTIME_VERSION,
  projectCollectionResponseSchema,
  projectResponseSchema,
  publicErrorResponseSchema,
  realtimeEventMessageSchema,
  runtimeInfoResponseSchema,
  sessionCollectionResponseSchema,
  sessionResponseSchema,
  sessionStatusTargetSchema,
  type RealtimeEventMessage,
} from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import { Command } from 'commander';

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
        url: string;
      }) => {
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
    .option('-u, --url <url>', 'LUWI daemon base URL', 'http://127.0.0.1:4782')
    .action(
      async (options: {
        project: string;
        agent: string;
        workingDirectory: string;
        heartbeatMs: string;
        status?: string;
        ungraceful?: boolean;
        url: string;
      }) =>
        runSimulation(dependencies, {
          ...options,
          heartbeatMs: Number(options.heartbeatMs),
        }),
    );

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
