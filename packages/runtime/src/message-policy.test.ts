import { describe, expect, it } from 'vitest';

import {
  createMessageRequestFingerprint,
  hashIdempotencyKey,
  parseIdempotencyKey,
  utf8ByteLength,
} from './index.js';

describe('message policy', () => {
  const request = {
    sourceSessionId: 'source',
    targetAgentId: 'gemini-sim',
    kind: 'question' as const,
    subject: 'Project status',
    content: 'Have you completed the work?',
    evidenceRequirements: ['session_state' as const],
    timeoutMs: 120_000,
  };

  it('creates a deterministic fingerprint from normalized request semantics', () => {
    const reordered = {
      timeoutMs: 120_000,
      content: 'Have you completed the work?',
      evidenceRequirements: ['session_state' as const],
      subject: 'Project status',
      kind: 'question' as const,
      targetAgentId: 'gemini-sim',
      sourceSessionId: 'source',
    };

    expect(createMessageRequestFingerprint(request)).toBe(
      createMessageRequestFingerprint(reordered),
    );
    expect(
      createMessageRequestFingerprint({
        ...request,
        content: 'Different question',
      }),
    ).not.toBe(createMessageRequestFingerprint(request));
  });

  it('normalizes evidence requirements without changing target selector semantics', () => {
    expect(
      createMessageRequestFingerprint({
        ...request,
        evidenceRequirements: ['test_result', 'session_state', 'test_result'],
      }),
    ).toBe(
      createMessageRequestFingerprint({
        ...request,
        evidenceRequirements: ['session_state', 'test_result'],
      }),
    );
    expect(
      createMessageRequestFingerprint({
        ...request,
        targetAgentId: undefined,
        targetSessionId: 'target',
      }),
    ).not.toBe(createMessageRequestFingerprint(request));
  });

  it('validates and hashes opaque idempotency keys without exposing them', () => {
    expect(parseIdempotencyKey(' retry-1 ')).toBe('retry-1');
    expect(hashIdempotencyKey('retry-1')).toMatch(/^[a-f0-9]{64}$/);
    expect(() => parseIdempotencyKey('   ')).toThrow();
    expect(() => parseIdempotencyKey(`invalid\nkey`)).toThrow();
    expect(() => parseIdempotencyKey('x'.repeat(129))).toThrow();
  });

  it('measures UTF-8 bytes', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('🙂')).toBe(4);
  });
});
