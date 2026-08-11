import { createHash } from 'node:crypto';

import type { NativeSessionKind, NativeSessionRef } from '@luwi/protocol';

/**
 * Identifiers derived from a native reference.
 *
 * They are deterministic so that a repeated declaration is idempotent rather
 * than duplicating state, and `adapterId` leads the binding preimage so two
 * vendors cannot collide on an identical native identifier.
 *
 * The separator is not decoration. Without it `('ab', 'cd')` and `('a', 'bcd')`
 * would hash identically. NUL is used because it cannot appear inside a value
 * that passed `nativeSessionRefSchema`, so it is an unambiguous boundary. It is
 * built with `String.fromCharCode` rather than written literally, because a raw
 * NUL byte in a source file makes git treat that file as binary.
 *
 * A raw native value never reaches a Redis key: `keyPart` would reject many of
 * them, and hashing is the precedent `projectPathIndex` already set.
 */

const SEPARATOR = String.fromCharCode(0);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function deriveNativeBindingId(ref: NativeSessionRef): string {
  return sha256([ref.adapterId, ref.nativeSessionId, ref.nativeSubagentId ?? ''].join(SEPARATOR));
}

export function deriveNativeLinkId(bindingId: string, sessionId: string): string {
  return sha256([bindingId, sessionId].join(SEPARATOR));
}

export function deriveNativeKind(ref: NativeSessionRef): NativeSessionKind {
  return ref.nativeSubagentId === undefined ? 'main' : 'subagent';
}

/** A subagent's parent is its reference minus the subagent identifier. */
export function deriveParentRef(ref: NativeSessionRef): NativeSessionRef | undefined {
  return ref.nativeSubagentId === undefined
    ? undefined
    : { adapterId: ref.adapterId, nativeSessionId: ref.nativeSessionId };
}
