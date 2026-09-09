import {
  nativeIdentityProvenanceSchema,
  nativeSessionRefSchema,
  type AgentKind,
  type NativeIdentityProvenance,
  type NativeSessionRef,
} from '@luwi/protocol';

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
 *   resolver keyed by its `AgentKind`. A vendor with richer rules gets its own
 *   function; a vendor whose identity LUWI cannot read has no entry and registers
 *   without a native block.
 */

export type NativeIdentityEnvironment = Readonly<Record<string, string | undefined>>;

export type ResolvedNativeIdentity = {
  ref: NativeSessionRef;
  provenance: NativeIdentityProvenance;
};

type NativeIdentityResolver = (
  environment: NativeIdentityEnvironment,
) => ResolvedNativeIdentity | undefined;

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

function fromHostLauncher(
  ref: NativeSessionRef | undefined,
  launcherInstanceId: string,
): ResolvedNativeIdentity | undefined {
  if (ref === undefined) return undefined;
  const provenance = nativeIdentityProvenanceSchema.safeParse({
    source: 'host_launcher',
    launcherInstanceId,
  });
  return provenance.success ? { ref, provenance: provenance.data } : undefined;
}

/**
 * Claude Code carries its session id in the environment, byte-identical to the
 * transcript stem the ADR 0023 reader joins on, so no discovery is needed.
 *
 * A child session is a subagent of the id it carries rather than a session of
 * its own: its tokens belong to the session that spawned it, and inventing a
 * second main session would split that evidence in two.
 */
function resolveClaudeCode(
  environment: NativeIdentityEnvironment,
): ResolvedNativeIdentity | undefined {
  const nativeSessionId = usable(environment['CLAUDE_CODE_SESSION_ID']);
  if (nativeSessionId === undefined) return undefined;

  const isChild = usable(environment['CLAUDE_CODE_CHILD_SESSION']) === '1';
  const nativeSubagentId = isChild ? usable(environment['CLAUDE_PID']) : undefined;

  const withSubagent = validated('claude-code', nativeSessionId, nativeSubagentId);
  if (withSubagent !== undefined) return fromHostLauncher(withSubagent, nativeSessionId);

  // A bad subagent id must not cost the session id, which is still good evidence.
  return nativeSubagentId === undefined
    ? undefined
    : fromHostLauncher(validated('claude-code', nativeSessionId), nativeSessionId);
}

/**
 * Codex launcher evidence is not complete until its two environment ids match
 * one exact fresh rollout header. That proof needs cwd and filesystem access, so
 * it lives in `native-identity-disk.ts`; the pure environment resolver must not
 * upgrade either id on its own.
 */
function resolveCodex(): undefined {
  return undefined;
}

/**
 * Gemini CLI keeps history per project (`~/.gemini/history/<project>/`, git-backed)
 * with **no per-session identity at all** — there is nothing to resolve, from the
 * environment or otherwise (measured 2026-09-01). This is a measured absence, not
 * a missing measurement. If a future Gemini exports a session id, wire it here the
 * way Codex is wired.
 */
function resolveGemini(): undefined {
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
): ResolvedNativeIdentity | undefined {
  return RESOLVERS[kind]?.(environment);
}
