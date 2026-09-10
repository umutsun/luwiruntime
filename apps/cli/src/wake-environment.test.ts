import { describe, expect, it } from 'vitest';

import { sanitizeWakeChildEnvironment } from './wake-environment.js';

describe('wake child environment', () => {
  it('removes Redis, wake, and host Codex capabilities case-insensitively', () => {
    expect(
      sanitizeWakeChildEnvironment({
        PATH: 'C:/tools',
        CODEX_HOME: 'C:/codex-home',
        OPENAI_API_KEY: 'provider-auth-required-by-codex',
        codex_session_id: 'parent-session',
        CoDeX_ThReAd_Id: 'parent-thread',
        CODEX_APP_TOOLS_PIPE_PATH: 'private-pipe',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'parent-origin',
        CODEX_PERMISSION_PROFILE: 'parent-profile',
        luwi_wake_control_token: 'private-token',
        LUWI_WAKE_INSTANCE_ID: 'private-instance',
        LuWi_LiFeCyClE_ToKeN: 'daemon-stop-capability',
        luwi_runtime_instance_id: 'runtime-instance',
        Luwi_Session_Id: 'parent-luwi-session',
        LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
        redis_url: 'redis://private',
        CACHE_REDIS_URL: 'redis://also-private',
        LuWi_TeSt_AlLoW_ShArEd_ReDiS_FuNcTiOnS: 'true',
      }),
    ).toEqual({
      PATH: 'C:/tools',
      CODEX_HOME: 'C:/codex-home',
      OPENAI_API_KEY: 'provider-auth-required-by-codex',
    });
  });

  it('preserves only an explicitly injected LUWI daemon and session binding', () => {
    expect(
      sanitizeWakeChildEnvironment(
        {
          PATH: 'C:/tools',
          LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
          LUWI_SESSION_ID: 'target-session',
          LUWI_WAKE_CONTROL_TOKEN: 'private-token',
          CODEX_THREAD_ID: 'parent-thread',
          REDIS_URL: 'redis://private',
        },
        { preserveLuwiBinding: true },
      ),
    ).toEqual({
      PATH: 'C:/tools',
      LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
      LUWI_SESSION_ID: 'target-session',
    });
  });
});
