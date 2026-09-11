import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

const hasControlCharacter = (value) =>
  Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 0x1f || point === 0x7f);
  });

const requireString = (value, maximum, label) => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
};

export function readBoundedTextFile(path, maximumBytes = 4096) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('invalid bounded file');
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const descriptor = openSync(path, flags);
  try {
    const snapshot = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      !snapshot.isFile() ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      entry.dev !== snapshot.dev ||
      entry.ino !== snapshot.ino ||
      current.dev !== snapshot.dev ||
      current.ino !== snapshot.ino ||
      snapshot.size <= 0 ||
      snapshot.size > maximumBytes ||
      (process.platform !== 'win32' && (snapshot.mode & 0o077) !== 0)
    ) {
      throw new Error('invalid bounded file');
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead > maximumBytes) throw new Error('invalid bounded file');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedJsonFile(path, maximumBytes = 16 * 1024) {
  return JSON.parse(readBoundedTextFile(path, maximumBytes));
}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readSessionBindingFile(path) {
  try {
    const record = readBoundedJsonFile(path, 4096);
    // `{ attached }`, optionally with the `native` reference `session attach`
    // writes beside it since ADR 0034 so an MCP server can re-declare it for a
    // successor. The launchers only need the id.
    const keys = Object.keys(record ?? {});
    if (
      !isPlainObject(record) ||
      !Object.hasOwn(record, 'attached') ||
      keys.some((key) => key !== 'attached' && key !== 'native')
    ) {
      throw new Error('invalid record');
    }
    if (Object.hasOwn(record, 'native')) {
      const native = record.native;
      const nativeKeys = Object.keys(native ?? {});
      if (
        !isPlainObject(native) ||
        nativeKeys.some(
          (key) => key !== 'adapterId' && key !== 'nativeSessionId' && key !== 'nativeSubagentId',
        )
      ) {
        throw new Error('invalid record');
      }
      requireString(native.adapterId, 128, 'native adapter id');
      requireString(native.nativeSessionId, 256, 'native session id');
      if (Object.hasOwn(native, 'nativeSubagentId')) {
        requireString(native.nativeSubagentId, 256, 'native subagent id');
      }
    }
    return requireString(record.attached, 128, 'LUWI session id');
  } catch {
    throw new Error('invalid LUWI session binding file');
  }
}

export function environmentSessionBinding(environment) {
  if (environment.LUWI_SESSION_ID && environment.LUWI_SESSION_FILE) {
    throw new Error('both LUWI session binding sources are set');
  }
  if (environment.LUWI_SESSION_ID) {
    return { sessionId: requireString(environment.LUWI_SESSION_ID, 128, 'LUWI session id') };
  }
  if (environment.LUWI_SESSION_FILE) {
    const sessionFile = requireString(environment.LUWI_SESSION_FILE, 4096, 'LUWI session file');
    if (!isAbsolute(sessionFile)) throw new Error('LUWI session file must be absolute');
    return { sessionId: readSessionBindingFile(sessionFile), sessionFile };
  }
  return undefined;
}

export function loopbackDaemonUrl(value) {
  const configured = requireString(value, 2048, 'LUWI daemon URL');
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('LUWI daemon URL must be an exact loopback HTTP origin');
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]';
  if (
    parsed.protocol !== 'http:' ||
    !loopback ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('LUWI daemon URL must be an exact loopback HTTP origin');
  }
  return parsed.origin;
}

export function codexNativeSessionId(environment) {
  const sessionId = environment.CODEX_SESSION_ID;
  const threadId = environment.CODEX_THREAD_ID;
  if (sessionId && threadId && sessionId !== threadId) {
    throw new Error('conflicting Codex conversation identity');
  }
  const selected = sessionId ?? threadId;
  return selected === undefined ? undefined : requireString(selected, 128, 'Codex identity');
}

export function writePrivateTextFile(path, content) {
  if (!isAbsolute(path)) throw new Error('private file path must be absolute');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16 * 1024) {
    throw new Error('invalid private file content');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writePrivateJsonFile(path, value) {
  writePrivateTextFile(path, JSON.stringify(value));
}

export function mcpServerEnvironment(environment, binding) {
  const result = { ...environment };
  delete result.LUWI_SESSION_ID;
  delete result.LUWI_SESSION_FILE;
  if (binding.sessionFile === undefined) {
    result.LUWI_SESSION_ID = requireString(binding.sessionId, 128, 'LUWI session id');
  } else {
    const sessionFile = requireString(binding.sessionFile, 4096, 'LUWI session file');
    if (!isAbsolute(sessionFile)) throw new Error('LUWI session file must be absolute');
    result.LUWI_SESSION_FILE = sessionFile;
  }
  return result;
}

export function conversationSessionFile(temporaryDirectory, vendor, nativeSessionId) {
  const root = requireString(temporaryDirectory, 4096, 'temporary directory');
  const id = safeNativeSessionId(nativeSessionId);
  if (!isAbsolute(root)) throw new Error('temporary directory must be absolute');
  if (vendor !== 'codex' && vendor !== 'antigravity') throw new Error('invalid native vendor');
  return join(root, `luwi-attach-${vendor}-${id}.out`);
}

const safeNativeSessionId = (value) => {
  const id = requireString(value, 128, 'native session id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || id.includes('..')) {
    throw new Error('invalid native session id');
  }
  return id;
};

export function conversationPidFile(temporaryDirectory, vendor, nativeSessionId) {
  const root = resolve(requireString(temporaryDirectory, 4096, 'temporary directory'));
  const id = safeNativeSessionId(nativeSessionId);
  if (!isAbsolute(root)) throw new Error('temporary directory must be absolute');
  if (vendor !== 'antigravity') throw new Error('invalid native vendor');
  const path = join(root, `luwi-${vendor}-${id}.pid`);
  if (dirname(path) !== root) throw new Error('invalid native session path');
  return path;
}

export function sessionAttachArguments(request, sessionFile) {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('invalid LUWI attach request');
  }
  const projectId = requireString(request.projectId, 128, 'LUWI project id');
  const agentId = requireString(request.agentId, 128, 'LUWI agent id');
  const workingDirectory = requireString(request.workingDirectory, 4096, 'working directory');
  const native = request.native;
  if (typeof native !== 'object' || native === null || Array.isArray(native)) {
    throw new Error('invalid native session reference');
  }
  const adapterId = requireString(native.adapterId, 128, 'native adapter id');
  const nativeSessionId = requireString(native.nativeSessionId, 256, 'native session id');
  const output = requireString(sessionFile, 4096, 'LUWI session file');
  if (!isAbsolute(workingDirectory) || !isAbsolute(output)) {
    throw new Error('LUWI attach paths must be absolute');
  }
  const agentKind =
    adapterId === 'codex' || adapterId === 'claude-code' || adapterId === 'gemini'
      ? adapterId
      : 'other';
  const args = [
    'session',
    'attach',
    '--project',
    projectId,
    '--agent',
    agentId,
    '--agent-kind',
    agentKind,
    '--native-adapter',
    adapterId,
    '--native-session',
    nativeSessionId,
    '--working-directory',
    workingDirectory,
    '--session-out',
    output,
  ];
  const model = request.metadata?.model;
  if (model !== undefined) args.push('--model', requireString(model, 256, 'model'));
  return args;
}

export function codexAttachPlan(record, temporaryDirectory) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error('invalid Codex attach record');
  }
  const codexSid = requireString(record.codexSid, 128, 'Codex session id');
  const request = record.request;
  if (
    typeof request !== 'object' ||
    request === null ||
    Array.isArray(request) ||
    request.native?.adapterId !== 'codex' ||
    request.native?.nativeSessionId !== codexSid
  ) {
    throw new Error('invalid Codex attach request');
  }
  const sessionFile = conversationSessionFile(temporaryDirectory, 'codex', codexSid);
  const attachArguments = sessionAttachArguments(request, sessionFile);
  return { cwd: request.workingDirectory, sessionFile, attachArguments };
}
