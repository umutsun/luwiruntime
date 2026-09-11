import { nativeSessionRefSchema, type NativeSessionRef } from '@luwi/protocol';
import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import type { McpSessionBindingConfig } from './config.js';

const MAX_SESSION_FILE_BYTES = 4096;
const sessionBindingRecordSchema = z.strictObject({
  attached: z.string().trim().min(1).max(128),
  /** Written by `session attach` so a successor can re-declare it (ADR 0034). */
  native: nativeSessionRefSchema.optional(),
});

/** What the binding names: the attached session, and its native reference when declared. */
export type SessionBindingRecord = { attached: string; native?: NativeSessionRef };

export class McpSessionBindingError extends Error {
  readonly code = 'MCP_SESSION_BINDING_INVALID';

  constructor() {
    super('The LUWI session binding file is unavailable or invalid.');
    this.name = 'McpSessionBindingError';
  }
}

const invalidBinding = (): never => {
  throw new McpSessionBindingError();
};

async function readSessionFile(path: string): Promise<SessionBindingRecord> {
  let handle;
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) invalidBinding();
    const flags =
      process.platform === 'win32'
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    handle = await open(path, flags);
    const snapshot = await handle.stat();
    if (!snapshot.isFile() || snapshot.size <= 0 || snapshot.size > MAX_SESSION_FILE_BYTES) {
      invalidBinding();
    }
    const currentEntry = await lstat(path);
    if (
      currentEntry.isSymbolicLink() ||
      !currentEntry.isFile() ||
      entry.dev !== snapshot.dev ||
      entry.ino !== snapshot.ino ||
      currentEntry.dev !== snapshot.dev ||
      currentEntry.ino !== snapshot.ino
    ) {
      invalidBinding();
    }
    if (process.platform !== 'win32' && (snapshot.mode & 0o077) !== 0) invalidBinding();
    const buffer = Buffer.allocUnsafe(MAX_SESSION_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead > MAX_SESSION_FILE_BYTES) invalidBinding();
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      invalidBinding();
    }
    const record = sessionBindingRecordSchema.parse(parsed);
    return record.native === undefined
      ? { attached: record.attached }
      : { attached: record.attached, native: record.native };
  } catch (error) {
    if (error instanceof McpSessionBindingError) throw error;
    throw new McpSessionBindingError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createSessionBindingResolver(
  binding: McpSessionBindingConfig,
): () => Promise<SessionBindingRecord> {
  if (binding.kind === 'static') return async () => ({ attached: binding.sessionId });
  return () => readSessionFile(binding.path);
}

export function createSessionIdResolver(binding: McpSessionBindingConfig): () => Promise<string> {
  const resolveBinding = createSessionBindingResolver(binding);
  return async () => (await resolveBinding()).attached;
}
