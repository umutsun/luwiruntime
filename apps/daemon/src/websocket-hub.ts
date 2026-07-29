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
