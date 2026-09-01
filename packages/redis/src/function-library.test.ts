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
});
