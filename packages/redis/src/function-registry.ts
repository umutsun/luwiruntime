export type RedisFunctionRegistry = {
  libraryName: string;
  /**
   * 13 since the re-dispatch link: the stored message record gained an
   * optional `retryOf`, and the projection returns it. Before that 12 since
   * B1. The version moves only when a **record shape** changes, which
   * is why B0 stayed at 11 despite adding `native_declare`: `isCompatible`
   * hashes the source and compares the function-name list, so a new function
   * already forces a reload on its own. B1 adds `cacheCreationInputTokens` and
   * `cacheReadInputTokens` to the stored usage record, and that is a shape
   * change, so the version moves with it.
   */
  version: 13;
  functions: {
    projectRegister: string;
    projectUpdate: string;
    projectUnregister: string;
    sessionRegister: string;
    sessionHeartbeat: string;
    sessionStatus: string;
    sessionClose: string;
    sessionDisconnect: string;
    sessionReapStarting: string;
    nativeLinkTrim: string;
    nativeDeclare: string;
    messageRequest: string;
    messageDelivered: string;
    messageAcknowledge: string;
    messageProcessing: string;
    messageRespond: string;
    messageReject: string;
    messageFail: string;
    messageTimeout: string;
    leaseAcquire: string;
    leaseRenew: string;
    leaseRelease: string;
    leaseExpire: string;
    coordinatorClaim: string;
    coordinatorRelease: string;
    controlUpsert: string;
    controlDelete: string;
    controlPlanTransition: string;
    controlPlanComplete: string;
    usageIngest: string;
    graphRebuildTransition: string;
    intelligenceBatchTransition: string;
    graphProjectionFailure: string;
    version: string;
  };
};

const productionFunctions = {
  projectRegister: 'luwi_project_register_v1',
  projectUpdate: 'luwi_project_update_v1',
  projectUnregister: 'luwi_project_unregister_v1',
  sessionRegister: 'luwi_session_register_v1',
  sessionHeartbeat: 'luwi_session_heartbeat_v1',
  sessionStatus: 'luwi_session_status_v1',
  sessionClose: 'luwi_session_close_v1',
  sessionDisconnect: 'luwi_session_disconnect_v1',
  sessionReapStarting: 'luwi_session_reap_starting_v1',
  nativeLinkTrim: 'luwi_native_link_trim_v1',
  nativeDeclare: 'luwi_native_declare_v1',
  messageRequest: 'luwi_message_request_v1',
  messageDelivered: 'luwi_message_delivered_v1',
  messageAcknowledge: 'luwi_message_acknowledge_v1',
  messageProcessing: 'luwi_message_processing_v1',
  messageRespond: 'luwi_message_respond_v1',
  messageReject: 'luwi_message_reject_v1',
  messageFail: 'luwi_message_fail_v1',
  messageTimeout: 'luwi_message_timeout_v1',
  leaseAcquire: 'luwi_lease_acquire_v1',
  leaseRenew: 'luwi_lease_renew_v1',
  leaseRelease: 'luwi_lease_release_v1',
  leaseExpire: 'luwi_lease_expire_v1',
  coordinatorClaim: 'luwi_coordinator_claim_v1',
  coordinatorRelease: 'luwi_coordinator_release_v1',
  controlUpsert: 'luwi_control_upsert_v1',
  controlDelete: 'luwi_control_delete_v1',
  controlPlanTransition: 'luwi_control_plan_transition_v1',
  controlPlanComplete: 'luwi_control_plan_complete_v1',
  usageIngest: 'luwi_usage_ingest_v1',
  graphRebuildTransition: 'luwi_graph_rebuild_transition_v1',
  intelligenceBatchTransition: 'luwi_intelligence_batch_transition_v1',
  graphProjectionFailure: 'luwi_graph_projection_failure_v1',
  version: 'luwi_function_version_v1',
} as const;

export function createFunctionRegistry(testSuffix?: string): RedisFunctionRegistry {
  if (testSuffix === undefined) {
    return {
      libraryName: 'luwi_v1',
      version: 13,
      functions: { ...productionFunctions },
    };
  }

  if (!/^[A-Za-z0-9_]{1,64}$/.test(testSuffix)) {
    throw new Error('Invalid Redis Function test suffix');
  }

  return {
    libraryName: `luwi_test_${testSuffix}_v1`,
    version: 13,
    functions: Object.fromEntries(
      Object.entries(productionFunctions).map(([key, value]) => [key, `${value}_${testSuffix}`]),
    ) as RedisFunctionRegistry['functions'],
  };
}
