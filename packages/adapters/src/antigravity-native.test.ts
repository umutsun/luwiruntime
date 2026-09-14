import { describe, expect, it } from 'vitest';

import { findAntigravityTitle, type AntigravityFileSystem } from './antigravity-native.js';

// --- Minimal protobuf encoder, enough to build a fake agyhub_summaries_proto.pb ---
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
function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}
function str(field: number, s: string): number[] {
  const bytes = [...Buffer.from(s, 'utf8')];
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}
function msg(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...varint(body.length), ...body];
}

/** One .pb envelope: #1 convId, #2 summary{ #1 title, #9 workspace{ #1 uri } }. */
function record(convId: string, title: string, workspaceUri: string): number[] {
  const summary = [...str(1, title), ...msg(9, str(1, workspaceUri))];
  return msg(1, [...str(1, convId), ...msg(2, summary)]);
}

const AG = 'C:/u/.gemini/antigravity';
const PB = `${AG}/agyhub_summaries_proto.pb`;

function fakeFs(pb: number[]): AntigravityFileSystem {
  return {
    async readFileBytes(path) {
      return path === PB ? Uint8Array.from(pb) : undefined;
    },
  };
}

describe('findAntigravityTitle', () => {
  it('returns the title for a conversation id, and undefined for an unknown one', async () => {
    const pb = [
      ...record('conv-a', 'Claude Code Görev Dağıtımı', 'file:///c:/xampp/htdocs/albanoosh'),
      ...record('conv-b', 'Other chat', 'file:///c:/xampp/htdocs/flybydeniz'),
    ];
    const fs = fakeFs(pb);
    expect(await findAntigravityTitle(fs, AG, 'conv-a')).toBe('Claude Code Görev Dağıtımı');
    expect(await findAntigravityTitle(fs, AG, 'conv-b')).toBe('Other chat');
    expect(await findAntigravityTitle(fs, AG, 'missing')).toBeUndefined();
  });

  it('is undefined when the summaries file is absent or unparseable', async () => {
    const absent: AntigravityFileSystem = { readFileBytes: async () => undefined };
    expect(await findAntigravityTitle(absent, AG, 'conv-a')).toBeUndefined();

    const garbage: AntigravityFileSystem = {
      readFileBytes: async () => Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
    };
    expect(await findAntigravityTitle(garbage, AG, 'conv-a')).toBeUndefined();
  });
});
