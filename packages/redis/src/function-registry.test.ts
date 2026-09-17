import { describe, expect, it } from 'vitest';

import { buildFunctionLibrary, createFunctionRegistry } from './index.js';

const productionFunctionNames = [
  'luwi_project_register_v1',
  'luwi_project_update_v1',
  'luwi_project_unregister_v1',
  'luwi_session_register_v1',
  'luwi_session_heartbeat_v1',
  'luwi_session_status_v1',
  'luwi_session_close_v1',
  'luwi_session_disconnect_v1',
  'luwi_session_reap_starting_v1',
  'luwi_native_link_trim_v1',
  'luwi_native_declare_v1',
  'luwi_message_request_v1',
  'luwi_message_delivered_v1',
  'luwi_message_acknowledge_v1',
  'luwi_message_processing_v1',
  'luwi_message_respond_v1',
  'luwi_message_reject_v1',
  'luwi_message_fail_v1',
  'luwi_message_timeout_v1',
  'luwi_lease_acquire_v1',
  'luwi_lease_renew_v1',
  'luwi_lease_release_v1',
  'luwi_lease_expire_v1',
  'luwi_coordinator_claim_v1',
  'luwi_coordinator_release_v1',
  'luwi_control_upsert_v1',
  'luwi_control_delete_v1',
  'luwi_control_plan_transition_v1',
  'luwi_control_plan_complete_v1',
  'luwi_usage_ingest_v1',
  'luwi_graph_rebuild_transition_v1',
  'luwi_intelligence_batch_transition_v1',
  'luwi_graph_projection_failure_v1',
  'luwi_function_version_v1',
];

describe('Redis Function registry', () => {
  it('uses the approved production library and function names', () => {
    const registry = createFunctionRegistry();

    expect(registry.libraryName).toBe('luwi_v1');
    expect(registry.version).toBe(13);
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
