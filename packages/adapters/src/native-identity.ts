import { nativeSessionRefSchema, type AgentKind, type NativeSessionRef } from '@luwi/protocol';

/**
 * Resolves the vendor-native identity a session should declare about itself.
 *
 * This decides what a binding means, so a wrong answer here attributes one
 * session's tokens to another. Three rules follow from that, and all are
 * deliberate:
 *
 * - **The environment is injected.** Reading `process.env` inside would make the
 *   resolver untestable on a machine that happens to be running inside a session
 *   — which is exactly where this is developed.
 * - **An unusable value resolves to nothing, never to a guess.** A session that
 *   registers without a native block is honestly unattributed; one that registers
 *   with a fabricated block is silently wrong.
 * - **Vendors are a registry, so a new agent is one entry.** Each vendor is a
 *   resolver keyed by its `AgentKind`. An env-based vendor uses
 *   `envSessionResolver`; a vendor with richer rules gets its own function; a
 *   vendor whose identity LUWI cannot read has no entry and registers without a
 *   native block.
 */

export type NativeIdentityEnvironment = Readonly<Record<string, string | undefined>>;

type NativeIdentityResolver = (
  environment: NativeIdentityEnvironment,
) => NativeSessionRef | undefined;

function usable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Validates a candidate against the protocol's own schema. Validating here is
 * what keeps a malformed environment from producing a reference the daemon would
 * only refuse later.
 */
function validated(
  adapterId: string,
  nativeSessionId: string,
  nativeSubagentId?: string,
): NativeSessionRef | undefined {
  const parsed = nativeSessionRefSchema.safeParse({
    adapterId,
    nativeSessionId,
    ...(nativeSubagentId === undefined ? {} : { nativeSubagentId }),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * The common case: a vendor that carries its session id in one environment
 * variable, exactly as Claude does. Adding such a vendor is one registry entry.
 */
function envSessionResolver(adapterId: string, variable: string): NativeIdentityResolver {
  return (environment) => {
    const nativeSessionId = usable(environment[variable]);
    return nativeSessionId === undefined ? undefined : validated(adapterId, nativeSessionId);
  };
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

  const withSubagent = validated('claude-code', nativeSessionId, nativeSubagentId);
  if (withSubagent !== undefined) return withSubagent;

  // A bad subagent id must not cost the session id, which is still good evidence.
  return nativeSubagentId === undefined ? undefined : validated('claude-code', nativeSessionId);
}

/**
 * Codex records a per-session `session_id` (a UUIDv7) in its rollout file
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. On this machine every
 * Codex session is launched by Codex Desktop or the VSCode extension, which
 * export no session-id environment variable (measured 2026-09-01; see
 * `docs/superpowers/specs/2026-09-01-codex-gemini-identity-measurement.md`). A
 * Codex that exports `CODEX_SESSION_ID` resolves here, deterministically and with
 * no guess. Absent it, the owner-approved filesystem fallback in
 * `native-identity-disk.ts` (ADR 0028) recovers the id from the rollout tree —
 * cwd-matched and freshness-gated — and this environment path stays the preferred,
 * first-tried resolver so a future env-exporting Codex never touches disk.
 */
const resolveCodex = envSessionResolver('codex', 'CODEX_SESSION_ID');

/**
 * Gemini CLI keeps history per project (`~/.gemini/history/<project>/`, git-backed)
 * with **no per-session identity at all** — there is nothing to resolve, from the
 * environment or otherwise (measured 2026-09-01). This is a measured absence, not
 * a missing measurement. If a future Gemini exports a session id, wire it here the
 * way Codex is wired.
 */
function resolveGemini(): NativeSessionRef | undefined {
  return undefined;
}

/**
 * The per-vendor registry. `kimi` (not installed here) and `other` have no entry:
 * a kind with no resolver registers without a native block, which is the honest
 * state for an agent whose identity LUWI cannot read. To support a new agent, add
 * its `AgentKind` here with a resolver.
 */
const RESOLVERS: Partial<Record<AgentKind, NativeIdentityResolver>> = {
  'claude-code': resolveClaudeCode,
  codex: resolveCodex,
  'gemini-cli': resolveGemini,
};

export function resolveNativeIdentity(
  kind: AgentKind,
  environment: NativeIdentityEnvironment,
): NativeSessionRef | undefined {
  return RESOLVERS[kind]?.(environment);
}
