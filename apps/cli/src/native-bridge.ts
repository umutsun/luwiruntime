import type { AgentMessageResponse, EvidenceType, MessageKind, WorkLease } from '@luwi/protocol';

import { boundedAnswer, isTerminalMessageState, type BridgeDaemonClient } from './bridge-daemon.js';
import type { NativeAgentName } from './agent-runner.js';

/**
 * ADR 0031: serve one LUWI session's durable inbox unattended by running the
 * native CLI headless once per message. The child is expected to complete the
 * message through the bound `luwi-runtime` MCP server; the bridge completes only
 * what the child left unfinished, and never writes `answered`.
 */

/** The Windows command line caps at 32 767 characters; stay clear of it. */
const MAX_PROMPT_BYTES = 30_000;

export type NativeBridgeRunResult = {
  /** `completed` = the child exited on its own; `deadline` = the deadline timer stopped it. */
  result: 'completed' | 'deadline';
  exitCode: number;
  outputTail: string;
};

export interface NativeBridgeExecutor {
  run(input: { prompt: string; deadlineAt: string }): Promise<NativeBridgeRunResult>;
}

export type NativeBridgeOptions = {
  daemon: BridgeDaemonClient;
  executor: NativeBridgeExecutor;
  /** The session the bootstrap currently owns; re-read every poll so a rotation is picked up. */
  currentSessionId: () => string | undefined;
  agentId: string;
  /** The bridge's project; used to fetch advisory leases held by other agents for prompt context. */
  projectId: string;
  bridgeInstanceId: string;
  claimLimit: number;
  claimBlockMs: number;
  claimMinIdleMs: number;
  now?: () => string;
  report?: (line: object) => void;
};

export interface NativeBridge {
  pollOnce(): Promise<number>;
  stop(): Promise<void>;
}

export function nativeHeadlessArguments(
  provider: NativeAgentName,
  prompt: string,
  nativeArgs: readonly string[],
  /**
   * The native session this run should bind to, so every message a worker serves
   * shares one persistent native session. That single session is what LUWI binds
   * its native reference to, which is what lets the transcript/rollout reader
   * attribute the worker's token usage.
   *
   * `resume` picks the CLI's continue form over its create form:
   *  - codex only ever resumes (`exec resume <id>`), and the bridge learns the id
   *    only after the first run (from the rollout), so this is passed with
   *    `resume: true` from the second run on and `undefined` before.
   *  - claude gets a caller-chosen id up front: the bridge forces it with
   *    `--session-id` on the first run (`resume: false`) and `--resume` after
   *    (`resume: true`), so a claude worker also lands in one attributable session.
   *
   * gemini and antigravity pass nothing here — neither exposes a per-process
   * session id the bridge can force or recover without guessing.
   */
  session?: { id: string; resume: boolean },
): string[] {
  switch (provider) {
    case 'claude':
      // `--allowedTools` is variadic and would swallow a trailing prompt, so the
      // prompt stays immediately after `--print`; the session flag leads.
      if (session === undefined) return ['--print', prompt, ...nativeArgs];
      return [
        session.resume ? '--resume' : '--session-id',
        session.id,
        '--print',
        prompt,
        ...nativeArgs,
      ];
    case 'codex':
      // `codex exec [OPTIONS] [PROMPT]`; `codex exec resume [OPTIONS] [SESSION_ID]
      // [PROMPT]` when resuming. The prompt is the final positional either way.
      if (session === undefined) return ['exec', ...nativeArgs, prompt];
      // `--approve-for-me` is accepted by `codex exec` but NOT by `codex exec resume`
      // (codex 0.154 dropped it from the resume subcommand — resume inherits the session's
      // approval policy set on the initial `exec`). Passing it on resume makes codex exit 2
      // with "unexpected argument '--approve-for-me'", killing every task after the first.
      // Strip it here; the `-c` MCP bindings and `--skip-git-repo-check` stay valid on resume.
      return [
        'exec',
        'resume',
        ...nativeArgs.filter((arg) => arg !== '--approve-for-me'),
        session.id,
        prompt,
      ];
    case 'gemini':
      return ['--prompt', prompt, ...nativeArgs];
    case 'antigravity':
      // agy is Claude-Code-flavoured: `--print <prompt>`, and its only headless
      // auto-approve is `--dangerously-skip-permissions` (no --allowed-tools), which
      // the operator passes after `--`. No session binding: a headless agy process
      // has no conversation id to force or resume, and guessing one from disk would
      // steal the GUI IDE's conversation (it shares the working directory).
      return ['--print', prompt, ...nativeArgs];
  }
}

/**
 * codex exec needs two things claude does not (both measured 2026-09-08): it does not
 * forward the bridge's `LUWI_SESSION_ID` to an MCP server subprocess, and its default
 * `approval: never` policy denies MCP tool calls outright. So the session binding is
 * injected straight into the `luwi-runtime` MCP server's own env with `-c`, and
 * `--approve-for-me` auto-approves the tool call through codex's automatic review.
 * Requires a `[mcp_servers.luwi-runtime]` entry in the user's codex config.
 */
export function codexMcpBindingArgs(sessionId: string, daemonUrl: string): string[] {
  return [
    '--approve-for-me',
    '--skip-git-repo-check',
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_SESSION_ID="${sessionId}"`,
    '-c',
    `mcp_servers.luwi-runtime.env.LUWI_DAEMON_URL="${daemonUrl}"`,
  ];
}

/** The safe git subcommands a worker may run — never `push` or `merge`. */
const CLAUDE_SAFE_GIT = [
  'status',
  'diff',
  'add',
  'commit',
  'log',
  'show',
  'rev-parse',
  'branch',
  'check-ignore',
  'worktree',
];

/**
 * The claude worker's launch profile, GENERATED rather than hand-written per
 * project (the mirror of {@link codexMcpBindingArgs}). Two things are made
 * dynamic so the fleet config carries no project-specific `nativeArgs`:
 *
 *  - The LUWI MCP server is wired inline (`--mcp-config <json>`, which Claude
 *    Code accepts as a JSON string), pointing at LUWI's own bound-session
 *    launcher. That launcher recovers `LUWI_SESSION_ID` from the attach hook, so
 *    the config needs neither a per-project file nor the session id.
 *  - Permissions are `dontAsk` over a FIXED, project-independent allowlist:
 *    read/edit anywhere, the safe git subcommands in both the plain and
 *    `-C <worktree>` forms (never push or merge), the package manager and tests,
 *    and the coordination MCP tools. No path is baked in — the worker's working
 *    directory, passed to the process separately, is what scopes execution.
 *
 * `--strict-mcp-config` keeps the user's own `~/.claude.json` servers out, so a
 * worker sees only LUWI's tools.
 */
export function claudeMcpBindingArgs(
  nodeExecutable: string,
  mcpLaunchScriptPath: string,
): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: { 'luwi-runtime': { command: nodeExecutable, args: [mcpLaunchScriptPath] } },
  });
  const gitTools = CLAUDE_SAFE_GIT.flatMap((sub) => [
    `Bash(git ${sub} *)`,
    `Bash(git -C * ${sub} *)`,
  ]);
  return [
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--permission-mode',
    'dontAsk',
    '--tools',
    'Read,Glob,Grep,Write,Edit,Bash',
    '--allowedTools',
    'Read(/**)',
    'Edit(/**)',
    ...gitTools,
    'Bash(pnpm *)',
    'Bash(pnpm.cmd *)',
    'Bash(npm *)',
    'Bash(node --test *)',
    'mcp__luwi-runtime__luwi_get_message',
    'mcp__luwi-runtime__luwi_list_leases',
    'mcp__luwi-runtime__luwi_acquire_lease',
    'mcp__luwi-runtime__luwi_renew_lease',
    'mcp__luwi-runtime__luwi_release_lease',
    'mcp__luwi-runtime__luwi_respond_to_message',
  ];
}

/** How many leased paths to name before collapsing the rest into a count; keeps the prompt bounded. */
const MAX_COORDINATION_LEASES = 15;

/**
 * Advisory coordination context a headless worker cannot see from its working directory: the
 * project paths OTHER sessions currently hold a work lease on (ADR 0020). Grounding the worker in
 * these avoids a blind edit to a file another agent is mid-change on. Returns undefined when nothing
 * is held by anyone else, so `framePrompt` adds no empty section.
 */
export function renderLeaseCoordination(
  leases: readonly WorkLease[],
  currentSessionId: string,
): string | undefined {
  const held = leases
    .filter((lease) => lease.state === 'held' && lease.sessionId !== currentSessionId)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (held.length === 0) return undefined;
  const shown = held.slice(0, MAX_COORDINATION_LEASES);
  const lines = shown.map(
    (lease) =>
      `- ${lease.path} — held by agent ${lease.agentId} until ${lease.expiresAt}: ${lease.reason}`,
  );
  if (held.length > shown.length) lines.push(`- …and ${held.length - shown.length} more`);
  return [
    'Fleet coordination (LUWI, advisory): other agents currently hold work leases on these project',
    'paths. Avoid editing them, or acquire your own lease and coordinate before you do:',
    ...lines,
  ].join('\n');
}

export function framePrompt(input: {
  correlationId: string;
  kind: MessageKind;
  sourceAgentId: string;
  subject?: string;
  sessionId: string;
  agentId: string;
  evidenceRequirements: readonly EvidenceType[];
  content: string;
  coordination?: string;
}): string {
  const evidence =
    input.evidenceRequirements.length === 0 ? 'none' : input.evidenceRequirements.join(', ');
  return [
    `LUWI message ${input.correlationId} (${input.kind}) from agent ${input.sourceAgentId}, subject: ${input.subject ?? 'none'}.`,
    `You are LUWI session ${input.sessionId} for agent ${input.agentId}. When you are done, report`,
    `through the luwi-runtime MCP tools: call luwi_respond_to_message with correlationId`,
    `"${input.correlationId}" and a status of answered, partially_answered, rejected or failed. If`,
    `those tools are unavailable, print your final answer as plain text. Evidence requested: ${evidence}.`,
    ...(input.coordination === undefined ? [] : ['', input.coordination]),
    '',
    input.content,
  ].join('\n');
}

function withTail(reason: string, tail: string): string {
  const trimmed = tail.trim();
  return trimmed === '' ? reason : `${reason}\n\n[native output tail]\n${trimmed}`;
}

export function createNativeBridge(options: NativeBridgeOptions): NativeBridge {
  const now = options.now ?? (() => new Date().toISOString());
  const seenSessions = new Set<string>();
  let stopping = false;

  const failure = (answer: string): AgentMessageResponse => ({
    status: 'failed',
    answer: boundedAnswer(answer),
    evidence: [],
    verifiedAt: now(),
  });

  const completeSafely = async (
    correlationId: string,
    response: AgentMessageResponse,
  ): Promise<void> => {
    try {
      await options.daemon.completeMessage(
        'fail',
        currentSessionOrThrow(),
        correlationId,
        response,
      );
    } catch (error) {
      const latest = await options.daemon.getMessage(correlationId);
      if (!isTerminalMessageState(latest.state)) throw error;
    }
  };

  let sessionForRequest: string | undefined;
  const currentSessionOrThrow = (): string => {
    if (sessionForRequest === undefined) throw new Error('The native bridge has no bound session.');
    return sessionForRequest;
  };

  const processRequest = async (
    session: string,
    correlationId: string,
    payloadContent: string,
  ): Promise<void> => {
    sessionForRequest = session;
    let current = await options.daemon.getMessage(correlationId);
    if (isTerminalMessageState(current.state)) return;
    const recoveredProcessing = current.state === 'processing';
    if (current.state === 'delivered') {
      current = await options.daemon.transitionMessage('acknowledge', session, correlationId);
    }
    if (current.state === 'acknowledged') {
      current = await options.daemon.transitionMessage('processing', session, correlationId);
    }
    if (current.state !== 'processing') return;

    if (recoveredProcessing) {
      await completeSafely(
        correlationId,
        failure(
          'Recovered native processing work was not replayed because its prior side effects cannot be proven idempotent.',
        ),
      );
      return;
    }

    let coordination: string | undefined;
    try {
      const { leases } = await options.daemon.listLeases(options.projectId);
      coordination = renderLeaseCoordination(leases, session);
    } catch {
      // Best-effort: lease context is a bonus for the worker, never a reason to fail the message.
    }
    const frame = (withCoordination: boolean): string =>
      framePrompt({
        correlationId,
        kind: current.kind,
        sourceAgentId: current.sourceAgentId,
        ...(current.subject === undefined ? {} : { subject: current.subject }),
        sessionId: session,
        agentId: options.agentId,
        evidenceRequirements: current.evidenceRequirements ?? [],
        content: payloadContent,
        ...(withCoordination && coordination !== undefined ? { coordination } : {}),
      });
    // The coordination block is best-effort context and must NEVER fail a message: if it is only the
    // prepended leases that push the prompt over the cap, drop the block and keep the message. Fail
    // solely when the message's own framed content exceeds the limit.
    let prompt = frame(true);
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      prompt = frame(false);
      if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
        await completeSafely(
          correlationId,
          failure(
            `The framed message prompt is too long for a headless native run (limit ${MAX_PROMPT_BYTES} bytes).`,
          ),
        );
        return;
      }
    }

    await options.daemon.setSessionStatus(session, 'tool_running');
    try {
      let run: NativeBridgeRunResult;
      try {
        run = await options.executor.run({ prompt, deadlineAt: current.deadlineAt });
      } catch (error) {
        await completeSafely(
          correlationId,
          failure('The native agent process could not start or exited abnormally.'),
        );
        throw error;
      }
      const latest = await options.daemon.getMessage(correlationId);
      if (isTerminalMessageState(latest.state)) {
        options.report?.({ correlationId, completedBy: 'native', exitCode: run.exitCode });
        return;
      }
      let reason: string;
      if (stopping) {
        reason = 'The native agent bridge stopped before the agent finished the message.';
      } else if (run.result === 'deadline') {
        reason = 'The native agent was stopped at the message deadline before completing it.';
      } else {
        reason = `The native agent exited (code ${run.exitCode}) without completing the message.`;
      }
      await completeSafely(correlationId, failure(withTail(reason, run.outputTail)));
      options.report?.({ correlationId, completedBy: 'bridge', reason, exitCode: run.exitCode });
    } finally {
      if (!stopping) await options.daemon.setSessionStatus(session, 'idle');
    }
  };

  return {
    async pollOnce() {
      const session = options.currentSessionId();
      if (session === undefined) return 0;
      if (!seenSessions.has(session)) {
        // Mark seen only AFTER the idle-set lands. A transient daemon error here
        // must be retried on the next poll, not stranded 'starting' forever.
        await options.daemon.setSessionStatus(session, 'idle');
        seenSessions.add(session);
      }
      const claimed = await options.daemon.claimInbox(session, {
        bridgeInstanceId: options.bridgeInstanceId,
        limit: options.claimLimit,
        blockMs: options.claimBlockMs,
        minIdleMs: options.claimMinIdleMs,
      });
      for (const item of claimed.items) {
        if (stopping) break;
        if (item.itemKind !== 'request') continue;
        await processRequest(session, item.correlationId, item.payload.content);
      }
      return claimed.items.length;
    },

    async stop() {
      stopping = true;
    },
  };
}
