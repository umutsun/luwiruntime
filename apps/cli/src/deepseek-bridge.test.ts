import {
  MESSAGE_MAX_RESPONSE_BYTES,
  type AgentMessage,
  type AgentMessageResponse,
  type InboxClaimResponse,
  type NativeSessionRef,
} from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  DeepSeekBridgeStartupCancelledError,
  DeepSeekBridgeStartupCleanupError,
  createDeepSeekBridge,
  type DeepSeekAcpFactory,
  type DeepSeekAcpSession,
  type DeepSeekBridgeDaemonClient,
} from './deepseek-bridge.js';

const now = '2026-08-24T00:00:00.000Z';

function message(state: AgentMessage['state']): AgentMessage {
  return {
    id: 'message-1',
    correlationId: 'correlation-1',
    projectId: 'project-1',
    sourceSessionId: 'source-1',
    sourceAgentId: 'source-agent',
    targetSessionId: 'luwi-session-1',
    targetAgentId: 'deepseek-agent',
    selectionReason: 'explicit target',
    kind: 'instruction',
    content: 'Inspect the repository and report the result.',
    evidenceRequirements: [],
    state,
    createdAt: now,
    updatedAt: now,
    deadlineAt: '2026-08-24T01:00:00.000Z',
  };
}

function requestInbox(): InboxClaimResponse {
  return {
    items: [
      {
        streamId: '1-0',
        itemKind: 'request',
        messageId: 'message-1',
        correlationId: 'correlation-1',
        sourceSessionId: 'source-1',
        targetSessionId: 'luwi-session-1',
        createdAt: now,
        payload: {
          kind: 'instruction',
          content: 'Inspect the repository and report the result.',
          evidenceRequirements: [],
          deadlineAt: '2026-08-24T01:00:00.000Z',
        },
      },
    ],
  };
}

function harness(log: string[], promptResult = { text: 'Done.', stopReason: 'end_turn' }) {
  const acp: DeepSeekAcpSession = {
    sessionId: 'deepseek-session-1',
    closed: new Promise<void>(() => undefined),
    prompt: vi.fn(async () => {
      log.push('acp:prompt');
      return promptResult;
    }),
    cancel: vi.fn(async () => {
      log.push('acp:cancel');
    }),
    close: vi.fn(async () => {
      log.push('acp:close');
    }),
  };
  const factory: DeepSeekAcpFactory = {
    start: vi.fn(async (input) => {
      log.push(`acp:start:${input.environment.LUWI_SESSION_ID}`);
      return acp;
    }),
  };
  return { acp, factory };
}

function daemon(log: string[], inbox: InboxClaimResponse = { items: [] }) {
  let current = message('delivered');
  const client: DeepSeekBridgeDaemonClient = {
    registerSession: vi.fn(async () => {
      log.push('daemon:register');
      return { id: 'luwi-session-1' };
    }),
    declareNative: vi.fn(async (_sessionId: string, native: NativeSessionRef) => {
      log.push(`daemon:native:${native.nativeSessionId}`);
    }),
    heartbeatSession: vi.fn(async () => {
      log.push('daemon:heartbeat');
    }),
    setSessionStatus: vi.fn(async (_sessionId, status) => {
      log.push(`daemon:status:${status}`);
    }),
    closeSession: vi.fn(async () => {
      log.push('daemon:close');
    }),
    claimInbox: vi.fn(async () => inbox),
    getMessage: vi.fn(async () => current),
    transitionMessage: vi.fn(async (action) => {
      current = message(action === 'acknowledge' ? 'acknowledged' : 'processing');
      log.push(`daemon:${action}`);
      return current;
    }),
    completeMessage: vi.fn(async (action, _sessionId, _correlationId, response) => {
      log.push(`daemon:${action}:${response.status}:${response.answer}`);
      current = message(
        action === 'respond' ? 'responded' : action === 'reject' ? 'rejected' : 'failed',
      );
      return current;
    }),
  };
  return client;
}

const baseOptions = {
  daemonUrl: 'http://127.0.0.1:4782',
  projectId: 'project-1',
  agentId: 'deepseek-agent',
  workingDirectory: 'C:/workspace',
  bridgeInstanceId: 'deepseek-bridge-1',
  claimLimit: 1,
  claimBlockMs: 0,
  claimMinIdleMs: 15_000,
} as const;

describe('DeepSeek Session Bridge', () => {
  it('registers LUWI before ACP and declares the returned ACP session as native identity', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log);
    const { factory } = harness(log);
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });

    await bridge.start();

    expect(log).toEqual([
      'daemon:register',
      'acp:start:luwi-session-1',
      'daemon:native:deepseek-session-1',
      'daemon:status:idle',
    ]);
    expect(factory.start).toHaveBeenCalledWith({
      workingDirectory: 'C:/workspace',
      signal: expect.any(AbortSignal),
      environment: {
        LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
        LUWI_SESSION_ID: 'luwi-session-1',
      },
    });
    expect(bridge.sessionId).toBe('luwi-session-1');
  });

  it('moves a delivered inbox request through processing and responds with ACP output', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log, requestInbox());
    const { acp, factory } = harness(log);
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    expect(await bridge.pollOnce()).toBe(1);

    expect(acp.prompt).toHaveBeenCalledWith(
      'Inspect the repository and report the result.',
      '2026-08-24T01:00:00.000Z',
    );
    expect(log.slice(4)).toEqual([
      'daemon:acknowledge',
      'daemon:processing',
      'daemon:status:thinking',
      'acp:prompt',
      'daemon:respond:answered:Done.',
      'daemon:status:idle',
    ]);
  });

  it('fails closed when ACP refuses and never reports the request as answered', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log, requestInbox());
    const { factory } = harness(log, { text: '', stopReason: 'refusal' });
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    await bridge.pollOnce();

    expect(log).toContain('daemon:reject:rejected:DeepSeek Harness refused the ACP prompt.');
    expect(log.some((entry) => entry.startsWith('daemon:respond'))).toBe(false);
  });

  it('treats a timeout racing the ACP answer as terminal instead of stopping the bridge', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log, requestInbox());
    vi.mocked(daemonClient.getMessage)
      .mockResolvedValueOnce(message('delivered'))
      .mockResolvedValueOnce(message('timed_out'));
    vi.mocked(daemonClient.completeMessage).mockRejectedValue(new Error('message became terminal'));
    const { factory } = harness(log);
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    await expect(bridge.pollOnce()).resolves.toBe(1);
    await expect(bridge.heartbeat()).resolves.toBeUndefined();

    expect(daemonClient.completeMessage).toHaveBeenCalledTimes(1);
    expect(log).toContain('daemon:heartbeat');
  });

  it('bounds committed ACP output to the LUWI response limit', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log, requestInbox());
    let completed: AgentMessageResponse | undefined;
    vi.mocked(daemonClient.completeMessage).mockImplementation(
      async (_action, _sessionId, _correlationId, response) => {
        completed = response;
        return message('responded');
      },
    );
    const { factory } = harness(log, {
      text: 'x'.repeat(MESSAGE_MAX_RESPONSE_BYTES + 1_000),
      stopReason: 'end_turn',
    });
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    await bridge.pollOnce();

    expect(Buffer.byteLength(completed?.answer ?? '', 'utf8')).toBeLessThanOrEqual(
      MESSAGE_MAX_RESPONSE_BYTES,
    );
  });

  it('fails recovered processing work without replaying ACP side effects', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log, requestInbox());
    vi.mocked(daemonClient.getMessage).mockResolvedValue(message('processing'));
    const { acp, factory } = harness(log);
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    await bridge.pollOnce();

    expect(acp.prompt).not.toHaveBeenCalled();
    expect(log).toContain(
      'daemon:fail:failed:Recovered DeepSeek processing work was not replayed because its prior side effects cannot be proven idempotent.',
    );
  });

  it('fails the current message and stops polling after an ACP prompt failure', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log, requestInbox());
    const { acp, factory } = harness(log);
    vi.mocked(acp.prompt).mockRejectedValue(new Error('ACP process unavailable'));
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    await expect(bridge.pollOnce()).rejects.toThrow('ACP process unavailable');

    expect(log).toContain('daemon:fail:failed:DeepSeek Harness ACP prompt failed.');
  });

  it('rolls back the LUWI session when ACP startup fails and preserves the failure through stop', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log);
    const factory: DeepSeekAcpFactory = {
      start: vi.fn(async () => {
        log.push('acp:start');
        throw new Error('ACP unavailable');
      }),
    };
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });

    await expect(bridge.start()).rejects.toThrow('ACP unavailable');
    await expect(bridge.stop()).rejects.toThrow('ACP unavailable');
    await expect(bridge.stop()).rejects.toThrow('ACP unavailable');

    expect(log).toEqual(['daemon:register', 'acp:start', 'daemon:close']);
  });

  it('propagates rollback failure instead of treating startup cancellation as clean', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log);
    vi.mocked(daemonClient.closeSession).mockImplementation(async () => {
      log.push('daemon:close');
      throw new Error('LUWI close could not be verified');
    });
    const factory: DeepSeekAcpFactory = {
      start: vi.fn(
        async (input) =>
          await new Promise((_resolve, reject) => {
            input.signal.addEventListener(
              'abort',
              () => reject(new DeepSeekBridgeStartupCancelledError()),
              { once: true },
            );
          }),
      ),
    };
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    const starting = bridge.start();
    await vi.waitFor(() => expect(factory.start).toHaveBeenCalledOnce());

    const stopping = bridge.stop();

    await expect(starting).rejects.toBeInstanceOf(DeepSeekBridgeStartupCleanupError);
    await expect(stopping).rejects.toBeInstanceOf(DeepSeekBridgeStartupCleanupError);
    expect(log).toEqual(['daemon:register', 'daemon:close']);
  });

  it('cancels ACP before closing the process and LUWI session', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log);
    const { factory } = harness(log);
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    await bridge.stop();
    await bridge.stop();

    expect(log.slice(-3)).toEqual(['acp:cancel', 'acp:close', 'daemon:close']);
  });

  it('still closes the LUWI session when ACP process cleanup reports a failure', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log);
    const { acp, factory } = harness(log);
    vi.mocked(acp.close).mockImplementation(async () => {
      log.push('acp:close');
      throw new Error('child did not exit');
    });
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();

    await expect(bridge.stop()).rejects.toThrow('child did not exit');

    expect(log.slice(-3)).toEqual(['acp:cancel', 'acp:close', 'daemon:close']);
  });

  it('stops claiming work when the ACP subprocess closes unexpectedly', async () => {
    const log: string[] = [];
    const daemonClient = daemon(log);
    const acp: DeepSeekAcpSession = {
      sessionId: 'deepseek-session-1',
      closed: Promise.resolve(),
      prompt: vi.fn(async () => ({ text: 'Done.', stopReason: 'end_turn' })),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const factory: DeepSeekAcpFactory = { start: vi.fn(async () => acp) };
    const bridge = createDeepSeekBridge({ daemon: daemonClient, acp: factory, ...baseOptions });
    await bridge.start();
    await Promise.resolve();

    await expect(bridge.pollOnce()).rejects.toThrow('not running');
  });
});
