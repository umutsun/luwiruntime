import type { RealtimeEventMessage } from '@luwi/protocol';

export interface WebSocketPeer {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: 'message' | 'close' | 'error', listener: (...arguments_: unknown[]) => void): unknown;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type WebSocketHubOptions = {
  maxQueueSize: number;
  maxBufferedBytes: number;
  sendTimeoutMs: number;
};

export interface WebSocketHub {
  readonly clientCount: number;
  add(socket: WebSocketPeer): void;
  accept(message: RealtimeEventMessage): boolean;
  closeAll(): void;
}

type ClientState = {
  socket: WebSocketPeer;
  queue: string[];
  sending: boolean;
  active: boolean;
};

const OPEN = 1;

class BoundedWebSocketHub implements WebSocketHub {
  readonly #options: WebSocketHubOptions;
  readonly #clients = new Set<ClientState>();

  constructor(options: WebSocketHubOptions) {
    this.#options = options;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  #remove(state: ClientState): void {
    state.active = false;
    state.queue.length = 0;
    this.#clients.delete(state);
  }

  #closeSlow(state: ClientState): void {
    state.socket.close(1013, 'Realtime client is too slow');
    this.#remove(state);
  }

  #drain(state: ClientState): void {
    if (!state.active || state.sending) {
      return;
    }
    if (state.socket.readyState !== OPEN) {
      this.#remove(state);
      return;
    }
    if (state.socket.bufferedAmount > this.#options.maxBufferedBytes) {
      this.#closeSlow(state);
      return;
    }

    const next = state.queue.shift();
    if (next === undefined) {
      return;
    }
    state.sending = true;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      state.sending = false;
      if (error !== undefined) {
        state.socket.terminate();
        this.#remove(state);
        return;
      }
      this.#drain(state);
    };
    const timeout = setTimeout(() => {
      finish(new Error('WebSocket send timed out.'));
    }, this.#options.sendTimeoutMs);
    timeout.unref?.();
    try {
      state.socket.send(next, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('WebSocket send failed.'));
    }
  }

  add(socket: WebSocketPeer): void {
    const state: ClientState = {
      socket,
      queue: [],
      sending: false,
      active: true,
    };
    this.#clients.add(state);
    socket.on('message', () => {
      socket.close(1008, 'Server-to-client events only');
    });
    socket.on('close', () => this.#remove(state));
    socket.on('error', () => {
      socket.terminate();
      this.#remove(state);
    });
  }

  accept(message: RealtimeEventMessage): boolean {
    const encoded = JSON.stringify(message);
    for (const state of [...this.#clients]) {
      if (!state.active || state.socket.readyState !== OPEN) {
        this.#remove(state);
        continue;
      }
      if (state.queue.length >= this.#options.maxQueueSize) {
        this.#closeSlow(state);
        continue;
      }
      state.queue.push(encoded);
      this.#drain(state);
    }
    return true;
  }

  closeAll(): void {
    for (const state of [...this.#clients]) {
      state.socket.close(1001, 'LUWI Runtime is shutting down');
      this.#remove(state);
    }
  }
}

export function createWebSocketHub(options: WebSocketHubOptions): WebSocketHub {
  return new BoundedWebSocketHub(options);
}

export type RealtimeUpgradeInput = {
  host: string | undefined;
  origin?: string;
  remoteAddress: string | undefined;
  expectedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
};

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export type LocalHttpRequestInput = {
  host: string | undefined;
  method: string;
  origin?: string;
  contentType?: string;
  remoteAddress: string | undefined;
  expectedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
};

/**
 * The only method a browser can send cross-site without a CORS preflight and
 * still change state.
 *
 * GET and HEAD change nothing. PUT, PATCH and DELETE are not CORS-safelisted
 * methods, so a cross-site one always preflights, and the daemon answers no
 * preflight — they cannot reach a handler from a browser at all. POST is the
 * exception: a form submission or a fetch with a safelisted content type is
 * sent for real, which is why the media type is checked for it alone.
 */
const MEDIA_TYPE_CHECKED_METHOD = 'POST';

function mediaType(value: string | undefined): string | undefined {
  return value?.split(';')[0]?.trim().toLowerCase();
}

export function validateLocalHttpRequest(input: LocalHttpRequestInput): boolean {
  const host = input.host?.trim().toLowerCase();
  if (!isLoopback(input.remoteAddress) || host === undefined || !input.expectedHosts.has(host)) {
    return false;
  }
  if (input.origin === 'null') {
    return false;
  }
  if (input.origin !== undefined) {
    return input.allowedOrigins.has(input.origin);
  }
  if (input.method.toUpperCase() !== MEDIA_TYPE_CHECKED_METHOD) {
    return true;
  }
  /**
   * A POST that carries no Origin at all.
   *
   * A browser attaches Origin to every POST, so an absent one already implies a
   * non-browser client — but that is the browser's promise rather than the
   * daemon's. Requiring a media type a browser cannot send cross-site without a
   * preflight makes it the daemon's too: no `Access-Control-*` header and no
   * `OPTIONS` handler exists here, so the preflight fails and the request never
   * leaves the browser. The CLI, the MCP server and the seed script all send
   * this header already, including on the operations that take an empty body.
   */
  return mediaType(input.contentType) === 'application/json';
}

export function validateRealtimeUpgrade(input: RealtimeUpgradeInput): boolean {
  if (input.host === undefined || !input.expectedHosts.has(input.host)) {
    return false;
  }
  if (input.origin === 'null') {
    return false;
  }
  if (input.origin !== undefined) {
    return input.allowedOrigins.has(input.origin);
  }
  return isLoopback(input.remoteAddress);
}
