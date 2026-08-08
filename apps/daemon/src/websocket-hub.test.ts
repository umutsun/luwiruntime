import { EventEmitter } from 'node:events';

import { createRuntimeEvent, type RealtimeEventMessage } from '@luwi/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createWebSocketHub,
  validateLocalHttpRequest,
  validateRealtimeUpgrade,
  type WebSocketPeer,
} from './websocket-hub.js';

class FakeSocket extends EventEmitter implements WebSocketPeer {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly callbacks: Array<(error?: Error) => void> = [];
  readonly close = vi.fn();
  readonly terminate = vi.fn();

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(data);
    this.callbacks.push(callback);
  }
}

const message: RealtimeEventMessage = {
  streamId: '1-0',
  event: createRuntimeEvent(
    {
      type: 'session.registered',
      workspaceId: 'local',
      projectId: 'project-1',
      sessionId: 'session-1',
      agentId: 'codex-sim',
      payload: {},
    },
    {
      createId: () => 'event-1',
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    },
  ),
};

describe('WebSocket broadcast hub', () => {
  it('accepts immediately when there are no connected clients', () => {
    const hub = createWebSocketHub({
      maxQueueSize: 2,
      maxBufferedBytes: 1024,
      sendTimeoutMs: 1000,
    });
    expect(hub.accept(message)).toBe(true);
  });

  it('preserves per-client FIFO ordering with one send in flight', () => {
    const hub = createWebSocketHub({
      maxQueueSize: 3,
      maxBufferedBytes: 1024,
      sendTimeoutMs: 1000,
    });
    const socket = new FakeSocket();
    hub.add(socket);

    expect(hub.accept(message)).toBe(true);
    expect(hub.accept({ ...message, streamId: '2-0' })).toBe(true);
    expect(socket.sent).toHaveLength(1);
    socket.callbacks[0]?.();
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toContain('"streamId":"2-0"');
  });

  it('disconnects a slow client on queue overflow without blocking relay ACK', () => {
    const hub = createWebSocketHub({
      maxQueueSize: 1,
      maxBufferedBytes: 1024,
      sendTimeoutMs: 1000,
    });
    const socket = new FakeSocket();
    hub.add(socket);

    hub.accept(message);
    hub.accept({ ...message, streamId: '2-0' });
    expect(hub.accept({ ...message, streamId: '3-0' })).toBe(true);

    expect(socket.close).toHaveBeenCalledWith(1013, 'Realtime client is too slow');
    expect(hub.clientCount).toBe(0);
  });

  it('rejects client application frames and closes all clients during drain', () => {
    const hub = createWebSocketHub({
      maxQueueSize: 2,
      maxBufferedBytes: 1024,
      sendTimeoutMs: 1000,
    });
    const socket = new FakeSocket();
    hub.add(socket);
    socket.emit('message', Buffer.from('client-frame'));

    expect(socket.close).toHaveBeenCalledWith(1008, 'Server-to-client events only');
    hub.closeAll();
    expect(socket.close).toHaveBeenCalledWith(1001, 'LUWI Runtime is shutting down');
  });

  it('disconnects clients above bufferedAmount and ignores already disconnected peers', () => {
    const hub = createWebSocketHub({
      maxQueueSize: 2,
      maxBufferedBytes: 1024,
      sendTimeoutMs: 1000,
    });
    const buffered = new FakeSocket();
    buffered.bufferedAmount = 2048;
    hub.add(buffered);
    hub.accept(message);
    expect(buffered.close).toHaveBeenCalledWith(1013, 'Realtime client is too slow');

    const disconnected = new FakeSocket();
    disconnected.readyState = 3;
    hub.add(disconnected);
    expect(hub.accept(message)).toBe(true);
    expect(disconnected.sent).toHaveLength(0);
    expect(hub.clientCount).toBe(0);
  });

  it('terminates a client whose active send exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const hub = createWebSocketHub({
        maxQueueSize: 2,
        maxBufferedBytes: 1024,
        sendTimeoutMs: 1000,
      });
      const socket = new FakeSocket();
      hub.add(socket);
      hub.accept(message);

      await vi.advanceTimersByTimeAsync(1001);

      expect(socket.terminate).toHaveBeenCalledTimes(1);
      expect(hub.clientCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WebSocket upgrade security', () => {
  const expected = {
    expectedHosts: new Set(['127.0.0.1:4782', 'localhost:4782']),
    allowedOrigins: new Set(['http://127.0.0.1:4782', 'http://localhost:4782']),
  };

  it('accepts exact browser origins and rejects wildcard-like, null, and wrong Host values', () => {
    expect(
      validateRealtimeUpgrade({
        ...expected,
        host: '127.0.0.1:4782',
        origin: 'http://127.0.0.1:4782',
        remoteAddress: '127.0.0.1',
      }),
    ).toBe(true);
    expect(
      validateRealtimeUpgrade({
        ...expected,
        host: '127.0.0.1:4782',
        origin: 'null',
        remoteAddress: '127.0.0.1',
      }),
    ).toBe(false);
    expect(
      validateRealtimeUpgrade({
        ...expected,
        host: 'evil.test:4782',
        origin: 'http://127.0.0.1:4782',
        remoteAddress: '127.0.0.1',
      }),
    ).toBe(false);
  });

  it('allows no-Origin clients only from loopback with an exact Host', () => {
    expect(
      validateRealtimeUpgrade({
        ...expected,
        host: 'localhost:4782',
        remoteAddress: '::1',
      }),
    ).toBe(true);
    expect(
      validateRealtimeUpgrade({
        ...expected,
        host: 'localhost:4782',
        remoteAddress: '192.168.1.4',
      }),
    ).toBe(false);
  });
});

describe('HTTP loopback security', () => {
  const allowedOrigins = new Set(['http://127.0.0.1:4782', 'http://localhost:4782']);
  const expectedHosts = new Set(['127.0.0.1:4782', 'localhost:4782', '[::1]:4782']);

  it('accepts loopback CLI requests without Origin and exact browser origins', () => {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(true);
    expect(
      validateLocalHttpRequest({
        host: 'localhost:4782',
        origin: 'http://localhost:4782',
        remoteAddress: '::1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(true);
  });

  it('rejects hostile hosts, origins, null origins, and non-loopback clients', () => {
    for (const input of [
      {
        host: 'luwi.attacker.test:4782',
        origin: 'http://luwi.attacker.test:4782',
        remoteAddress: '127.0.0.1',
      },
      {
        host: '127.0.0.1:9999',
        remoteAddress: '127.0.0.1',
      },
      {
        host: '127.0.0.1:4782',
        origin: 'http://evil.test',
        remoteAddress: '127.0.0.1',
      },
      {
        host: '127.0.0.1:4782',
        origin: 'null',
        remoteAddress: '127.0.0.1',
      },
      {
        host: '127.0.0.1:4782',
        remoteAddress: '192.0.2.10',
      },
    ]) {
      expect(validateLocalHttpRequest({ ...input, expectedHosts, allowedOrigins })).toBe(false);
    }
  });
});
