import type { AgentMessage, InboxClaimResponse, WorkLease } from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeDaemonClient } from './bridge-daemon.js';
import {
  claudeMcpBindingArgs,
  codexMcpBindingArgs,
  createNativeBridge,
  framePrompt,
  nativeHeadlessArguments,
  renderLeaseCoordination,
  type NativeBridgeExecutor,
  type NativeBridgeRunResult,
} from './native-bridge.js';

const now = '2026-09-08T00:00:00.000Z';

function message(state: AgentMessage['state'], content = 'Do the thing.'): AgentMessage {
  return {
    id: 'message-1',
    correlationId: 'correlation-1',
    projectId: 'project-1',
    sourceSessionId: 'source-1',
    sourceAgentId: 'codex',
    targetSessionId: 'session-1',
    targetAgentId: 'claude-code',
    selectionReason: 'direct target session session-1',
    kind: 'instruction',
    subject: 'ALB-1',
    content,
    evidenceRequirements: [],
    state,
    createdAt: now,
    updatedAt: now,
    deadlineAt: '2026-09-08T00:02:00.000Z',
  };
}

function requestInbox(content = 'Do the thing.'): InboxClaimResponse {
  return {
    items: [
      {
        streamId: '1-0',
        itemKind: 'request',
        messageId: 'message-1',
        correlationId: 'correlation-1',
        sourceSessionId: 'source-1',
        targetSessionId: 'session-1',
        createdAt: now,
        payload: {
          kind: 'instruction',
          subject: 'ALB-1',
          content,
          evidenceRequirements: [],
          deadlineAt: '2026-09-08T00:02:00.000Z',
        },
      },
    ],
  };
}

function lease(over: Partial<WorkLease> = {}): WorkLease {
  return {
    id: 'lease-1',
    sessionId: 'other-session',
    agentId: 'codex',
    path: 'src/a.ts',
    matchPath: 'src/a.ts',
    reason: 'editing',
    state: 'held',
    acquiredAt: now,
    expiresAt: '2026-09-08T00:05:00.000Z',
    ...over,
  };
}

function daemon(log: string[], states: AgentMessage['state'][], inbox: InboxClaimResponse) {
  let index = 0;
  let content = 'Do the thing.';
  const client: BridgeDaemonClient = {
    registerSession: vi.fn(async () => ({ id: 'session-1' })),
    heartbeatSession: vi.fn(async () => undefined),
    setSessionStatus: vi.fn(async (sessionId, status) => {
      log.push(`status:${sessionId}:${status}`);
    }),
    closeSession: vi.fn(async () => undefined),
    claimInbox: vi.fn(async () => inbox),
    getMessage: vi.fn(async () => {
      const state = states[Math.min(index, states.length - 1)] ?? 'delivered';
      index += 1;
      return message(state, content);
    }),
    listLeases: vi.fn(async () => ({ leases: [] as WorkLease[], truncated: false })),
    transitionMessage: vi.fn(async (action) => {
      log.push(`transition:${action}`);
      return message(action === 'acknowledge' ? 'acknowledged' : 'processing', content);
    }),
    completeMessage: vi.fn(async (action, _sessionId, _correlationId, response) => {
      log.push(`complete:${action}:${response.status}:${response.answer}`);
      return message('failed', content);
    }),
  };
  return {
    client,
    setContent: (value: string) => {
      content = value;
    },
  };
}

function executor(
  result: NativeBridgeRunResult,
): NativeBridgeExecutor & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(async () => result) };
}

const options = (over: Partial<Parameters<typeof createNativeBridge>[0]> = {}) => ({
  daemon: daemon([], ['delivered'], requestInbox()).client,
  executor: executor({ result: 'completed' as const, exitCode: 0, outputTail: '' }),
  currentSessionId: () => 'session-1',
  agentId: 'claude-code',
  projectId: 'project-1',
  bridgeInstanceId: 'native-bridge',
  claimLimit: 1,
  claimBlockMs: 30_000,
  claimMinIdleMs: 15_000,
  now: () => now,
  ...over,
});

describe('nativeHeadlessArguments', () => {
  it('puts the prompt where each CLI expects it', () => {
    expect(nativeHeadlessArguments('claude', 'P', ['--allowedTools', 'x'])).toEqual([
      '--print',
      'P',
      '--allowedTools',
      'x',
    ]);
    expect(nativeHeadlessArguments('codex', 'P', ['--sandbox', 'workspace-write'])).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      'P',
    ]);
    expect(nativeHeadlessArguments('gemini', 'P', [])).toEqual(['--prompt', 'P']);
    expect(nativeHeadlessArguments('antigravity', 'P', ['--dangerously-skip-permissions'])).toEqual(
      ['--print', 'P', '--dangerously-skip-permissions'],
    );
  });

  it('resumes a codex session when a session id is given', () => {
    expect(
      nativeHeadlessArguments('codex', 'P', ['-c', 'k=v'], { id: 'sess-1', resume: true }),
    ).toEqual(['exec', 'resume', '-c', 'k=v', 'sess-1', 'P']);
  });

  it('forces a claude session id with --session-id first, then --resume', () => {
    // The bridge mints the id, so a claude worker lands in one attributable session:
    // create it on the first run, resume it after, prompt kept right after --print.
    expect(
      nativeHeadlessArguments('claude', 'P', ['--allowedTools', 'x'], { id: 'c1', resume: false }),
    ).toEqual(['--session-id', 'c1', '--print', 'P', '--allowedTools', 'x']);
    expect(nativeHeadlessArguments('claude', 'P', [], { id: 'c1', resume: true })).toEqual([
      '--resume',
      'c1',
      '--print',
      'P',
    ]);
  });

  it('strips --approve-for-me when resuming codex (exec resume rejects it)', () => {
    // codex `exec` accepts --approve-for-me but `exec resume` (codex 0.154) does not, so it
    // must be dropped on resume while the -c MCP bindings and --skip-git-repo-check remain.
    expect(
      nativeHeadlessArguments(
        'codex',
        'P',
        ['--approve-for-me', '--skip-git-repo-check', '-c', 'k=v'],
        { id: 'sess-1', resume: true },
      ),
    ).toEqual(['exec', 'resume', '--skip-git-repo-check', '-c', 'k=v', 'sess-1', 'P']);
  });
});

describe('codexMcpBindingArgs', () => {
  it('injects the session into the codex MCP server env and auto-approves tool calls', () => {
    const args = codexMcpBindingArgs('sess-9', 'http://127.0.0.1:4782');
    expect(args).toContain('--approve-for-me');
    expect(args).toContain('-c');
    expect(args).toContain('mcp_servers.luwi-runtime.env.LUWI_SESSION_ID="sess-9"');
    expect(args).toContain('mcp_servers.luwi-runtime.env.LUWI_DAEMON_URL="http://127.0.0.1:4782"');
  });
});

describe('claudeMcpBindingArgs', () => {
  it('generates a project-independent claude profile: inline MCP config, dontAsk, a safe allowlist', () => {
    const args = claudeMcpBindingArgs('C:/node.exe', 'C:/luwi/scripts/claude-mcp-launch.mjs');
    // The LUWI MCP server is wired inline, pointing at LUWI's own launcher — no per-project file.
    expect(args).toContain('--strict-mcp-config');
    const config = args[args.indexOf('--mcp-config') + 1];
    expect(JSON.parse(config ?? '')).toEqual({
      mcpServers: {
        'luwi-runtime': { command: 'C:/node.exe', args: ['C:/luwi/scripts/claude-mcp-launch.mjs'] },
      },
    });
    // Non-bypass auto-approve over a fixed, generic allowlist.
    expect(args).toContain('--permission-mode');
    expect(args).toContain('dontAsk');
    expect(args).toContain('Read(/**)');
    expect(args).toContain('Edit(/**)');
    expect(args).toContain('Bash(git commit *)');
    expect(args).toContain('Bash(git -C * commit *)');
    expect(args).toContain('Bash(pnpm *)');
    expect(args).toContain('mcp__luwi-runtime__luwi_respond_to_message');
  });

  it('bakes in no project path and never allows push or merge', () => {
    const joined = claudeMcpBindingArgs('node', '/opt/luwi/scripts/claude-mcp-launch.mjs').join(
      ' ',
    );
    expect(joined).not.toMatch(/albanoosh|xampp/i);
    expect(joined).not.toMatch(/git (?:-C \S+ )?(?:push|merge)/);
  });
});

describe('framePrompt', () => {
  it('names the correlation, agents, session, reply tool, evidence and content', () => {
    const prompt = framePrompt({
      correlationId: 'correlation-1',
      kind: 'instruction',
      sourceAgentId: 'codex',
      subject: 'ALB-1',
      sessionId: 'session-1',
      agentId: 'claude-code',
      evidenceRequirements: ['file_reference'],
      content: 'Do the thing.',
    });
    expect(prompt).toContain('correlation-1');
    expect(prompt).toContain('codex');
    expect(prompt).toContain('session-1');
    expect(prompt).toContain('luwi_respond_to_message');
    expect(prompt).toContain('file_reference');
    expect(prompt).toContain('Do the thing.');
  });

  it('adds a coordination section before the content when provided, and omits it otherwise', () => {
    const base = {
      correlationId: 'c',
      kind: 'instruction' as const,
      sourceAgentId: 'codex',
      sessionId: 's',
      agentId: 'claude-code',
      evidenceRequirements: [],
      content: 'TASK-BODY',
    };
    expect(framePrompt(base)).not.toContain('Fleet coordination');
    const framed = framePrompt({ ...base, coordination: 'Fleet coordination (LUWI): x' });
    expect(framed).toContain('Fleet coordination (LUWI): x');
    expect(framed.indexOf('Fleet coordination')).toBeLessThan(framed.indexOf('TASK-BODY'));
  });
});

describe('renderLeaseCoordination', () => {
  it('lists held leases from other sessions, sorted by path, excluding own and non-held', () => {
    const out = renderLeaseCoordination(
      [
        lease({ path: 'src/b.ts', agentId: 'antigravity', sessionId: 'other-2' }),
        lease({ path: 'src/a.ts', agentId: 'codex', sessionId: 'other-1', reason: 'refactor' }),
        lease({ path: 'src/own.ts', sessionId: 'session-1' }),
        lease({ path: 'src/released.ts', sessionId: 'other-3', state: 'released' }),
      ],
      'session-1',
    );
    expect(out).toBeDefined();
    expect(out).toContain('src/a.ts — held by agent codex until');
    expect(out).toContain('src/b.ts — held by agent antigravity until');
    expect(out).not.toContain('src/own.ts');
    expect(out).not.toContain('src/released.ts');
    expect(out!.indexOf('src/a.ts')).toBeLessThan(out!.indexOf('src/b.ts'));
  });

  it('returns undefined when no other session holds a lease', () => {
    expect(renderLeaseCoordination([], 'session-1')).toBeUndefined();
    expect(
      renderLeaseCoordination([lease({ sessionId: 'session-1' })], 'session-1'),
    ).toBeUndefined();
  });

  it('caps the list and reports the remainder', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      lease({ path: `src/f${String(index).padStart(2, '0')}.ts`, sessionId: `other-${index}` }),
    );
    expect(renderLeaseCoordination(many, 'session-1')).toContain('…and 5 more');
  });
});

describe('createNativeBridge', () => {
  it('runs the child and completes nothing when the child completed the message', async () => {
    const log: string[] = [];
    const d = daemon(log, ['delivered', 'responded'], requestInbox());
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: 'done' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    const count = await bridge.pollOnce();

    expect(count).toBe(1);
    expect(exec.run).toHaveBeenCalledTimes(1);
    expect(log).toContain('transition:acknowledge');
    expect(log).toContain('transition:processing');
    expect(log).toContain('status:session-1:tool_running');
    expect(log).toContain('status:session-1:idle');
    expect(log.some((line) => line.startsWith('complete:'))).toBe(false);
  });

  it('injects held-lease coordination from other sessions into the worker prompt', async () => {
    const d = daemon([], ['delivered', 'responded'], requestInbox());
    (d.client.listLeases as ReturnType<typeof vi.fn>).mockResolvedValue({
      leases: [lease({ path: 'src/locked.ts', agentId: 'codex', sessionId: 'other-1' })],
      truncated: false,
    });
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(d.client.listLeases).toHaveBeenCalledWith('project-1');
    const { prompt } = exec.run.mock.calls[0]![0] as { prompt: string };
    expect(prompt).toContain('Fleet coordination');
    expect(prompt).toContain('src/locked.ts — held by agent codex');
  });

  it('runs the worker even when the lease fetch fails (coordination is best-effort)', async () => {
    const d = daemon([], ['delivered', 'responded'], requestInbox());
    (d.client.listLeases as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('daemon down'));
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(exec.run).toHaveBeenCalledTimes(1);
    const { prompt } = exec.run.mock.calls[0]![0] as { prompt: string };
    expect(prompt).not.toContain('Fleet coordination');
    expect(prompt).toContain('Do the thing.');
  });

  it('drops the coordination block instead of failing a message when the two together exceed the byte cap', async () => {
    // The message content alone frames under the 30KB cap; a large coordination block would tip it
    // over. Coordination is best-effort, so it must be dropped and the message must still run.
    const big = 'y'.repeat(29_000);
    const d = daemon([], ['delivered', 'responded'], requestInbox(big));
    (d.client.listLeases as ReturnType<typeof vi.fn>).mockResolvedValue({
      leases: Array.from({ length: 15 }, (_, i) =>
        lease({ path: `src/locked-${i}.ts`, sessionId: `other-${i}`, reason: 'r'.repeat(400) }),
      ),
      truncated: false,
    });
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(exec.run).toHaveBeenCalledTimes(1);
    const { prompt } = exec.run.mock.calls[0]![0] as { prompt: string };
    expect(prompt).not.toContain('Fleet coordination');
    expect(prompt).toContain(big);
  });

  it('fails a message the child left processing after a clean exit', async () => {
    const log: string[] = [];
    const d = daemon(log, ['delivered', 'processing'], requestInbox());
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: 'noise' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    const failure = log.find((line) => line.startsWith('complete:fail'));
    expect(failure).toContain('code 0');
  });

  it('reports the non-zero exit code in the failure', async () => {
    const log: string[] = [];
    const d = daemon(log, ['delivered', 'processing'], requestInbox());
    const exec = executor({ result: 'completed', exitCode: 3, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(log.find((line) => line.startsWith('complete:fail'))).toContain('code 3');
  });

  it('fails with a deadline reason when the run hit the deadline', async () => {
    const log: string[] = [];
    const d = daemon(log, ['delivered', 'processing'], requestInbox());
    const exec = executor({ result: 'deadline', exitCode: 143, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(log.find((line) => line.startsWith('complete:fail'))).toContain('deadline');
  });

  it('fails with a stopped reason when the operator stopped the bridge mid-run', async () => {
    const log: string[] = [];
    const d = daemon(log, ['delivered', 'processing'], requestInbox());
    let stopMidRun: () => Promise<void> = async () => undefined;
    const bridge = createNativeBridge(
      options({
        daemon: d.client,
        executor: {
          run: vi.fn(async () => {
            await stopMidRun();
            return { result: 'completed', exitCode: 130, outputTail: '' };
          }),
        },
      }),
    );
    stopMidRun = () => bridge.stop();

    await bridge.pollOnce();

    expect(log.find((line) => line.startsWith('complete:fail'))).toContain('stopped');
  });

  it('does not replay work recovered in the processing state', async () => {
    const log: string[] = [];
    const d = daemon(log, ['processing'], requestInbox());
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(exec.run).not.toHaveBeenCalled();
    expect(log.find((line) => line.startsWith('complete:fail'))).toContain('not replayed');
  });

  it('skips a request already terminal at claim time', async () => {
    const log: string[] = [];
    const d = daemon(log, ['responded'], requestInbox());
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(exec.run).not.toHaveBeenCalled();
    // First-seen idle is expected; nothing may transition or complete a terminal request.
    expect(log.some((line) => line.startsWith('transition:') || line.startsWith('complete:'))).toBe(
      false,
    );
  });

  it('ignores response items', async () => {
    const inbox: InboxClaimResponse = {
      items: [
        {
          streamId: '2-0',
          itemKind: 'response',
          messageId: 'message-1',
          correlationId: 'correlation-1',
          sourceSessionId: 'source-1',
          targetSessionId: 'session-1',
          createdAt: now,
          payload: { state: 'responded' },
        },
      ],
    };
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: '' });
    const bridge = createNativeBridge(
      options({ executor: exec, daemon: daemon([], ['delivered'], inbox).client }),
    );

    const count = await bridge.pollOnce();

    expect(count).toBe(1);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it('fails an over-long prompt before spawning', async () => {
    const log: string[] = [];
    const huge = 'x'.repeat(31_000);
    const d = daemon(log, ['delivered'], requestInbox(huge));
    d.setContent(huge);
    const exec = executor({ result: 'completed', exitCode: 0, outputTail: '' });
    const bridge = createNativeBridge(options({ daemon: d.client, executor: exec }));

    await bridge.pollOnce();

    expect(exec.run).not.toHaveBeenCalled();
    expect(log.find((line) => line.startsWith('complete:fail'))).toContain('too long');
  });

  it('fails then rethrows when the executor throws', async () => {
    const log: string[] = [];
    const d = daemon(log, ['delivered', 'processing'], requestInbox());
    const bridge = createNativeBridge(
      options({
        daemon: d.client,
        executor: {
          run: vi.fn(async () => {
            throw new Error('spawn failed');
          }),
        },
      }),
    );

    await expect(bridge.pollOnce()).rejects.toThrow('spawn failed');
    expect(log.find((line) => line.startsWith('complete:fail'))).toContain('could not start');
  });

  it('sets a freshly rotated session idle the first time it is seen', async () => {
    const log: string[] = [];
    let sessionId = 'session-1';
    const d = daemon(log, ['responded'], { items: [] });
    const bridge = createNativeBridge(
      options({ daemon: d.client, currentSessionId: () => sessionId }),
    );

    await bridge.pollOnce();
    sessionId = 'session-2';
    await bridge.pollOnce();

    expect(log).toContain('status:session-1:idle');
    expect(log).toContain('status:session-2:idle');
  });

  it('retries the first idle-set on the next poll when it fails transiently', async () => {
    const log: string[] = [];
    const d = daemon(log, ['responded'], { items: [] });
    let idleAttempts = 0;
    d.client.setSessionStatus = vi.fn(async (sessionId, status) => {
      if (status === 'idle') {
        idleAttempts += 1;
        if (idleAttempts === 1) throw new Error('DAEMON_UNAVAILABLE');
      }
      log.push(`status:${sessionId}:${status}`);
    });
    const bridge = createNativeBridge(options({ daemon: d.client }));

    await expect(bridge.pollOnce()).rejects.toThrow('DAEMON_UNAVAILABLE');
    // A failed idle-set must NOT mark the session seen, or it strands at 'starting'.
    await bridge.pollOnce();

    expect(idleAttempts).toBe(2);
    expect(log).toContain('status:session-1:idle');
  });

  it('sets idle only once across polls once it has succeeded', async () => {
    const log: string[] = [];
    const d = daemon(log, ['responded'], { items: [] });
    const bridge = createNativeBridge(options({ daemon: d.client }));

    await bridge.pollOnce();
    await bridge.pollOnce();

    expect(log.filter((line) => line === 'status:session-1:idle')).toHaveLength(1);
  });
});
