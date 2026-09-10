const PRIVATE_WAKE_CHILD_KEYS = new Set([
  'LUWI_WAKE_CONTROL_TOKEN',
  'LUWI_WAKE_INSTANCE_ID',
  'LUWI_LIFECYCLE_TOKEN',
  'LUWI_RUNTIME_INSTANCE_ID',
  'LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS',
]);

const LUWI_BINDING_KEYS = new Set(['LUWI_DAEMON_URL', 'LUWI_SESSION_ID']);

export type WakeChildEnvironmentOptions = {
  /** Keep only the LUWI binding that the caller has explicitly injected for the child. */
  preserveLuwiBinding?: boolean;
};

function isPrivateWakeChildKey(key: string, options: WakeChildEnvironmentOptions): boolean {
  const normalized = key.toUpperCase();
  if (normalized === 'REDIS_URL' || normalized.endsWith('_REDIS_URL')) return true;
  if (normalized.startsWith('CODEX_') && normalized !== 'CODEX_HOME') return true;
  if (LUWI_BINDING_KEYS.has(normalized)) return options.preserveLuwiBinding !== true;
  return PRIVATE_WAKE_CHILD_KEYS.has(normalized);
}

/**
 * Native wake children receive only host process state they need. Runtime
 * ownership tokens and Redis credentials stay in the supervisor process.
 */
export function sanitizeWakeChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  options: WakeChildEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !isPrivateWakeChildKey(key, options)) result[key] = value;
  }
  return result;
}
