import { describe, expect, it } from 'vitest';

import { buildFunctionLibrary, createFunctionRegistry } from './index.js';

const productionFunctionNames = [
  'luwi_project_register_v1',
  'luwi_session_register_v1',
  'luwi_session_heartbeat_v1',
  'luwi_session_status_v1',
  'luwi_session_close_v1',
  'luwi_session_disconnect_v1',
  'luwi_bridge_slot_acquire_v1',
  'luwi_bridge_slot_renew_v1',
  'luwi_bridge_slot_attach_v1',
  'luwi_bridge_slot_release_v1',
  'luwi_bridge_slot_expire_v1',
  'luwi_native_link_trim_v1',
  'luwi_native_declare_v1',
  'luwi_workflow_create_v1',
  'luwi_message_request_v1',
  'luwi_message_delivered_v1',
  'luwi_message_acknowledge_v1',
  'luwi_message_processing_v1',
  'luwi_message_respond_v1',
  'luwi_message_reject_v1',
  'luwi_message_fail_v1',
  'luwi_message_timeout_v1',
  'luwi_wake_claim_v1',
  'luwi_wake_dispatching_v1',
  'luwi_wake_complete_v1',
  'luwi_wake_recover_dispatching_v1',
  'luwi_wake_sweep_v1',
  'luwi_lease_acquire_v1',
  'luwi_lease_renew_v1',
  'luwi_lease_release_v1',
  'luwi_lease_expire_v1',
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
    const library = buildFunctionLibrary(registry);

    expect(registry.libraryName).toBe('luwi_test_run_123_v1');
    for (const functionName of Object.values(registry.functions)) {
      expect(functionName).toContain('run_123');
      expect(productionFunctionNames).not.toContain(functionName);
      expect(library.source).toContain(`function_name='${functionName}'`);
    }
  });

  it('rejects invalid test suffixes and creates disjoint registries', () => {
    for (const suffix of ['', 'bad-suffix', 'x'.repeat(65)]) {
      expect(() => createFunctionRegistry(suffix)).toThrow('Invalid Redis Function test suffix');
    }

    const left = createFunctionRegistry('left');
    const right = createFunctionRegistry('right');
    expect(left.libraryName).not.toBe(right.libraryName);
    expect(new Set(Object.values(left.functions))).toHaveLength(
      Object.values(left.functions).length,
    );
    expect(
      Object.values(left.functions).some((name) => Object.values(right.functions).includes(name)),
    ).toBe(false);
  });

  it('builds stable versioned Lua source and a SHA-256 content hash', () => {
    const library = buildFunctionLibrary(createFunctionRegistry());
    const repeated = buildFunctionLibrary(createFunctionRegistry());

    expect(library.source).toContain('#!lua name=luwi_v1');
    for (const functionName of productionFunctionNames) {
      expect(library.source).toContain(functionName);
    }
    for (const functionName of Object.values(library.registry.functions)) {
      expect(library.source).toContain(`function_name='${functionName}'`);
    }
    expect(library.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated.contentHash).toBe(library.contentHash);
  });
});
