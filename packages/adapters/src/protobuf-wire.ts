/**
 * A schema-less protobuf wire reader — just enough to walk Antigravity's on-disk
 * messages by field number. Antigravity writes no JSON; its stores are protobuf
 * with no `.proto` shipped, but field numbers are a stable wire contract, so
 * reading the specific fields we need is safe. Every reader here is best-effort:
 * a non-protobuf or truncated buffer yields whatever parsed before the break,
 * never a throw, so a corrupt record degrades to "no value" not a crash.
 */

export type WireValue = { wire: number; bytes?: Uint8Array; value?: bigint };

/** Reads a base-128 varint at `pos`, returning the value and the next position. */
export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++]!;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, p];
}

/**
 * Walks one protobuf message into a field-number → occurrences map. An unknown
 * wire type or an over-long length aborts the walk (returning what parsed), so a
 * non-protobuf buffer is a partial read rather than a throw.
 */
export function walkMessage(buf: Uint8Array): Map<number, WireValue[]> {
  const out = new Map<number, WireValue[]>();
  let pos = 0;
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos);
    pos = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) break;
    let entry: WireValue;
    if (wire === 0) {
      const [value, next] = readVarint(buf, pos);
      pos = next;
      entry = { wire, value };
    } else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, pos);
      const end = afterLen + Number(len);
      if (end > buf.length) break;
      entry = { wire, bytes: buf.subarray(afterLen, end) };
      pos = end;
    } else if (wire === 1) {
      pos += 8;
      entry = { wire };
    } else if (wire === 5) {
      pos += 4;
      entry = { wire };
    } else {
      break;
    }
    const list = out.get(field);
    if (list === undefined) out.set(field, [entry]);
    else list.push(entry);
  }
  return out;
}

export function firstBytes(map: Map<number, WireValue[]>, field: number): Uint8Array | undefined {
  return map.get(field)?.[0]?.bytes;
}

export function firstMessage(
  map: Map<number, WireValue[]>,
  field: number,
): Map<number, WireValue[]> | undefined {
  const bytes = firstBytes(map, field);
  return bytes === undefined ? undefined : walkMessage(bytes);
}

export function firstString(map: Map<number, WireValue[]>, field: number): string | undefined {
  const bytes = firstBytes(map, field);
  if (bytes === undefined) return undefined;
  const text = Buffer.from(bytes).toString('utf8');
  return text.length === 0 ? undefined : text;
}

export function firstVarint(map: Map<number, WireValue[]>, field: number): number | undefined {
  const value = map.get(field)?.[0]?.value;
  return value === undefined ? undefined : Number(value);
}
