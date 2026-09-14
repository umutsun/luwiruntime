import type { AgentMessage, InboxClaimResponse } from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BridgeDaemonClient } from './bridge-daemon.js';
import {
  codexMcpBindingArgs,
  createNativeBridge,
  framePrompt,
  nativeHeadlessArguments,
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
    expect(nativeHeadlessArguments('codex', 'P', ['-c', 'k=v'], 'sess-1')).toEqual([
      'exec',
      'resume',
      '-c',
      'k=v',
      'sess-1',
      'P',
    ]);
    // The resume id is codex-only; other providers ignore it.
    expect(nativeHeadlessArguments('claude', 'P', [], 'sess-1')).toEqual(['--print', 'P']);
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
