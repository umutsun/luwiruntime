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
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  readonly close = vi.fn();
  readonly terminate = vi.fn();

  send(data: string, callback: (error?: Error | null) => void): void {
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

  it('keeps a client whose send settles with null, which is how ws settles every success', () => {
    const hub = createWebSocketHub({
      maxQueueSize: 3,
      maxBufferedBytes: 1024,
      sendTimeoutMs: 1000,
    });
    const socket = new FakeSocket();
    hub.add(socket);

    expect(hub.accept(message)).toBe(true);
    expect(hub.accept({ ...message, streamId: '2-0' })).toBe(true);
    // Node's Writable calls a successful write back with `null`, and ws passes
    // that through. The live daemon terminated every dashboard right after its
    // first delivered event because this was read as a failure.
    socket.callbacks[0]?.(null);

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(2);
    expect(hub.clientCount).toBe(1);
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
        method: 'GET',
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(true);
    expect(
      validateLocalHttpRequest({
        host: 'localhost:4782',
        method: 'GET',
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
      expect(
        validateLocalHttpRequest({ ...input, method: 'GET', expectedHosts, allowedOrigins }),
      ).toBe(false);
    }
  });

  it('keeps every read rule unchanged when the method is safe', () => {
    for (const method of ['GET', 'HEAD', 'get']) {
      expect(
        validateLocalHttpRequest({
          host: '127.0.0.1:4782',
          method,
          remoteAddress: '127.0.0.1',
          expectedHosts,
          allowedOrigins,
        }),
      ).toBe(true);
    }
  });

  it('accepts a state-changing request whose Origin is allowlisted, whatever it sends', () => {
    for (const contentType of ['application/json', 'text/plain', undefined]) {
      expect(
        validateLocalHttpRequest({
          host: '127.0.0.1:4782',
          method: 'POST',
          origin: 'http://127.0.0.1:4782',
          ...(contentType === undefined ? {} : { contentType }),
          remoteAddress: '127.0.0.1',
          expectedHosts,
          allowedOrigins,
        }),
      ).toBe(true);
    }
  });

  it('rejects a state-changing request whose Origin is not allowlisted', () => {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method: 'POST',
        origin: 'http://evil.test',
        contentType: 'application/json',
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(false);
  });

  it('accepts an Origin-less state-changing request only with a JSON media type', () => {
    // The CLI, the MCP server and the seed script all send this header. A
    // browser cannot send it cross-site without a preflight the daemon never
    // answers, so an absent Origin plus JSON means a non-browser client.
    for (const contentType of [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
    ]) {
      expect(
        validateLocalHttpRequest({
          host: '127.0.0.1:4782',
          method: 'POST',
          contentType,
          remoteAddress: '127.0.0.1',
          expectedHosts,
          allowedOrigins,
        }),
      ).toBe(true);
    }

    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain; charset=utf-8',
    ]) {
      expect(
        validateLocalHttpRequest({
          host: '127.0.0.1:4782',
          method: 'POST',
          contentType,
          remoteAddress: '127.0.0.1',
          expectedHosts,
          allowedOrigins,
        }),
      ).toBe(false);
    }

    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method: 'POST',
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(false);
  });

  /**
   * Only POST is a CORS-safelisted method, so only POST can be sent cross-site
   * for real without a preflight the daemon never answers. Demanding a body's
   * media type on a bodyless DELETE would refuse a legitimate CLI call and
   * close no vector, so the check is deliberately POST-only.
   */
  it('checks the media type on POST alone, because only POST can arrive unpreflighted', () => {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method: 'POST',
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(false);

    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(
        validateLocalHttpRequest({
          host: '127.0.0.1:4782',
          method,
          remoteAddress: '127.0.0.1',
          expectedHosts,
          allowedOrigins,
        }),
      ).toBe(true);
    }

    // An unlisted Origin still loses on every one of them.
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(
        validateLocalHttpRequest({
          host: '127.0.0.1:4782',
          method,
          origin: 'http://evil.test',
          remoteAddress: '127.0.0.1',
          expectedHosts,
          allowedOrigins,
        }),
      ).toBe(false);
    }
  });

  it('still rejects a literal null Origin on a state-changing request', () => {
    expect(
      validateLocalHttpRequest({
        host: '127.0.0.1:4782',
        method: 'POST',
        origin: 'null',
        contentType: 'application/json',
        remoteAddress: '127.0.0.1',
        expectedHosts,
        allowedOrigins,
      }),
    ).toBe(false);
  });
});
