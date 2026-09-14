import { describe, expect, it } from 'vitest';

import {
  createAntigravityUsageReader,
  parseGenMetadataUsage,
  parseStepTimestampMs,
} from './antigravity-usage-reader.js';

// --- Minimal protobuf encoder for building fixture blobs ---
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
function str(field: number, s: string): number[] {
  const bytes = [...Buffer.from(s, 'utf8')];
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}
function msg(field: number, body: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(body.length), ...body];
}
function vint(field: number, n: number): number[] {
  return [...varint((field << 3) | 0), ...varint(n)];
}

/**
 * One gen_metadata record, mirroring the measured layout:
 * #1{ #4{ #2 input, #3 output, #5 cacheRead, #9 candidates, #10 thoughts },
 *     #19 model, #20 kv{ #1 key, #2 value }* }
 */
function genMetadata(fields: {
  input: number;
  output: number;
  cacheRead: number;
  model: string;
  requestId: string;
  lastStepIndex: number;
}): Uint8Array {
  const usage = [...vint(2, fields.input), ...vint(3, fields.output), ...vint(5, fields.cacheRead)];
  const body = [
    ...msg(4, usage),
    ...str(19, fields.model),
    ...msg(20, [...str(1, 'request_id'), ...str(2, fields.requestId)]),
    ...msg(20, [...str(1, 'last_step_index'), ...str(2, String(fields.lastStepIndex))]),
    ...msg(20, [...str(1, 'used_claude'), ...str(2, 'false')]),
  ];
  return Uint8Array.from(msg(1, body));
}

describe('parseGenMetadataUsage', () => {
  it('extracts the request id, model, and the token split', () => {
    const bytes = genMetadata({
      input: 4887,
      output: 231,
      cacheRead: 146832,
      model: 'gemini-3.8-flash',
      requestId: 'ce8f3665-54',
      lastStepIndex: 108,
    });
    expect(parseGenMetadataUsage(bytes)).toEqual({
      requestId: 'ce8f3665-54',
      model: 'gemini-3.8-flash',
      inputTokens: 4887,
      outputTokens: 231,
      cacheReadInputTokens: 146832,
      cacheCreationInputTokens: 0,
      lastStepIndex: 108,
    });
  });

  it('treats an absent cache field as zero (a first, uncached turn)', () => {
    // No field #5 in the usage block.
    const usage = [...vint(2, 19596), ...vint(3, 403)];
    const body = [
      ...msg(4, usage),
      ...str(19, 'gemini-3.8-flash'),
      ...msg(20, [...str(1, 'request_id'), ...str(2, 'r-0')]),
      ...msg(20, [...str(1, 'last_step_index'), ...str(2, '0')]),
    ];
    const parsed = parseGenMetadataUsage(Uint8Array.from(msg(1, body)));
    expect(parsed?.inputTokens).toBe(19596);
    expect(parsed?.cacheReadInputTokens).toBe(0);
    expect(parsed?.lastStepIndex).toBe(0);
  });

  it('returns undefined when there is no request id (a non-usage record)', () => {
    const body = [...msg(4, vint(2, 100)), ...str(19, 'gemini-3.8-flash')];
    expect(parseGenMetadataUsage(Uint8Array.from(msg(1, body)))).toBeUndefined();
  });

  it('returns undefined for a non-protobuf blob', () => {
    expect(parseGenMetadataUsage(Uint8Array.from([0xff, 0xff, 0xff]))).toBeUndefined();
  });
});

describe('parseStepTimestampMs', () => {
  it('returns the latest epoch-seconds timestamp in the step metadata, in ms', () => {
    // Two nested Timestamp messages { #1 seconds }, latest wins.
    const meta = [...msg(3, msg(1, vint(1, 1789387880))), ...msg(4, msg(1, vint(1, 1789388395)))];
    expect(parseStepTimestampMs(Uint8Array.from(meta))).toBe(1789388395000);
  });

  it('ignores token-sized varints and returns undefined when no timestamp is present', () => {
    const meta = [...vint(1, 4887), ...vint(2, 146832)];
    expect(parseStepTimestampMs(Uint8Array.from(meta))).toBeUndefined();
  });
});

// --- Reader orchestration ---
function stepMeta(seconds: number): Uint8Array {
  return Uint8Array.from(msg(4, msg(1, vint(1, seconds))));
}

describe('createAntigravityUsageReader.scan', () => {
  const conv = {
    conversationId: '15a0e2ea',
    path: 'C:/ag/conversations/15a0e2ea.db',
    modifiedAtMs: 1000,
    sizeBytes: 500,
  };
  const genA = () =>
    genMetadata({
      input: 4887,
      output: 231,
      cacheRead: 146832,
      model: 'gemini-3.8-flash',
      requestId: 'ce8f3665-54',
      lastStepIndex: 108,
    });

  it('emits one observation per generation, joined to its step timestamp', async () => {
    const reader = createAntigravityUsageReader({
      store: {
        listConversations: async () => [conv],
        readConversation: async () => ({
          genMetadata: [genA()],
          stepMetadata: new Map([[108, stepMeta(1789388395)]]),
        }),
      },
    });
    const result = await reader.scan({ root: 'C:/ag/conversations' });
    expect(result.observations).toEqual([
      {
        nativeSessionId: '15a0e2ea',
        requestId: 'ce8f3665-54',
        model: 'gemini-3.8-flash',
        observedAt: '2026-09-14T12:19:55.000Z',
        inputTokens: 4887,
        outputTokens: 231,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 146832,
      },
    ]);
    expect(result.filesScanned).toBe(1);
    expect(result.cursors[conv.path]).toEqual({ modifiedAtMs: 1000, sizeBytes: 500 });
  });

  it('skips a conversation whose cursor is byte-for-byte unchanged', async () => {
    let reads = 0;
    const reader = createAntigravityUsageReader({
      store: {
        listConversations: async () => [conv],
        readConversation: async () => {
          reads += 1;
          return { genMetadata: [genA()], stepMetadata: new Map([[108, stepMeta(1789388395)]]) };
        },
      },
    });
    const result = await reader.scan({
      root: 'C:/ag/conversations',
      cursors: { [conv.path]: { modifiedAtMs: 1000, sizeBytes: 500 } },
    });
    expect(reads).toBe(0);
    expect(result.filesSkippedUnchanged).toBe(1);
    expect(result.observations).toEqual([]);
  });

  it('counts a generation with no resolvable timestamp instead of attributing it', async () => {
    const reader = createAntigravityUsageReader({
      store: {
        listConversations: async () => [conv],
        readConversation: async () => ({
          genMetadata: [genA()],
          stepMetadata: new Map(), // step 108 absent → no timestamp
        }),
      },
    });
    const result = await reader.scan({ root: 'C:/ag/conversations' });
    expect(result.observations).toEqual([]);
    expect(result.malformedLines).toBe(1);
  });
});
