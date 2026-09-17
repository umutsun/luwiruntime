import { describe, expect, it, vi } from 'vitest';

import type { NativeAgentProcessRunner } from './agent-runner.js';
import { createNativeBrain, createWebSocketBrain, type BrainSocket } from './brain-adapter.js';

function fakeSocket() {
  const listeners = new Map<string, (event: unknown) => void>();
  const sent: string[] = [];
  const socket: BrainSocket & {
    emit: (event: string, payload?: unknown) => void;
    sent: string[];
    closed: boolean;
  } = {
    readyState: 1,
    sent,
    closed: false,
    addEventListener: (event, listener) => listeners.set(event, listener),
    send: (data) => sent.push(data),
    close: () => {
      socket.closed = true;
    },
    emit: (event, payload) => listeners.get(event)?.(payload),
  };
  return socket;
}

const timers = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
};

describe('createWebSocketBrain', () => {
  it('sends the prompt with no history and resolves with the reply', async () => {
    const socket = fakeSocket();
    const brain = createWebSocketBrain({
      url: 'ws://127.0.0.1:3100/chat',
      createSocket: () => socket,
      ...timers,
    });
    const pending = brain.judge('question', { timeoutMs: 1_000 });
    socket.emit('open');
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ message: 'question', history: [] });
    socket.emit('message', { data: JSON.stringify({ reply: '{"ok":true}' }) });
    await expect(pending).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(socket.closed).toBe(true);
  });

  it('rejects on an error frame, an empty reply, and a timeout', async () => {
    const errored = fakeSocket();
    const brain = createWebSocketBrain({ url: 'ws://x', createSocket: () => errored, ...timers });
    const failing = brain.judge('q', { timeoutMs: 1_000 });
    errored.emit('open');
    errored.emit('message', { data: JSON.stringify({ error: 'overloaded' }) });
    await expect(failing).rejects.toMatchObject({ code: 'BRAIN_UNAVAILABLE' });

    const empty = fakeSocket();
    const emptyBrain = createWebSocketBrain({
      url: 'ws://x',
      createSocket: () => empty,
      ...timers,
    });
    const emptyPending = emptyBrain.judge('q', { timeoutMs: 1_000 });
    empty.emit('open');
    empty.emit('message', { data: JSON.stringify({ reply: '   ' }) });
    await expect(emptyPending).rejects.toMatchObject({ code: 'BRAIN_EMPTY' });

    const silent = fakeSocket();
    const silentBrain = createWebSocketBrain({
      url: 'ws://x',
      createSocket: () => silent,
      ...timers,
    });
    await expect(silentBrain.judge('q', { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'BRAIN_TIMEOUT',
    });
  });
});

describe('createNativeBrain', () => {
  it('runs one headless process per judgment, strips the LUWI session from its environment, and returns the output', async () => {
    const run = vi.fn(async (input: Parameters<NativeAgentProcessRunner['run']>[0]) => {
      input.captureOutput?.('{"verdict":');
      input.captureOutput?.('"accept","confidence":0.9}');
      return { exitCode: 0 };
    });
    const brain = createNativeBrain({
      provider: 'claude',
      executable: 'claude',
      workingDirectory: '/p',
      nativeArgs: ['--allowedTools', 'Read'],
      runner: { run },
      environment: {
        LUWI_SESSION_ID: 'bound',
        LUWI_DAEMON_URL: 'http://127.0.0.1:4782',
        HOME: '/h',
      },
      ...timers,
    });
    const answer = await brain.judge('question', { timeoutMs: 1_000 });
    expect(answer.text).toBe('{"verdict":"accept","confidence":0.9}');
    const input = run.mock.calls[0]?.[0];
    expect(input?.args).toEqual(['--print', 'question', '--allowedTools', 'Read']);
    expect(input?.environment).toEqual({ HOME: '/h' });
  });

  it('reports a silent non-zero exit as unavailable and an empty run as empty', async () => {
    const failing = createNativeBrain({
      provider: 'codex',
      executable: 'codex',
      workingDirectory: '/p',
      nativeArgs: [],
      runner: { run: async () => ({ exitCode: 2 }) },
      environment: {},
      ...timers,
    });
    await expect(failing.judge('q', { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'BRAIN_UNAVAILABLE',
    });
    const quiet = createNativeBrain({
      provider: 'codex',
      executable: 'codex',
      workingDirectory: '/p',
      nativeArgs: [],
      runner: { run: async () => ({ exitCode: 0 }) },
      environment: {},
      ...timers,
    });
    await expect(quiet.judge('q', { timeoutMs: 1_000 })).rejects.toMatchObject({
      code: 'BRAIN_EMPTY',
    });
  });
});
