import { createHash } from 'node:crypto';

import { canonicalJsonStringify, type EvidenceType, type MessageKind } from '@luwi/protocol';

export type MessageRequestFingerprintInput = {
  sourceSessionId: string;
  targetSessionId?: string | undefined;
  targetAgentId?: string | undefined;
  kind: MessageKind;
  subject?: string | undefined;
  content: string;
  evidenceRequirements: readonly EvidenceType[];
  timeoutMs: number;
  retryOf?: string | undefined;
};

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function parseIdempotencyKey(value: string): string {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (normalized.length < 1 || normalized.length > 128 || hasControlCharacter) {
    throw new Error('Idempotency-Key must be 1-128 characters without control characters.');
  }
  return normalized;
}

export function hashIdempotencyKey(value: string): string {
  return createHash('sha256').update(parseIdempotencyKey(value), 'utf8').digest('hex');
}

export function createMessageRequestFingerprint(input: MessageRequestFingerprintInput): string {
  const normalizedEvidence = [...new Set(input.evidenceRequirements)].toSorted();
  const canonical = canonicalJsonStringify({
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    kind: input.kind,
    subject: input.subject ?? null,
    content: input.content,
    evidenceRequirements: normalizedEvidence,
    timeoutMs: input.timeoutMs,
    // A re-ask that declares a link to an earlier exchange is a different
    // request from the same words sent fresh; the fingerprint tells them apart.
    // Only when present: a request without the link must hash exactly as it
    // did before the field existed, or every idempotent replay that straddles
    // the deploy answers IDEMPOTENCY_KEY_CONFLICT against its own fingerprint.
    ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
