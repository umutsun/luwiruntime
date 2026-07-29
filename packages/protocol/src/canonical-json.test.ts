import { describe, expect, it } from 'vitest';

import { canonicalJsonStringify } from './index.js';

describe('canonical JSON', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(
      canonicalJsonStringify({
        z: 1,
        nested: { b: true, a: null },
        array: [{ y: 2, x: 1 }, 'value'],
      }),
    ).toBe('{"array":[{"x":1,"y":2},"value"],"nested":{"a":null,"b":true},"z":1}');
  });
});
