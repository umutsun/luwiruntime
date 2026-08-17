import { nativeSessionRefSchema, type AgentKind, type NativeSessionRef } from '@luwi/protocol';

/**
 * Resolves the vendor-native identity a session should declare about itself.
 *
 * This decides what a binding means, so a wrong answer here attributes one
 * session's tokens to another. Two rules follow from that, and both are
 * deliberate:
 *
 * - **The environment is injected.** Reading `process.env` inside would make
 *   the resolver untestable on a machine that happens to be running inside a
 *   session — which is exactly where this is developed.
 * - **An unusable value resolves to nothing, never to a guess.** A session that
 *   registers without a native block is honestly unattributed; one that
 *   registers with a fabricated block is silently wrong.
 */

export type NativeIdentityEnvironment = Readonly<Record<string, string | undefined>>;

function usable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Claude Code carries its session id in the environment, byte-identical to the
 * transcript stem the ADR 0023 reader joins on, so no discovery is needed.
 *
 * A child session is a subagent of the id it carries rather than a session of
 * its own: its tokens belong to the session that spawned it, and inventing a
 * second main session would split that evidence in two.
 */
function resolveClaudeCode(environment: NativeIdentityEnvironment): NativeSessionRef | undefined {
  const nativeSessionId = usable(environment['CLAUDE_CODE_SESSION_ID']);
  if (nativeSessionId === undefined) return undefined;

  const isChild = usable(environment['CLAUDE_CODE_CHILD_SESSION']) === '1';
  const nativeSubagentId = isChild ? usable(environment['CLAUDE_PID']) : undefined;

  // The protocol owns what a native id may look like; validating here against
  // its own schema is what keeps a malformed environment from producing a
  // reference the daemon would only refuse later.
  const candidate = {
    adapterId: 'claude-code',
    nativeSessionId,
    ...(nativeSubagentId === undefined ? {} : { nativeSubagentId }),
  };
  const parsed = nativeSessionRefSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // A bad subagent id must not cost us the session id, which is still good
  // evidence on its own.
  if (nativeSubagentId === undefined) return undefined;
  const withoutSubagent = nativeSessionRefSchema.safeParse({
    adapterId: 'claude-code',
    nativeSessionId,
  });
  return withoutSubagent.success ? withoutSubagent.data : undefined;
}

export function resolveNativeIdentity(
  kind: AgentKind,
  environment: NativeIdentityEnvironment,
): NativeSessionRef | undefined {
  switch (kind) {
    case 'claude-code':
      return resolveClaudeCode(environment);
    /**
     * Codex and Gemini keep session identity in a file layout rather than the
     * environment — `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
     * and `~/.gemini/history/<project>/`. Those layouts have not been measured
     * the way Claude's was, and a resolver that guessed would mint a binding
     * that never matches a transcript. They register without a native block
     * until the measurement exists.
     */
    default:
      return undefined;
  }
}
