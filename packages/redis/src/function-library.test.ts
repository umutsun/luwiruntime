import { describe, expect, it } from 'vitest';

import { buildFunctionLibrary } from './function-library.js';
import { createFunctionRegistry } from './function-registry.js';

describe('Redis Function library project restoration', () => {
  it('preserves canonical project timestamps only when both are supplied', () => {
    const source = buildFunctionLibrary(createFunctionRegistry()).source;

    expect(source).toContain(
      "if type(project.createdAt) == 'string' and type(project.updatedAt) == 'string' then",
    );
    expect(source).toContain('stored.createdAt = project.createdAt');
    expect(source).toContain('stored.updatedAt = project.updatedAt');
  });

  it('reports version 13 for both production and isolated libraries without adding callbacks', () => {
    const production = buildFunctionLibrary(createFunctionRegistry());
    const isolated = buildFunctionLibrary(createFunctionRegistry('library_test'));

    expect(production.registry.version).toBe(13);
    expect(isolated.registry.version).toBe(13);
    expect(isolated.source).toContain('#!lua name=luwi_test_library_test_v1');
    expect(Object.values(isolated.registry.functions)).toHaveLength(
      Object.values(production.registry.functions).length,
    );
  });
});
