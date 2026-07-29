import { describe, expect, it } from 'vitest';

import { buildFunctionLibrary, createFunctionRegistry } from './index.js';

const productionFunctionNames = [
  'luwi_project_register_v1',
  'luwi_session_register_v1',
  'luwi_session_heartbeat_v1',
  'luwi_session_status_v1',
  'luwi_session_close_v1',
  'luwi_session_disconnect_v1',
  'luwi_function_version_v1',
];

describe('Redis Function registry', () => {
  it('uses the approved production library and function names', () => {
    const registry = createFunctionRegistry();

    expect(registry.libraryName).toBe('luwi_v1');
    expect(Object.values(registry.functions)).toEqual(productionFunctionNames);
  });

  it('namespaces both test library and every registered function', () => {
    const registry = createFunctionRegistry('run_123');

    expect(registry.libraryName).toBe('luwi_test_run_123_v1');
    for (const functionName of Object.values(registry.functions)) {
      expect(functionName).toContain('run_123');
      expect(productionFunctionNames).not.toContain(functionName);
    }
  });

  it('builds stable versioned Lua source and a SHA-256 content hash', () => {
    const library = buildFunctionLibrary(createFunctionRegistry());
    const repeated = buildFunctionLibrary(createFunctionRegistry());

    expect(library.source).toContain('#!lua name=luwi_v1');
    for (const functionName of productionFunctionNames) {
      expect(library.source).toContain(functionName);
    }
    expect(library.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated.contentHash).toBe(library.contentHash);
  });
});
