import { describe, expect, it } from 'vitest';

import * as redis from './index.js';

describe('bridge slot repository contract', () => {
  it('exports the repository factory', () => {
    expect(redis).toHaveProperty('createBridgeSlotRepository', expect.any(Function));
  });

  it('registers all five slot transitions with isolated callback names at version 13', () => {
    const registry = redis.createFunctionRegistry('bridge_test');
    const library = redis.buildFunctionLibrary(registry);
    expect(registry.version).toBe(13);
    for (const operation of ['acquire', 'renew', 'attach', 'release', 'expire']) {
      expect(Object.values(registry.functions)).toContain(
        `luwi_bridge_slot_${operation}_v1_bridge_test`,
      );
      expect(library.source).toContain(`callback=bridge_slot_${operation}`);
    }
  });
});
