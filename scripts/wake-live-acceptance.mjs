#!/usr/bin/env node

/* global AbortController, AbortSignal */

/**
 * Live acceptance for the event-driven wake dispatcher.
 *
 * The run owns a disposable Git project, one isolated daemon, one Redis key
 * namespace, and one Redis Function library. It starts the built `wake serve`
 * command and lets that production path resolve the registered Codex
 * executable, acquire its bridge slot, launch a workspace-write Codex worker,
 * and receive the worker response through the session-bound MCP server.
 *
 * A full pass additionally creates a new disposable persistent Codex thread,
 * binds only that thread to the isolated coordinator session, and observes the
 * production dispatcher queue an exact-thread continuation. If the installed
 * host cannot create or wake that disposable thread, the data-plane proof is
 * retained but the result is `partial` and exits non-zero. This script never
 * targets the invoking Codex thread.
 */

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const EXPECTED_REDIS_URL = 'redis://127.0.0.1:6391';
const EXPECTED_REDIS_HOST = '127.0.0.1';
const EXPECTED_REDIS_PORT = 6391;
const HTTP_TIMEOUT_MS = 10_000;
const PROCESS_TIMEOUT_MS = 180_000;
const WORKER_TIMEOUT_MS = 300_000;
const CONTINUATION_TIMEOUT_MS = 180_000;
const MARKER_FILE = '.luwi-wake-acceptance-owner.json';
const RUN_PREFIX = 'wake-acceptance-';
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_SYSTEM_ENVIRONMENT_KEYS = [
  'COMSPEC',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'SYSTEMROOT',
  'TZ',
  'WINDIR',
];
const CODEX_HOME_ENVIRONMENT_KEYS = [
  'APPDATA',
  'CODEX_HOME',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
];
const CODEX_PROVIDER_ENVIRONMENT_KEYS = [
  'ALL_PROXY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_ENDPOINT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'OPENAI_PROJECT_ID',
];

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assert(condition, code) {
  if (!condition) throw failure(code);
}

function parseArguments(argv) {
  const result = {};
  const names = new Map([
    ['--redis-url', 'redisUrl'],
    ['--workspace', 'workspace'],
    ['--codex-executable', 'codexExecutable'],
    ['--git-executable', 'gitExecutable'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help') return { help: true };
    const key = names.get(name);
    if (key === undefined) throw failure('ARGUMENT_INVALID');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw failure('ARGUMENT_INVALID');
    result[key] = value;
    index += 1;
  }
  if (
    typeof result.redisUrl !== 'string' ||
    typeof result.workspace !== 'string' ||
    typeof result.codexExecutable !== 'string' ||
    typeof result.gitExecutable !== 'string'
  ) {
    throw failure('ARGUMENT_REQUIRED');
  }
  return result;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/wake-live-acceptance.mjs --redis-url redis://127.0.0.1:6391 --workspace <absolute-directory> --codex-executable <absolute-codex.exe> --git-executable <absolute-git.exe>',
    '',
    'The Redis target must be the dedicated acceptance instance on 127.0.0.1:6391.',
    'The Codex executable must be an explicit installed codex.exe; PATH discovery is refused.',
    'The Git executable must be an explicit absolute git executable; PATH discovery is refused.',
  ].join('\n');
}

function assertSafeRedisUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw failure('REDIS_TARGET_REFUSED');
  }
  if (
    value !== EXPECTED_REDIS_URL ||
    parsed.protocol !== 'redis:' ||
    parsed.hostname !== EXPECTED_REDIS_HOST ||
    parsed.port !== String(EXPECTED_REDIS_PORT) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw failure('REDIS_TARGET_REFUSED');
  }
  return value;
}

function assertSafeWorkspace(value) {
  if (!isAbsolute(value)) throw failure('WORKSPACE_MUST_BE_ABSOLUTE');
  const resolved = resolve(value);
  if (resolved === resolve(parse(resolved).root)) throw failure('WORKSPACE_ROOT_REFUSED');
  return resolved;
}

async function canonicalCodexExecutable(value) {
  if (!isAbsolute(value)) throw failure('CODEX_EXECUTABLE_MUST_BE_ABSOLUTE');
  let canonical;
  try {
    canonical = await realpath(value);
  } catch {
    throw failure('CODEX_EXECUTABLE_NOT_FOUND');
  }
  const expected = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (basename(canonical).toLowerCase() !== expected) {
    throw failure('CODEX_EXECUTABLE_REFUSED');
  }
  return canonical;
}

async function canonicalGitExecutable(value) {
  if (!isAbsolute(value)) throw failure('GIT_EXECUTABLE_MUST_BE_ABSOLUTE');
  let canonical;
  try {
    canonical = await realpath(value);
  } catch {
    throw failure('GIT_EXECUTABLE_NOT_FOUND');
  }
  const expected = process.platform === 'win32' ? 'git.exe' : 'git';
  if (basename(canonical).toLowerCase() !== expected) throw failure('GIT_EXECUTABLE_REFUSED');
  return canonical;
}

function inside(root, candidate) {
  const part = relative(root, candidate);
  return part !== '' && !part.startsWith('..') && !isAbsolute(part);
}

function throwIfAborted(signal) {
  if (signal.aborted) throw failure('RUN_INTERRUPTED');
}

function combinedSignal(signal, timeoutMs) {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, EXPECTED_REDIS_HOST, resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw failure('PORT_RESERVATION_FAILED');
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

async function loopbackPortIsClosed(port) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: EXPECTED_REDIS_HOST, port });
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(closed);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => {
      finish(
        typeof error === 'object' &&
          error !== null &&
          Reflect.get(error, 'code') === 'ECONNREFUSED',
      );
    });
  });
}

async function http(baseUrl, method, path, body, expected, runSignal) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: combinedSignal(runSignal, HTTP_TIMEOUT_MS),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw failure('DAEMON_HTTP_UNAVAILABLE');
  }
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw === '' ? {} : JSON.parse(raw);
  } catch {
    throw failure('DAEMON_HTTP_RESPONSE_INVALID');
  }
  const accepted = expected ?? [200];
  if (!accepted.includes(response.status)) {
    const code = parsed?.error?.code;
    throw failure(typeof code === 'string' && SAFE_CODE.test(code) ? code : 'DAEMON_HTTP_REJECTED');
  }
  return { status: response.status, raw, body: parsed };
}

async function eventually(read, accept, timeoutMs, signal, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const value = await read();
    if (accept(value)) return value;
    await delay(100, undefined, { signal }).catch(() => {
      throw failure('RUN_INTERRUPTED');
    });
  }
  throw failure(code);
}

function appendBounded(current, chunk) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
    throw failure('PROCESS_OUTPUT_LIMIT_EXCEEDED');
  }
  return next;
}

let windowsCleanupDependencies;

function environmentValue(source, requestedKey) {
  const normalized = requestedKey.toUpperCase();
  const matches = Object.entries(source).filter(([key, value]) => {
    return key.toUpperCase() === normalized && typeof value === 'string' && value !== '';
  });
  if (new Set(matches.map(([, value]) => value)).size > 1) {
    throw failure('ENVIRONMENT_KEY_AMBIGUOUS');
  }
  return matches[0]?.[1];
}

function selectEnvironment(source, keys) {
  const environment = {};
  for (const key of keys) {
    const value = environmentValue(source, key);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function controlledPath(codexExecutable, gitExecutable, source) {
  const paths = [dirname(gitExecutable), dirname(codexExecutable), dirname(process.execPath)];
  const systemRoot = environmentValue(source, 'SYSTEMROOT') ?? environmentValue(source, 'WINDIR');
  if (systemRoot !== undefined) paths.push(join(systemRoot, 'System32'), systemRoot);
  return [...new Set(paths.map((entry) => resolve(entry)))].join(
    process.platform === 'win32' ? ';' : ':',
  );
}

function createNodeEnvironment(source, codexExecutable, gitExecutable, privateHome, privateTemp) {
  return {
    ...selectEnvironment(source, SAFE_SYSTEM_ENVIRONMENT_KEYS),
    PATH: controlledPath(codexExecutable, gitExecutable, source),
    HOME: privateHome,
    USERPROFILE: privateHome,
    APPDATA: join(privateHome, 'appdata'),
    LOCALAPPDATA: join(privateHome, 'local-appdata'),
    XDG_CACHE_HOME: join(privateHome, 'cache'),
    XDG_CONFIG_HOME: join(privateHome, 'config'),
    XDG_DATA_HOME: join(privateHome, 'data'),
    TEMP: privateTemp,
    TMP: privateTemp,
    TMPDIR: privateTemp,
  };
}

function createGitEnvironment(nodeEnvironment, privateHome) {
  return {
    ...nodeEnvironment,
    GIT_CONFIG_GLOBAL: join(privateHome, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function createCodexEnvironment(source, nodeEnvironment, includeProviderAuthentication) {
  return {
    ...nodeEnvironment,
    ...selectEnvironment(source, CODEX_HOME_ENVIRONMENT_KEYS),
    ...(includeProviderAuthentication
      ? selectEnvironment(source, CODEX_PROVIDER_ENVIRONMENT_KEYS)
      : selectEnvironment(source, ['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'])),
  };
}

function applyProcessEnvironment(environment) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
}

async function verifiedWindowsTreeCleanup(record) {
  try {
    windowsCleanupDependencies ??= (async () => {
      const adapters = await import('../packages/adapters/dist/index.js');
      const utilities = await adapters.resolveTrustedWindowsUtilities(process.env);
      const helperEnvironment = { ...process.env };
      return {
        cleaner: new adapters.WindowsOwnedProcessTreeCleaner(
          new adapters.NodeWindowsProcessTreeIo((command, arguments_, options) =>
            spawn(command, arguments_, { ...options, env: helperEnvironment }),
          ),
        ),
        utilities,
      };
    })();
    const { cleaner, utilities } = await windowsCleanupDependencies;
    const result = await cleaner.cleanup({
      rootPid: record.child.pid,
      rootParentPid: record.rootParentPid,
      rootExecutableName: record.rootExecutableName,
      rootSpawnedAtMs: record.rootSpawnedAtMs,
      rootObservedBeforeMs: record.rootObservedBeforeMs,
      ...(record.rootCanonicalExecutablePath === undefined
        ? {}
        : { rootCanonicalExecutablePath: record.rootCanonicalExecutablePath }),
      taskkillPath: utilities.taskkillPath,
      powershellPath: utilities.powershellPath,
      timeoutMs: 15_000,
    });
    if (!result.cleaned) return false;
    return Promise.race([record.exit.then(() => true), delay(5_000).then(() => false)]);
  } catch {
    return false;
  }
}

function spawnObserved(command, arguments_, options, activeChildren) {
  const rootSpawnedAtMs = Date.now();
  const child = spawn(command, [...arguments_], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rootObservedBeforeMs = Date.now();
  const record = {
    child,
    rootParentPid: process.pid,
    rootExecutableName: basename(command),
    rootSpawnedAtMs,
    rootObservedBeforeMs,
    rootCanonicalExecutablePath: isAbsolute(command) ? resolve(command) : undefined,
    verifyTreeCleanup: options.verifyTreeCleanup === true,
    stdout: '',
    stderr: '',
    outputFailure: undefined,
    exit: undefined,
    stop: undefined,
  };
  activeChildren.add(record);
  child.stdout?.on('data', (chunk) => {
    try {
      record.stdout = appendBounded(record.stdout, chunk);
      options.observeStdout?.(record.stdout);
    } catch (error) {
      record.outputFailure = error;
      void stopObserved(record);
    }
  });
  child.stderr?.on('data', (chunk) => {
    try {
      record.stderr = appendBounded(record.stderr, chunk);
    } catch (error) {
      record.outputFailure = error;
      void stopObserved(record);
    }
  });
  record.exit = new Promise((resolveExit) => {
    child.once('error', () => resolveExit({ code: null, signal: null, spawnError: true }));
    child.once('close', (code, signal) => resolveExit({ code, signal, spawnError: false }));
  }).finally(() => activeChildren.delete(record));
  return record;
}

async function stopObserved(record) {
  if (record === undefined) return true;
  if (record.stop !== undefined) return record.stop;
  record.stop = (async () => {
    if (record.child.exitCode !== null || record.child.signalCode !== null) {
      await record.exit;
      return !record.verifyTreeCleanup;
    }
    if (process.platform === 'win32') {
      if (record.child.pid === undefined) return false;
      return verifiedWindowsTreeCleanup(record);
    }
    try {
      record.child.kill('SIGTERM');
    } catch {
      return false;
    }
    const graceful = await Promise.race([
      record.exit.then(() => true),
      delay(10_000).then(() => false),
    ]);
    if (graceful) return true;
    try {
      record.child.kill('SIGKILL');
    } catch {
      return false;
    }
    return Promise.race([record.exit.then(() => true), delay(5_000).then(() => false)]);
  })();
  return record.stop;
}

async function runCaptured(command, arguments_, options, activeChildren, runSignal) {
  throwIfAborted(runSignal);
  const record = spawnObserved(command, arguments_, options, activeChildren);
  const timeoutController = new AbortController();
  let resolveAbort = () => undefined;
  const aborted = new Promise((resolveAbortPromise) => {
    resolveAbort = () => resolveAbortPromise({ kind: 'aborted' });
  });
  runSignal.addEventListener('abort', resolveAbort, { once: true });
  try {
    const selected = await Promise.race([
      record.exit.then((outcome) => ({ kind: 'exit', outcome })),
      delay(
        options.timeoutMs ?? PROCESS_TIMEOUT_MS,
        { kind: 'timeout' },
        {
          signal: timeoutController.signal,
        },
      ).catch(() => ({ kind: 'cancelled' })),
      aborted,
    ]);
    if (selected.kind !== 'exit') {
      await stopObserved(record);
      if (selected.kind === 'aborted') throw failure('RUN_INTERRUPTED');
      throw failure(options.timeoutCode ?? 'PROCESS_TIMEOUT');
    }
    const { outcome } = selected;
    if (record.outputFailure !== undefined) throw record.outputFailure;
    if (outcome.spawnError) throw failure(options.failureCode ?? 'PROCESS_START_FAILED');
    return { ...outcome, stdout: record.stdout, stderr: record.stderr };
  } finally {
    timeoutController.abort();
    runSignal.removeEventListener('abort', resolveAbort);
  }
}

async function runRequired(command, arguments_, options, activeChildren, runSignal) {
  const result = await runCaptured(command, arguments_, options, activeChildren, runSignal);
  if (result.code !== 0 || result.signal !== null) {
    throw failure(options.failureCode ?? 'PROCESS_FAILED');
  }
  return result.stdout.trim();
}

function processFailureCode(error, fallback) {
  if (typeof error === 'object' && error !== null) {
    const value = Reflect.get(error, 'code');
    if (typeof value === 'string' && SAFE_CODE.test(value)) return value;
    const message = Reflect.get(error, 'message');
    if (typeof message === 'string' && SAFE_CODE.test(message)) return message;
  }
  return fallback;
}

function toml(value) {
  return JSON.stringify(value);
}

function coordinatorArguments(input) {
  const tools = ['luwi_get_message', 'luwi_continue_workflow'];
  return [
    '-a',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--strict-config',
    '-c',
    'sandbox_workspace_write.writable_roots=[]',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    `mcp_servers.luwi-runtime.command=${toml(input.nodeExecutable)}`,
    '-c',
    `mcp_servers.luwi-runtime.args=[${toml(input.mcpServerEntry)}]`,
    '-c',
    `mcp_servers.luwi-runtime.enabled_tools=[${tools.map(toml).join(',')}]`,
    '-c',
    'mcp_servers.luwi-runtime.default_tools_approval_mode="prompt"',
    '-c',
    'mcp_servers.luwi-runtime.tools.luwi_get_message.approval_mode="approve"',
    '-c',
    'mcp_servers.luwi-runtime.tools.luwi_continue_workflow.approval_mode="approve"',
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_SESSION_ID=${toml(input.sessionId)}`,
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_DAEMON_URL=${toml(input.daemonUrl)}`,
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--json',
    '-C',
    input.projectDirectory,
    [
      'This is a disposable LUWI wake-acceptance coordinator thread.',
      'Reply READY and end this first turn without calling tools.',
      'For every later queued LUWI wake pointer in this acceptance run, call luwi_get_message',
      'with the supplied correlationId, then call luwi_continue_workflow for the supplied',
      'workflowId with expectedRevision 1, the supplied wakeIntentId as wake proof, and a',
      'complete decision. Do not inspect or edit files and do not perform any other work.',
    ].join(' '),
  ];
}

function parseThreadId(jsonLines) {
  for (const line of jsonLines.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line);
      if (
        event?.type === 'thread.started' &&
        typeof event.thread_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(event.thread_id)
      ) {
        return event.thread_id;
      }
    } catch {
      // Non-JSON diagnostics make this optional host capability unavailable.
    }
  }
  return undefined;
}

function normalizeScan(reply) {
  if (Array.isArray(reply) && reply.length === 2 && Array.isArray(reply[1])) {
    return { cursor: String(reply[0]), keys: reply[1].map(String) };
  }
  if (typeof reply === 'object' && reply !== null) {
    const cursor = Reflect.get(reply, 'cursor');
    const keys = Reflect.get(reply, 'keys');
    if ((typeof cursor === 'number' || typeof cursor === 'string') && Array.isArray(keys)) {
      return { cursor: String(cursor), keys: keys.map(String) };
    }
  }
  throw failure('REDIS_SCAN_RESPONSE_INVALID');
}

async function scanNamespace(connection, namespace) {
  const found = [];
  let cursor = '0';
  do {
    const page = normalizeScan(
      await connection.sendCommand(['SCAN', cursor, 'MATCH', `${namespace}:*`, 'COUNT', '100']),
    );
    cursor = page.cursor;
    found.push(...page.keys);
  } while (cursor !== '0');
  return found;
}

async function removeNamespace(connection, namespace) {
  let keys = await scanNamespace(connection, namespace);
  while (keys.length > 0) {
    await connection.sendCommand(['DEL', ...keys]);
    keys = await scanNamespace(connection, namespace);
  }
  assert((await scanNamespace(connection, namespace)).length === 0, 'REDIS_NAMESPACE_REMAINS');
}

function groupFields(value) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
  if (!Array.isArray(value) || value.length % 2 !== 0) return {};
  const result = {};
  for (let index = 0; index < value.length; index += 2) {
    result[String(value[index])] = value[index + 1];
  }
  return result;
}

async function recreateWakeGroupAtZero(connection, wakeStream, consumerGroup) {
  const destroyed = Number(
    await connection.sendCommand(['XGROUP', 'DESTROY', wakeStream, consumerGroup]),
  );
  assert(destroyed === 1, 'WAKE_GROUP_DESTROY_FAILED');
  const created = await connection.sendCommand([
    'XGROUP',
    'CREATE',
    wakeStream,
    consumerGroup,
    '0-0',
  ]);
  assert(created === 'OK', 'WAKE_GROUP_CREATE_FAILED');
  const groups = await connection.sendCommand(['XINFO', 'GROUPS', wakeStream]);
  assert(Array.isArray(groups), 'WAKE_GROUP_INFO_INVALID');
  const group = groups.map(groupFields).find((candidate) => candidate.name === consumerGroup);
  assert(group?.['last-delivered-id'] === '0-0', 'WAKE_GROUP_NOT_AT_ZERO');
}

async function pathExists(value) {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function buildArtifactDigest(repositoryRoot) {
  const roots = [
    ['apps', 'cli', 'dist'],
    ['apps', 'daemon', 'dist'],
    ['apps', 'mcp-server', 'dist'],
    ['packages', 'adapters', 'dist'],
    ['packages', 'protocol', 'dist'],
    ['packages', 'redis', 'dist'],
    ['packages', 'runtime', 'dist'],
  ];
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      if (entry.isFile()) files.push(candidate);
    }
  };
  for (const parts of roots) await visit(join(repositoryRoot, ...parts));
  files.sort((left, right) => left.localeCompare(right, 'en'));
  assert(files.length > 0, 'DIST_ARTIFACTS_MISSING');
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(repositoryRoot, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), fileCount: files.length };
}

async function main() {
  let parsedArguments;
  try {
    parsedArguments = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ schemaVersion: 2, status: 'failed', failureCode: processFailureCode(error, 'ARGUMENT_INVALID') })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (parsedArguments.help === true) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const hostEnvironment = { ...process.env };
  const startedAt = new Date().toISOString();
  const runId = randomUUID().replaceAll('-', '');
  const runController = new AbortController();
  const activeChildren = new Set();
  const cleanupErrors = [];
  const partialReasons = [];
  const cleanupEvidence = {
    daemonStopped: false,
    wakeServeStopped: false,
    redisNamespaceRemoved: false,
    functionRemoved: false,
    runDirectoryRemoved: false,
    coordinatorThreadCreationAttempted: false,
    coordinatorThreadCreationUncertain: false,
    coordinatorThreadDeleted: false,
  };
  let stage = 'arguments';
  let workspaceRoot;
  let runDirectory;
  let markerPath;
  let projectDirectory;
  let luwiHome;
  let nativeHome;
  let privateEnvironmentHome;
  let privateEnvironmentTemp;
  let redisUrl;
  let codexExecutable;
  let gitExecutable;
  let registeredWorkerExecutable;
  let registeredCoordinatorExecutable;
  let repositoryRoot;
  let cliEntry;
  let mcpServerEntry;
  let redis;
  let keys;
  let registry;
  let cleanupConnection;
  let runtime;
  let baseUrl;
  let daemonPort;
  let wakeServe;
  let coordinatorThreadId;
  let coordinatorThreadCreationAttempted = false;
  let coordinatorThreadCreationUncertain = false;
  let coordinatorSessionId;
  let heartbeatTimer;
  let cleanupPromise;
  let finalEvidence;
  let runFailure;
  let sourceHead;
  let sourceTreeClean;
  let sourceHeadStable;
  let runtimeBuildReproducible;
  let firstRuntimeDistDigest;
  let runtimeDistDigest;
  let observedRedisFunctionVersion;
  let nativeIdentityRedactionObserved = false;
  let nodeEnvironment;
  let gitEnvironment;
  let codexEnvironment;
  let wakeServeEnvironment;
  let codexDetectedVersion;

  const onSignal = () => runController.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const cleanup = () => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = (async () => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);

      if (wakeServe !== undefined) {
        try {
          cleanupEvidence.wakeServeStopped = await stopObserved(wakeServe);
          if (!cleanupEvidence.wakeServeStopped) cleanupErrors.push('WAKE_SERVE_STOP_UNVERIFIED');
        } catch {
          cleanupErrors.push('WAKE_SERVE_STOP_FAILED');
        }
      } else {
        cleanupEvidence.wakeServeStopped = true;
      }

      for (const record of [...activeChildren]) {
        try {
          if (!(await stopObserved(record))) cleanupErrors.push('CHILD_PROCESS_STOP_UNVERIFIED');
        } catch {
          cleanupErrors.push('CHILD_PROCESS_STOP_FAILED');
        }
      }

      if (runtime !== undefined) {
        try {
          await runtime.shutdown.shutdown('SIGTERM');
          runtime.shutdown.dispose();
          cleanupEvidence.daemonStopped = runtime.runtimeState() === 'stopped';
          if (!cleanupEvidence.daemonStopped) cleanupErrors.push('DAEMON_STOP_UNVERIFIED');
        } catch {
          cleanupErrors.push('DAEMON_STOP_FAILED');
        }
      } else {
        cleanupEvidence.daemonStopped = true;
      }
      if (
        daemonPort !== undefined &&
        cleanupEvidence.daemonStopped &&
        !(await loopbackPortIsClosed(daemonPort))
      ) {
        cleanupEvidence.daemonStopped = false;
        cleanupErrors.push('DAEMON_PORT_STILL_OPEN');
      }

      cleanupEvidence.coordinatorThreadCreationAttempted = coordinatorThreadCreationAttempted;
      cleanupEvidence.coordinatorThreadCreationUncertain = coordinatorThreadCreationUncertain;
      if (
        coordinatorThreadId !== undefined &&
        registeredCoordinatorExecutable !== undefined &&
        codexEnvironment !== undefined
      ) {
        try {
          const deleteController = new AbortController();
          const result = await runCaptured(
            registeredCoordinatorExecutable,
            ['delete', '--force', coordinatorThreadId],
            {
              cwd: projectDirectory,
              env: codexEnvironment,
              timeoutMs: 30_000,
              timeoutCode: 'CODEX_THREAD_DELETE_TIMEOUT',
              failureCode: 'CODEX_THREAD_DELETE_FAILED',
            },
            activeChildren,
            deleteController.signal,
          );
          cleanupEvidence.coordinatorThreadDeleted = result.code === 0 && result.signal === null;
          cleanupEvidence.coordinatorThreadCreationUncertain = false;
          if (!cleanupEvidence.coordinatorThreadDeleted) {
            cleanupErrors.push('CODEX_THREAD_DELETE_FAILED');
          }
        } catch {
          cleanupErrors.push('CODEX_THREAD_DELETE_FAILED');
        }
      } else if (coordinatorThreadCreationAttempted && coordinatorThreadCreationUncertain) {
        cleanupEvidence.coordinatorThreadDeleted = false;
        cleanupEvidence.coordinatorThreadCreationUncertain = true;
        cleanupErrors.push('CODEX_THREAD_CREATION_UNRECOVERABLE');
      } else {
        cleanupEvidence.coordinatorThreadDeleted = true;
      }

      if (cleanupConnection !== undefined && redis !== undefined) {
        try {
          if (!cleanupConnection.isOpen) await cleanupConnection.connect();
          if (keys !== undefined) await removeNamespace(cleanupConnection, keys.namespace);
          cleanupEvidence.redisNamespaceRemoved = true;
        } catch {
          cleanupErrors.push('REDIS_NAMESPACE_CLEANUP_FAILED');
        }
        try {
          if (registry !== undefined) {
            await cleanupConnection
              .sendCommand(['FUNCTION', 'DELETE', registry.libraryName])
              .catch(() => undefined);
            const functions = await cleanupConnection.sendCommand([
              'FUNCTION',
              'LIST',
              'LIBRARYNAME',
              registry.libraryName,
            ]);
            cleanupEvidence.functionRemoved = Array.isArray(functions) && functions.length === 0;
            if (!cleanupEvidence.functionRemoved) cleanupErrors.push('REDIS_FUNCTION_REMAINS');
          } else {
            cleanupEvidence.functionRemoved = true;
          }
        } catch {
          cleanupErrors.push('REDIS_FUNCTION_CLEANUP_FAILED');
        }
        try {
          if (cleanupConnection.isOpen) await cleanupConnection.quit();
        } catch {
          try {
            cleanupConnection.disconnect();
          } catch {
            cleanupErrors.push('REDIS_CONNECTION_CLEANUP_FAILED');
          }
        }
      } else {
        cleanupEvidence.redisNamespaceRemoved = true;
        cleanupEvidence.functionRemoved = true;
      }

      if (runDirectory !== undefined && markerPath !== undefined && workspaceRoot !== undefined) {
        try {
          const marker = JSON.parse(await readFile(markerPath, 'utf8'));
          const owned = resolve(workspaceRoot, `${RUN_PREFIX}${marker.runId}`);
          assert(
            marker.runId === runId && owned === runDirectory && inside(workspaceRoot, owned),
            'RUN_MARKER_MISMATCH',
          );
          await rm(runDirectory, { recursive: true, force: false });
          cleanupEvidence.runDirectoryRemoved = !(await pathExists(runDirectory));
          if (!cleanupEvidence.runDirectoryRemoved) cleanupErrors.push('RUN_DIRECTORY_REMAINS');
        } catch {
          cleanupErrors.push('RUN_DIRECTORY_CLEANUP_FAILED');
        }
      } else {
        cleanupEvidence.runDirectoryRemoved = true;
      }
    })();
    return cleanupPromise;
  };

  try {
    redisUrl = assertSafeRedisUrl(parsedArguments.redisUrl);
    workspaceRoot = assertSafeWorkspace(parsedArguments.workspace);
    await mkdir(workspaceRoot, { recursive: true });
    workspaceRoot = await realpath(workspaceRoot);
    codexExecutable = await canonicalCodexExecutable(parsedArguments.codexExecutable);
    gitExecutable = await canonicalGitExecutable(parsedArguments.gitExecutable);
    repositoryRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
    runDirectory = resolve(workspaceRoot, `${RUN_PREFIX}${runId}`);
    assert(inside(workspaceRoot, runDirectory), 'RUN_PATH_REFUSED');
    assert(!inside(repositoryRoot, runDirectory), 'RUN_PATH_INSIDE_SOURCE_REFUSED');
    markerPath = join(runDirectory, MARKER_FILE);
    projectDirectory = join(runDirectory, 'project');
    luwiHome = join(runDirectory, 'luwi-home');
    nativeHome = join(runDirectory, 'native-home');
    privateEnvironmentHome = join(runDirectory, 'environment-home');
    privateEnvironmentTemp = join(runDirectory, 'tmp');

    stage = 'fixture_create';
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(join(nativeHome, '.codex'), { recursive: true });
    await mkdir(luwiHome, { recursive: true });
    await mkdir(privateEnvironmentHome, { recursive: true });
    await mkdir(privateEnvironmentTemp, { recursive: true });
    await writeFile(markerPath, JSON.stringify({ runId }), { flag: 'wx' });
    nodeEnvironment = createNodeEnvironment(
      hostEnvironment,
      codexExecutable,
      gitExecutable,
      privateEnvironmentHome,
      privateEnvironmentTemp,
    );
    gitEnvironment = createGitEnvironment(nodeEnvironment, privateEnvironmentHome);
    codexEnvironment = createCodexEnvironment(hostEnvironment, nodeEnvironment, true);
    wakeServeEnvironment = createCodexEnvironment(hostEnvironment, nodeEnvironment, false);
    applyProcessEnvironment(gitEnvironment);

    stage = 'canonical_codex_probe';
    const codexVersionResult = await runCaptured(
      codexExecutable,
      ['--version'],
      {
        cwd: projectDirectory,
        env: nodeEnvironment,
        failureCode: 'CODEX_VERSION_PROBE_FAILED',
      },
      activeChildren,
      runController.signal,
    );
    assert(
      codexVersionResult.code === 0 && codexVersionResult.signal === null,
      'CODEX_VERSION_PROBE_FAILED',
    );
    codexDetectedVersion = (
      codexVersionResult.stdout.trim() || codexVersionResult.stderr.trim()
    ).slice(0, 200);
    assert(codexDetectedVersion !== '', 'CODEX_VERSION_PROBE_FAILED');

    await writeFile(
      join(projectDirectory, 'acceptance.txt'),
      'isolated wake acceptance fixture\n',
      {
        flag: 'wx',
      },
    );
    await runRequired(
      gitExecutable,
      ['init', '-b', 'main'],
      {
        cwd: projectDirectory,
        env: gitEnvironment,
        failureCode: 'GIT_INIT_FAILED',
      },
      activeChildren,
      runController.signal,
    );
    await runRequired(
      gitExecutable,
      ['add', '--', 'acceptance.txt'],
      {
        cwd: projectDirectory,
        env: gitEnvironment,
        failureCode: 'GIT_ADD_FAILED',
      },
      activeChildren,
      runController.signal,
    );
    await runRequired(
      gitExecutable,
      [
        '-c',
        'user.name=LUWI Acceptance',
        '-c',
        'user.email=acceptance@invalid.local',
        'commit',
        '-m',
        'test: create isolated acceptance fixture',
      ],
      {
        cwd: projectDirectory,
        env: gitEnvironment,
        failureCode: 'GIT_COMMIT_FAILED',
      },
      activeChildren,
      runController.signal,
    );

    stage = 'build_provenance';
    sourceHead = await runRequired(
      gitExecutable,
      ['rev-parse', 'HEAD'],
      { cwd: repositoryRoot, env: gitEnvironment, failureCode: 'HEAD_READ_FAILED' },
      activeChildren,
      runController.signal,
    );
    const sourceStatusBefore = await runRequired(
      gitExecutable,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repositoryRoot, env: gitEnvironment, failureCode: 'SOURCE_STATUS_FAILED' },
      activeChildren,
      runController.signal,
    );
    sourceTreeClean = sourceStatusBefore === '';
    if (!sourceTreeClean) partialReasons.push('SOURCE_TREE_DIRTY');
    const typeScriptEntry = await realpath(
      join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    );
    const rebuildRuntime = () =>
      runRequired(
        process.execPath,
        [typeScriptEntry, '-b', '--pretty', 'false', '--force'],
        { cwd: repositoryRoot, env: nodeEnvironment, failureCode: 'RUNTIME_BUILD_FAILED' },
        activeChildren,
        runController.signal,
      );
    await rebuildRuntime();
    firstRuntimeDistDigest = await buildArtifactDigest(repositoryRoot);
    await rebuildRuntime();
    runtimeDistDigest = await buildArtifactDigest(repositoryRoot);
    runtimeBuildReproducible =
      firstRuntimeDistDigest.sha256 === runtimeDistDigest.sha256 &&
      firstRuntimeDistDigest.fileCount === runtimeDistDigest.fileCount;
    if (!runtimeBuildReproducible) partialReasons.push('RUNTIME_DIST_NOT_REPRODUCIBLE');
    const sourceHeadAfterBuild = await runRequired(
      gitExecutable,
      ['rev-parse', 'HEAD'],
      { cwd: repositoryRoot, env: gitEnvironment, failureCode: 'HEAD_READ_FAILED' },
      activeChildren,
      runController.signal,
    );
    const sourceStatusAfterBuild = await runRequired(
      gitExecutable,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repositoryRoot, env: gitEnvironment, failureCode: 'SOURCE_STATUS_FAILED' },
      activeChildren,
      runController.signal,
    );
    sourceHeadStable = sourceHeadAfterBuild === sourceHead;
    if (!sourceHeadStable) partialReasons.push('SOURCE_HEAD_CHANGED');
    if (sourceStatusAfterBuild !== sourceStatusBefore) partialReasons.push('SOURCE_TREE_CHANGED');

    stage = 'load_build';
    cliEntry = await realpath(join(repositoryRoot, 'apps', 'cli', 'dist', 'main.js'));
    mcpServerEntry = await realpath(join(repositoryRoot, 'apps', 'mcp-server', 'dist', 'main.js'));
    const daemon = await import('../apps/daemon/dist/index.js');
    redis = await import('../packages/redis/dist/index.js');
    keys = redis.createRedisKeys(`luwi:test:wakeaccept:${runId}:v1`);
    registry = redis.createFunctionRegistry(runId);
    cleanupConnection = redis.createManagedRedisConnection({ url: redisUrl });
    await cleanupConnection.connect();

    daemonPort = await reserveLoopbackPort();
    baseUrl = `http://${EXPECTED_REDIS_HOST}:${String(daemonPort)}`;
    const startRuntime = async () => {
      const config = daemon.loadDaemonConfig({
        ...nodeEnvironment,
        HOST: EXPECTED_REDIS_HOST,
        PORT: String(daemonPort),
        REDIS_URL: redisUrl,
        LOG_LEVEL: 'silent',
        WORKSPACE_ID: `acceptance-${runId}`,
        LUWI_HOME: luwiHome,
        LUWI_NATIVE_HOME: nativeHome,
        LUWI_SESSION_PRESENCE_TTL_MS: '120000',
        LUWI_INBOX_BLOCK_MS: '1000',
        LUWI_WAKE_SWEEP_INTERVAL_MS: '60000',
        LUWI_RETENTION_INTERVAL_MS: '60000',
        LUWI_MESSAGE_DEFAULT_TIMEOUT_MS: '300000',
        LUWI_MESSAGE_MAX_TIMEOUT_MS: '600000',
      });
      return daemon.startDaemon({
        config,
        logger: false,
        keys,
        functionRegistry: registry,
        runtimeInstanceId: randomUUID(),
      });
    };

    stage = 'daemon_start';
    runtime = await startRuntime();
    await http(baseUrl, 'GET', '/health', undefined, [200], runController.signal);
    const functionVersionReply = await cleanupConnection.sendCommand([
      'FCALL',
      registry.functions.version,
      '0',
    ]);
    let functionVersion;
    try {
      functionVersion = JSON.parse(String(functionVersionReply));
    } catch {
      throw failure('REDIS_FUNCTION_VERSION_INVALID');
    }
    assert(
      functionVersion?.version === registry.version &&
        functionVersion?.libraryName === registry.libraryName,
      'REDIS_FUNCTION_VERSION_INVALID',
    );
    observedRedisFunctionVersion = functionVersion.version;

    stage = 'canonical_agent_detection';
    const detectedAgents = await http(
      baseUrl,
      'POST',
      '/api/v1/agents/detect',
      {},
      [200],
      runController.signal,
    );
    const detectedCodexInstallations = detectedAgents.body.installations?.filter(
      (installation) =>
        installation.kind === 'codex' && installation.adapterId === 'codex-native-v1',
    );
    assert(detectedCodexInstallations?.length === 1, 'CANONICAL_CODEX_DETECTION_FAILED');
    const detectedCodex = detectedCodexInstallations[0];
    assert(
      detectedCodex.detectedVersion === codexDetectedVersion &&
        (await canonicalCodexExecutable(detectedCodex.executable)) === codexExecutable,
      'CANONICAL_CODEX_DETECTION_FAILED',
    );

    stage = 'register_control_plane';
    const project = (
      await http(
        baseUrl,
        'POST',
        '/api/v1/projects',
        { name: 'Wake acceptance fixture', localPath: projectDirectory },
        [201],
        runController.signal,
      )
    ).body;
    const workerAgentId = `codex-worker-${runId.slice(0, 16)}`;
    const coordinatorAgentId = `codex-coordinator-${runId.slice(0, 12)}`;
    for (const [id, displayName] of [
      [workerAgentId, 'Codex acceptance worker'],
      [coordinatorAgentId, 'Codex acceptance coordinator'],
    ]) {
      await http(
        baseUrl,
        'POST',
        '/api/v1/agents',
        {
          id,
          kind: 'codex',
          displayName,
          executable: codexExecutable,
          enabled: true,
          adapterId: 'codex-native-v1',
          nativeConfigRoots: [join(nativeHome, '.codex')],
          metadata: {},
        },
        [201],
        runController.signal,
      );
    }
    await http(
      baseUrl,
      'POST',
      `/api/v1/projects/${project.id}/agents`,
      {
        agentId: workerAgentId,
        enabled: true,
        role: 'Isolated wake acceptance worker',
        profileIds: [],
        capabilityBindingIds: [],
        overrides: {
          luwiNativeBridge: {
            enabled: true,
            provider: 'codex',
            executionProfile: 'workspace-write',
          },
        },
      },
      [201],
      runController.signal,
    );
    const registeredAgents = (
      await http(baseUrl, 'GET', '/api/v1/agents', undefined, [200], runController.signal)
    ).body.agents;
    for (const agentId of [workerAgentId, coordinatorAgentId]) {
      const registered = registeredAgents?.find((agent) => agent.id === agentId);
      assert(registered !== undefined, 'REGISTERED_AGENT_MISSING');
      assert(registered.executable === codexExecutable, 'REGISTERED_EXECUTABLE_CHANGED');
      assert(registered.detectedVersion === codexDetectedVersion, 'REGISTERED_VERSION_CHANGED');
      const canonicalRegisteredExecutable = await canonicalCodexExecutable(registered.executable);
      assert(
        canonicalRegisteredExecutable === codexExecutable,
        'REGISTERED_EXECUTABLE_NOT_CANONICAL',
      );
      if (agentId === workerAgentId) registeredWorkerExecutable = canonicalRegisteredExecutable;
      if (agentId === coordinatorAgentId) {
        registeredCoordinatorExecutable = canonicalRegisteredExecutable;
      }
    }
    assert(registeredWorkerExecutable !== undefined, 'WORKER_EXECUTABLE_NOT_RESOLVED');
    assert(registeredCoordinatorExecutable !== undefined, 'COORDINATOR_EXECUTABLE_NOT_RESOLVED');
    const projectStatusBaseline = await runRequired(
      gitExecutable,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: projectDirectory, env: gitEnvironment, failureCode: 'GIT_STATUS_FAILED' },
      activeChildren,
      runController.signal,
    );

    const coordinatorSession = (
      await http(
        baseUrl,
        'POST',
        '/api/v1/sessions',
        {
          projectId: project.id,
          agentId: coordinatorAgentId,
          workingDirectory: projectDirectory,
          metadata: { role: 'acceptance-coordinator' },
        },
        [201],
        runController.signal,
      )
    ).body;
    coordinatorSessionId = coordinatorSession.id;
    await http(
      baseUrl,
      'POST',
      `/api/v1/sessions/${coordinatorSessionId}/status`,
      { status: 'idle' },
      [200],
      runController.signal,
    );
    heartbeatTimer = setInterval(() => {
      void http(
        baseUrl,
        'POST',
        `/api/v1/sessions/${coordinatorSessionId}/heartbeat`,
        {},
        [200],
        new AbortController().signal,
      ).catch(() => undefined);
    }, 10_000);

    let persistentCoordinatorCreated = false;
    let coordinatorReady = false;
    let seedWorkflow;
    let seedWakeIntentId;
    let preexistingExactThreadQueue = false;
    let preexistingWorkflowContinuation = false;
    let sourceInboxAfterSeed = 0;

    stage = 'coordinator_thread_create';
    try {
      coordinatorThreadCreationAttempted = true;
      coordinatorThreadCreationUncertain = true;
      const coordinatorRun = await runCaptured(
        registeredCoordinatorExecutable,
        coordinatorArguments({
          nodeExecutable: await realpath(process.execPath),
          mcpServerEntry,
          sessionId: coordinatorSessionId,
          daemonUrl: baseUrl,
          projectDirectory,
        }),
        {
          cwd: projectDirectory,
          env: codexEnvironment,
          observeStdout: (stdout) => {
            const observed = parseThreadId(stdout);
            if (observed === undefined) return;
            if (coordinatorThreadId !== undefined && coordinatorThreadId !== observed) {
              throw failure('COORDINATOR_THREAD_ID_CHANGED');
            }
            coordinatorThreadId = observed;
            coordinatorThreadCreationUncertain = false;
          },
          timeoutMs: PROCESS_TIMEOUT_MS,
          timeoutCode: 'COORDINATOR_THREAD_CREATE_TIMEOUT',
          failureCode: 'COORDINATOR_THREAD_CREATE_FAILED',
        },
        activeChildren,
        runController.signal,
      );
      const completedThreadId = parseThreadId(coordinatorRun.stdout);
      if (completedThreadId !== undefined) {
        coordinatorThreadId = completedThreadId;
        coordinatorThreadCreationUncertain = false;
      } else if (coordinatorRun.signal === null && coordinatorRun.code !== null) {
        // `thread.started` is Codex JSONL's first persistence event. A normal
        // process exit without it proves that there is no disposable thread to
        // delete, including strict-config validation failures.
        coordinatorThreadCreationUncertain = false;
      }
      if (
        coordinatorRun.code !== 0 ||
        coordinatorRun.signal !== null ||
        coordinatorThreadId === undefined
      ) {
        partialReasons.push('PERSISTENT_COORDINATOR_UNAVAILABLE');
      } else {
        await http(
          baseUrl,
          'POST',
          `/api/v1/sessions/${coordinatorSessionId}/native`,
          {
            native: { adapterId: 'codex-native-v1', nativeSessionId: coordinatorThreadId },
            identityProvenance: {
              source: 'host_launcher',
              launcherInstanceId: `acceptance-launcher-${runId.slice(0, 12)}`,
            },
            hostWake: { adapter: 'codex-queue-v1', mcpSessionId: coordinatorSessionId },
          },
          [200],
          runController.signal,
        );
        persistentCoordinatorCreated = true;
        coordinatorReady = true;
      }
    } catch (error) {
      if (runController.signal.aborted) throw error;
      partialReasons.push('PERSISTENT_COORDINATOR_UNAVAILABLE');
    }

    if (coordinatorReady) {
      stage = 'seed_preexisting_wake';
      const seedAgentId = `seed-worker-${runId.slice(0, 12)}`;
      const seedSession = (
        await http(
          baseUrl,
          'POST',
          '/api/v1/sessions',
          {
            projectId: project.id,
            agentId: seedAgentId,
            workingDirectory: projectDirectory,
          },
          [201],
          runController.signal,
        )
      ).body;
      const seeded = await http(
        baseUrl,
        'POST',
        '/api/v1/workflows',
        {
          objective: 'Verify a preexisting durable wake survives restart.',
          coordinatorSessionId,
          rootCorrelationId: `seed-${runId}`,
          firstMessage: {
            targetAgentId: seedAgentId,
            kind: 'instruction',
            content: 'Return the isolated seed response.',
          },
        },
        [201],
        runController.signal,
      );
      seedWorkflow = seeded.body.workflow;
      const seedCorrelationId = seeded.body.message.correlationId;
      const claimed = await http(
        baseUrl,
        'POST',
        `/api/v1/sessions/${seedSession.id}/inbox/claim`,
        { bridgeInstanceId: `seed-${runId}`, limit: 1, blockMs: 0, minIdleMs: 0 },
        [200],
        runController.signal,
      );
      assert(claimed.body.items?.length === 1, 'SEED_MESSAGE_NOT_CLAIMED');
      for (const action of ['acknowledge', 'processing']) {
        await http(
          baseUrl,
          'POST',
          `/api/v1/messages/${seedCorrelationId}/${action}`,
          { responderSessionId: seedSession.id },
          [200],
          runController.signal,
        );
      }
      await http(
        baseUrl,
        'POST',
        `/api/v1/messages/${seedCorrelationId}/respond`,
        {
          responderSessionId: seedSession.id,
          response: {
            status: 'answered',
            answer: 'Isolated seed response.',
            evidence: [],
            verifiedAt: new Date().toISOString(),
          },
        },
        [200],
        runController.signal,
      );
      const seededProjection = await eventually(
        () =>
          http(
            baseUrl,
            'GET',
            `/api/v1/workflows/${seedWorkflow.id}`,
            undefined,
            [200],
            runController.signal,
          ).then((result) => result.body),
        (workflow) => workflow.currentWakeIntentId !== undefined,
        HTTP_TIMEOUT_MS,
        runController.signal,
        'SEED_WAKE_NOT_CREATED',
      );
      seedWakeIntentId = seededProjection.currentWakeIntentId;
      await recreateWakeGroupAtZero(cleanupConnection, keys.wakeStream, redis.WAKE_CONSUMER_GROUP);
      sourceInboxAfterSeed = Number(
        await cleanupConnection.sendCommand(['XLEN', keys.sessionInbox(coordinatorSessionId)]),
      );
      assert(sourceInboxAfterSeed === 1, 'SEED_SOURCE_INBOX_MISSING');
      await http(
        baseUrl,
        'POST',
        `/api/v1/sessions/${seedSession.id}/close`,
        {},
        [200],
        runController.signal,
      );

      stage = 'daemon_restart';
      await runtime.shutdown.shutdown('SIGTERM');
      runtime.shutdown.dispose();
      runtime = await startRuntime();
      await http(baseUrl, 'GET', '/health', undefined, [200], runController.signal);
      const groupsAfterRestart = await cleanupConnection.sendCommand([
        'XINFO',
        'GROUPS',
        keys.wakeStream,
      ]);
      const restoredGroup = Array.isArray(groupsAfterRestart)
        ? groupsAfterRestart
            .map(groupFields)
            .find((candidate) => candidate.name === redis.WAKE_CONSUMER_GROUP)
        : undefined;
      assert(restoredGroup?.['last-delivered-id'] === '0-0', 'WAKE_GROUP_RESTART_DRIFT');
    }

    stage = 'wake_serve_start';
    wakeServe = spawnObserved(
      process.execPath,
      [
        cliEntry,
        'wake',
        'serve',
        '--url',
        baseUrl,
        '--rescan-ms',
        '60000',
        '--standby-ms',
        '250',
        '--bridge-instance',
        `acceptance-${runId.slice(0, 16)}`,
        '--limit',
        '1',
        '--block-ms',
        '1000',
        '--min-idle-ms',
        '0',
        '--heartbeat-ms',
        '1000',
        '--lease-renew-ms',
        '5000',
        '--connect-timeout-ms',
        '5000',
      ],
      {
        cwd: repositoryRoot,
        env: wakeServeEnvironment,
        verifyTreeCleanup: true,
      },
      activeChildren,
    );

    const assertWakeServeRunning = () => {
      if (
        wakeServe.outputFailure !== undefined ||
        wakeServe.child.exitCode !== null ||
        wakeServe.child.signalCode !== null
      ) {
        throw failure('WAKE_SERVE_EXITED');
      }
    };

    stage = 'worker_online';
    const workerSession = await eventually(
      async () => {
        assertWakeServeRunning();
        const sessions = await http(
          baseUrl,
          'GET',
          `/api/v1/projects/${project.id}/sessions`,
          undefined,
          [200],
          runController.signal,
        );
        return sessions.body.sessions?.find(
          (session) =>
            session.agentId === workerAgentId &&
            session.presence === 'online' &&
            session.status === 'idle',
        );
      },
      (session) => session !== undefined,
      60_000,
      runController.signal,
      'SUPERVISED_WORKER_NOT_ONLINE',
    );
    assert(workerSession.metadata?.bridge === 'native-headless', 'WORKER_NOT_NATIVE_HEADLESS');
    const slots = await http(
      baseUrl,
      'GET',
      '/api/v1/bridge-slots?limit=100',
      undefined,
      [200],
      runController.signal,
    );
    assert(
      slots.body.slots?.some(
        (slot) =>
          slot.projectId === project.id &&
          slot.agentId === workerAgentId &&
          slot.executionProfile === 'workspace-write' &&
          slot.state === 'active',
      ),
      'WORKER_SLOT_NOT_ACTIVE',
    );

    if (coordinatorReady && seedWorkflow !== undefined && seedWakeIntentId !== undefined) {
      stage = 'preexisting_exact_thread_wake';
      try {
        const seedOutcome = await eventually(
          async () => {
            assertWakeServeRunning();
            const [workflow, wakeCollection] = await Promise.all([
              http(
                baseUrl,
                'GET',
                `/api/v1/workflows/${seedWorkflow.id}`,
                undefined,
                [200],
                runController.signal,
              ).then((result) => result.body),
              http(
                baseUrl,
                'GET',
                `/api/v1/wake-intents?projectId=${project.id}&limit=20`,
                undefined,
                [200],
                runController.signal,
              ).then((result) => result.body),
            ]);
            const wake = wakeCollection.wakeIntents?.find(
              (candidate) => candidate.id === seedWakeIntentId,
            );
            return { workflow, wake };
          },
          ({ workflow, wake }) =>
            workflow.state === 'completed' ||
            wake?.state === 'fallback_only' ||
            wake?.state === 'indeterminate',
          CONTINUATION_TIMEOUT_MS,
          runController.signal,
          'EXACT_THREAD_CONTINUATION_TIMEOUT',
        );
        preexistingExactThreadQueue = seedOutcome.wake?.state === 'dispatched';
        preexistingWorkflowContinuation = seedOutcome.workflow.state === 'completed';
        if (!preexistingExactThreadQueue || !preexistingWorkflowContinuation) {
          partialReasons.push('EXACT_THREAD_QUEUE_CONTINUATION_UNAVAILABLE');
        }
      } catch (error) {
        if (runController.signal.aborted) throw error;
        partialReasons.push('EXACT_THREAD_QUEUE_CONTINUATION_UNAVAILABLE');
      }
      const inboxAfterDispatch = Number(
        await cleanupConnection.sendCommand(['XLEN', keys.sessionInbox(coordinatorSessionId)]),
      );
      assert(inboxAfterDispatch === sourceInboxAfterSeed, 'DISPATCHER_CONSUMED_SOURCE_INBOX');
    }

    stage = 'real_supervised_worker';
    const liveWorkflow = await http(
      baseUrl,
      'POST',
      '/api/v1/workflows',
      {
        objective: 'Verify the production supervised worker and MCP response.',
        coordinatorSessionId,
        rootCorrelationId: `live-${runId}`,
        firstMessage: {
          targetAgentId: workerAgentId,
          kind: 'instruction',
          content: [
            'This is an isolated live acceptance request.',
            'Do not edit files or run shell commands.',
            'Call luwi_respond_to_message exactly once with status answered, a short confirmation,',
            'an empty evidence array, and the current UTC verification time. Then end the turn.',
          ].join(' '),
        },
      },
      [201],
      runController.signal,
    );
    const liveCorrelationId = liveWorkflow.body.message.correlationId;
    const liveMessage = await eventually(
      async () => {
        assertWakeServeRunning();
        return http(
          baseUrl,
          'GET',
          `/api/v1/messages/${liveCorrelationId}`,
          undefined,
          [200],
          runController.signal,
        ).then((result) => result.body);
      },
      (message) => ['responded', 'rejected', 'failed', 'timed_out'].includes(message.state),
      WORKER_TIMEOUT_MS,
      runController.signal,
      'SUPERVISED_WORKER_TIMEOUT',
    );
    assert(
      liveMessage.state === 'responded' && liveMessage.response?.status === 'answered',
      'SUPERVISED_MCP_RESPONSE_FAILED',
    );
    assert(
      liveMessage.targetAgentId === workerAgentId &&
        liveMessage.targetSessionId === workerSession.id,
      'SUPERVISED_MESSAGE_TARGET_MISMATCH',
    );
    const terminalEvents = await http(
      baseUrl,
      'GET',
      '/api/v1/events?limit=1000',
      undefined,
      [200],
      runController.signal,
    );
    assert(
      terminalEvents.body.events?.some(
        (event) =>
          event.type === 'message.responded' &&
          event.correlationId === liveCorrelationId &&
          event.agentId === workerAgentId &&
          event.sessionId === workerSession.id,
      ),
      'SUPERVISED_MESSAGE_RESPONDER_MISMATCH',
    );
    const cleanProject = await runRequired(
      gitExecutable,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: projectDirectory, env: gitEnvironment, failureCode: 'GIT_STATUS_FAILED' },
      activeChildren,
      runController.signal,
    );
    assert(cleanProject === projectStatusBaseline, 'SUPERVISED_WORKER_CHANGED_PROJECT');

    stage = 'live_workflow_continuation';
    let liveContinuation = false;
    try {
      const continuation = await eventually(
        async () => {
          assertWakeServeRunning();
          const workflow = await http(
            baseUrl,
            'GET',
            `/api/v1/workflows/${liveWorkflow.body.workflow.id}`,
            undefined,
            [200],
            runController.signal,
          ).then((result) => result.body);
          const wakes = await http(
            baseUrl,
            'GET',
            `/api/v1/wake-intents?projectId=${project.id}&limit=20`,
            undefined,
            [200],
            runController.signal,
          ).then((result) => result.body);
          const wake = wakes.wakeIntents?.find(
            (candidate) => candidate.workflowId === liveWorkflow.body.workflow.id,
          );
          return { workflow, wake };
        },
        ({ workflow, wake }) =>
          workflow.state === 'completed' ||
          wake?.state === 'fallback_only' ||
          wake?.state === 'indeterminate',
        CONTINUATION_TIMEOUT_MS,
        runController.signal,
        'LIVE_CONTINUATION_TIMEOUT',
      );
      liveContinuation =
        continuation.workflow.state === 'completed' && continuation.wake?.state === 'dispatched';
      if (coordinatorReady && !liveContinuation) {
        partialReasons.push('LIVE_WORKFLOW_CONTINUATION_UNAVAILABLE');
      }
      if (!coordinatorReady) {
        assert(
          continuation.wake?.state === 'fallback_only' ||
            continuation.wake?.state === 'indeterminate',
          'UNBOUND_WAKE_NOT_SETTLED',
        );
      }
    } catch (error) {
      if (runController.signal.aborted) throw error;
      partialReasons.push('LIVE_WORKFLOW_CONTINUATION_UNAVAILABLE');
    }

    const sourceInboxFinal = Number(
      await cleanupConnection.sendCommand(['XLEN', keys.sessionInbox(coordinatorSessionId)]),
    );
    const expectedInbox = sourceInboxAfterSeed + 1;
    assert(sourceInboxFinal === expectedInbox, 'SOURCE_INBOX_DURABILITY_FAILED');

    stage = 'public_redaction';
    const publicWakes = await http(
      baseUrl,
      'GET',
      `/api/v1/wake-intents?projectId=${project.id}&limit=20`,
      undefined,
      [200],
      runController.signal,
    );
    const coordinatorWakeObserved =
      coordinatorReady &&
      seedWakeIntentId !== undefined &&
      publicWakes.body.wakeIntents?.some((wake) => wake.id === seedWakeIntentId) === true;
    if (coordinatorThreadId !== undefined && coordinatorWakeObserved) {
      assert(!publicWakes.raw.includes(coordinatorThreadId), 'PUBLIC_WAKE_NATIVE_ID_LEAK');
      nativeIdentityRedactionObserved = true;
    }
    assert(!publicWakes.raw.includes('acceptance-launcher-'), 'PUBLIC_WAKE_LAUNCHER_LEAK');
    assert(!publicWakes.raw.includes('ownerToken'), 'PUBLIC_WAKE_OWNER_TOKEN_LEAK');

    stage = 'slot_ttl_fence';
    const competingOwners = [randomUUID(), randomUUID()];
    const ttlSlot = {
      projectId: project.id,
      agentId: `ttl-probe-${runId.slice(0, 12)}`,
      provider: 'codex',
      executionProfile: 'workspace-write',
    };
    const [firstAttempt, secondAttempt] = await Promise.all(
      competingOwners.map(async (ownerToken) => ({
        ownerToken,
        response: await http(
          baseUrl,
          'POST',
          '/api/v1/bridge-slots/acquire',
          { ...ttlSlot, ownerToken },
          [200, 201],
          runController.signal,
        ),
      })),
    );
    const initialAttempts = [firstAttempt, secondAttempt];
    const acquiredAttempts = initialAttempts.filter(
      ({ response }) => response.status === 201 && response.body.status === 'acquired',
    );
    const heldAttempts = initialAttempts.filter(
      ({ response }) => response.status === 200 && response.body.status === 'held',
    );
    assert(
      acquiredAttempts.length === 1 && heldAttempts.length === 1,
      'CONCURRENT_SLOT_OWNERSHIP_INVALID',
    );
    const owned = acquiredAttempts[0];
    const replacementOwner = heldAttempts[0].ownerToken;
    assert(
      owned.response.body.slot.id === heldAttempts[0].response.body.slot.id,
      'CONCURRENT_SLOT_ID_MISMATCH',
    );
    await eventually(
      () =>
        cleanupConnection.sendCommand(['PTTL', keys.bridgeSlotOwner(owned.response.body.slot.id)]),
      (ttl) => Number(ttl) === -2,
      redis.BRIDGE_SLOT_TTL_MS + 5_000,
      runController.signal,
      'BRIDGE_SLOT_TTL_TIMEOUT',
    );
    const replaced = await http(
      baseUrl,
      'POST',
      '/api/v1/bridge-slots/acquire',
      { ...ttlSlot, ownerToken: replacementOwner },
      [201],
      runController.signal,
    );
    assert(replaced.body.status === 'acquired', 'EXPIRED_SLOT_OWNER_NOT_REPLACED');
    const staleRelease = await http(
      baseUrl,
      'POST',
      `/api/v1/bridge-slots/${owned.response.body.slot.id}/release`,
      { ownerToken: owned.ownerToken },
      [409],
      runController.signal,
    );
    assert(
      staleRelease.body.error?.code === 'BRIDGE_SLOT_NOT_OWNER',
      'STALE_SLOT_RELEASE_NOT_FENCED',
    );
    const publicSlots = await http(
      baseUrl,
      'GET',
      '/api/v1/bridge-slots?limit=100',
      undefined,
      [200],
      runController.signal,
    );
    for (const ownerToken of competingOwners) {
      assert(!publicSlots.raw.includes(ownerToken), 'PUBLIC_SLOT_OWNER_TOKEN_LEAK');
    }
    await http(
      baseUrl,
      'POST',
      `/api/v1/bridge-slots/${owned.response.body.slot.id}/release`,
      { ownerToken: replacementOwner },
      [200],
      runController.signal,
    );

    stage = 'final_evidence';
    const finalSourceHead = await runRequired(
      gitExecutable,
      ['rev-parse', 'HEAD'],
      { cwd: repositoryRoot, env: gitEnvironment, failureCode: 'HEAD_READ_FAILED' },
      activeChildren,
      runController.signal,
    );
    if (finalSourceHead !== sourceHead) {
      sourceHeadStable = false;
      partialReasons.push('SOURCE_HEAD_CHANGED');
    }
    const finalSourceStatus = await runRequired(
      gitExecutable,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repositoryRoot, env: gitEnvironment, failureCode: 'SOURCE_STATUS_FAILED' },
      activeChildren,
      runController.signal,
    );
    sourceTreeClean = sourceTreeClean && finalSourceStatus === '';
    if (!sourceTreeClean) partialReasons.push('SOURCE_TREE_DIRTY');
    const pending = await cleanupConnection.sendCommand([
      'XPENDING',
      keys.wakeStream,
      redis.WAKE_CONSUMER_GROUP,
    ]);
    assert(Array.isArray(pending) && Number(pending[0]) === 0, 'WAKE_PENDING_REMAINS');
    const uniquePartialReasons = [...new Set(partialReasons)];
    const full =
      uniquePartialReasons.length === 0 &&
      persistentCoordinatorCreated &&
      preexistingExactThreadQueue &&
      preexistingWorkflowContinuation &&
      liveContinuation &&
      sourceTreeClean &&
      sourceHeadStable &&
      runtimeBuildReproducible &&
      observedRedisFunctionVersion === registry.version &&
      nativeIdentityRedactionObserved;
    finalEvidence = {
      schemaVersion: 2,
      status: full ? 'passed' : 'partial',
      startedAt,
      finishedAt: new Date().toISOString(),
      buildProvenance: {
        sourceHead,
        sourceTreeClean,
        sourceDirty: !sourceTreeClean,
        sourceHeadStable,
        runtimeBuildRebuiltFromSource: true,
        runtimeBuildReproducible,
        runtimeDistBuild1Sha256: firstRuntimeDistDigest.sha256,
        runtimeDistBuild2Sha256: runtimeDistDigest.sha256,
        runtimeDistFileCount: runtimeDistDigest.fileCount,
      },
      scope: {
        productionWakeServe: true,
        registeredCanonicalCodex: true,
        realSupervisedWorkspaceWriteCodex: true,
        realMcpResponse: true,
        groupRecreatedAndVerifiedAtZero: seedWakeIntentId !== undefined,
        daemonRestartRecoveredPreexistingWake: preexistingExactThreadQueue,
        disposablePersistentCoordinator: persistentCoordinatorCreated,
        exactThreadQueue: preexistingExactThreadQueue,
        preexistingWorkflowContinuation,
        workflowContinuation: liveContinuation,
      },
      isolation: {
        redisHost: EXPECTED_REDIS_HOST,
        redisPort: EXPECTED_REDIS_PORT,
        redisFunctionVersion: observedRedisFunctionVersion,
        uniqueNamespace: true,
        daemonStarts: seedWakeIntentId === undefined ? 1 : 2,
      },
      durability: {
        sourceInboxResponsesRetained: sourceInboxFinal,
        wakePendingEntries: 0,
      },
      ownership: {
        concurrentSlotTokenRaceObserved: true,
        exactlyOneInitialOwnerAcquired: true,
        exactlyOneInitialOwnerHeld: true,
        expiredOwnerReplaced: true,
        staleReleaseFenced: true,
      },
      publicProjection: {
        nativeIdentityRedactionObserved,
        ownerTokenRedactionObserved: true,
      },
      providers: {
        codex: 'live',
        claudeCode: 'not-exercised',
        geminiCli: 'not-exercised',
        antigravity: 'not-exercised',
      },
      partialReasons: uniquePartialReasons,
    };
  } catch (error) {
    runFailure = {
      schemaVersion: 2,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      stage,
      failureCode: processFailureCode(error, 'ACCEPTANCE_FAILED'),
    };
  } finally {
    try {
      await cleanup();
    } catch {
      cleanupErrors.push('CLEANUP_UNEXPECTED_FAILURE');
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (cleanupErrors.length > 0) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 2,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        stage: 'cleanup',
        failureCode: 'CLEANUP_VERIFICATION_FAILED',
        cleanup: { verified: false, failureCodes: [...new Set(cleanupErrors)].toSorted() },
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (runFailure !== undefined) {
    process.stderr.write(
      `${JSON.stringify({
        ...runFailure,
        finishedAt: new Date().toISOString(),
        cleanup: { verified: true, ...cleanupEvidence },
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (finalEvidence === undefined) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 2,
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        stage: 'final_evidence',
        failureCode: 'FINAL_EVIDENCE_MISSING',
        cleanup: { verified: true, ...cleanupEvidence },
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ...finalEvidence,
        finishedAt: new Date().toISOString(),
        cleanup: { verified: true, ...cleanupEvidence },
      },
      null,
      2,
    )}\n`,
  );
  if (finalEvidence.status === 'partial') process.exitCode = 2;
}

await main();
