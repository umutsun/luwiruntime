import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealtimeController, toRealtimeUrl } from './observer.js';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(name: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  emit(name: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

const wireEvent = (streamId = '1-0') =>
  JSON.stringify({
    streamId,
    event: {
      id: `event-${streamId}`,
      version: 1,
      type: 'session.heartbeat',
      occurredAt: '2026-08-05T08:00:00.000Z',
      workspaceId: 'local',
      payload: {},
    },
  });

afterEach(() => {
  vi.useRealTimers();
  FakeSocket.instances = [];
});

describe('realtime connection controller', () => {
  it('builds a same-origin WebSocket URL', () => {
    expect(toRealtimeUrl({ protocol: 'http:', host: '127.0.0.1:4782' })).toBe(
      'ws://127.0.0.1:4782/api/v1/realtime',
    );
    expect(toRealtimeUrl({ protocol: 'https:', host: 'localhost' })).toBe(
      'wss://localhost/api/v1/realtime',
    );
  });

  it('transitions connecting to live, reconnecting, and live with bounded delay', async () => {
    vi.useFakeTimers();
    const onState = vi.fn();
    const controller = createRealtimeController({
      url: 'ws://127.0.0.1:4782/api/v1/realtime',
      Socket: FakeSocket as unknown as typeof WebSocket,
      onState,
      onEvent: vi.fn(),
      onInvalid: vi.fn(),
      reconnectDelaysMs: [1000, 2000, 5000, 10_000],
    });

    controller.start();
    expect(onState).toHaveBeenLastCalledWith('connecting');
    FakeSocket.instances[0]?.emit('open');
    expect(onState).toHaveBeenLastCalledWith('live');
    FakeSocket.instances[0]?.emit('close');
    expect(onState).toHaveBeenLastCalledWith('reconnecting');

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1]?.emit('open');
    expect(onState).toHaveBeenLastCalledWith('live');
  });

  it('validates messages, reports bounded diagnostics, and emits future event types', () => {
    const onEvent = vi.fn();
    const onInvalid = vi.fn();
    const controller = createRealtimeController({
      url: 'ws://127.0.0.1:4782/api/v1/realtime',
      Socket: FakeSocket as unknown as typeof WebSocket,
      onState: vi.fn(),
      onEvent,
      onInvalid,
    });
    controller.start();
    FakeSocket.instances[0]?.emit('message', { data: wireEvent() });
    FakeSocket.instances[0]?.emit('message', { data: '{broken' });
    FakeSocket.instances[0]?.emit('message', { data: new Uint8Array([1, 2]) });

    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ streamId: '1-0' }));
    expect(onInvalid).toHaveBeenCalledTimes(2);
    expect(onInvalid).toHaveBeenLastCalledWith('unsupported-message-data');
  });

  it('cancels reconnect when stopped', async () => {
    vi.useFakeTimers();
    const onState = vi.fn();
    const controller = createRealtimeController({
      url: 'ws://127.0.0.1:4782/api/v1/realtime',
      Socket: FakeSocket as unknown as typeof WebSocket,
      onState,
      onEvent: vi.fn(),
      onInvalid: vi.fn(),
    });
    controller.start();
    FakeSocket.instances[0]?.emit('close');
    controller.stop();
    await vi.runAllTimersAsync();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(onState).not.toHaveBeenCalledWith('disconnected');
  });

  it('closes an active socket when stopped', () => {
    const controller = createRealtimeController({
      url: 'ws://127.0.0.1:4782/api/v1/realtime',
      Socket: FakeSocket as unknown as typeof WebSocket,
      onState: vi.fn(),
      onEvent: vi.fn(),
      onInvalid: vi.fn(),
    });
    controller.start();
    controller.stop();
    expect(FakeSocket.instances[0]?.close).toHaveBeenCalledOnce();
  });
});
