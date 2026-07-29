export type RedisFunctionRegistry = {
  libraryName: string;
  version: 1;
  functions: {
    projectRegister: string;
    sessionRegister: string;
    sessionHeartbeat: string;
    sessionStatus: string;
    sessionClose: string;
    sessionDisconnect: string;
    version: string;
  };
};

const productionFunctions = {
  projectRegister: 'luwi_project_register_v1',
  sessionRegister: 'luwi_session_register_v1',
  sessionHeartbeat: 'luwi_session_heartbeat_v1',
  sessionStatus: 'luwi_session_status_v1',
  sessionClose: 'luwi_session_close_v1',
  sessionDisconnect: 'luwi_session_disconnect_v1',
  version: 'luwi_function_version_v1',
} as const;

export function createFunctionRegistry(testSuffix?: string): RedisFunctionRegistry {
  if (testSuffix === undefined) {
    return {
      libraryName: 'luwi_v1',
      version: 1,
      functions: { ...productionFunctions },
    };
  }

  if (!/^[A-Za-z0-9_]{1,64}$/.test(testSuffix)) {
    throw new Error('Invalid Redis Function test suffix');
  }

  return {
    libraryName: `luwi_test_${testSuffix}_v1`,
    version: 1,
    functions: Object.fromEntries(
      Object.entries(productionFunctions).map(([key, value]) => [key, `${value}_${testSuffix}`]),
    ) as RedisFunctionRegistry['functions'],
  };
}
