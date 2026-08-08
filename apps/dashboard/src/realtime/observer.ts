import { parseDashboardEvent, type DashboardEvent } from './schema.js';

export type RealtimeConnectionState =
  'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'unavailable';

export type RealtimeInvalidReason =
  'invalid-json' | 'invalid-envelope' | 'message-too-large' | 'unsupported-message-data';

export type RealtimeControllerOptions = {
  url: string;
  Socket: typeof WebSocket;
  onState: (state: RealtimeConnectionState) => void;
  onEvent: (event: DashboardEvent) => void;
  onInvalid: (reason: RealtimeInvalidReason) => void;
  reconnectDelaysMs?: readonly number[];
  maxMessageBytes?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export type RealtimeController = {
  start(): void;
  stop(): void;
};

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000] as const;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;

export function toRealtimeUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/v1/realtime`;
}

export function createRealtimeController(options: RealtimeControllerOptions): RealtimeController {
  const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let running = false;

  const scheduleReconnect = () => {
    if (!running || reconnectTimer !== undefined) return;
    options.onState('reconnecting');
    const delay = delays[Math.min(reconnectAttempt, delays.length - 1)] ?? 10_000;
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      connect(false);
    }, delay);
  };

  const connect = (initial: boolean) => {
    if (!running) return;
    options.onState(initial ? 'connecting' : 'reconnecting');
    let nextSocket: WebSocket;
    try {
      nextSocket = new options.Socket(options.url);
    } catch {
      options.onState('unavailable');
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    nextSocket.addEventListener('open', () => {
      if (!running || socket !== nextSocket) return;
      reconnectAttempt = 0;
      options.onState('live');
    });
    nextSocket.addEventListener('message', (message) => {
      if (!running || socket !== nextSocket) return;
      if (typeof message.data !== 'string') {
        options.onInvalid('unsupported-message-data');
        return;
      }
      if (new TextEncoder().encode(message.data).byteLength > maxMessageBytes) {
        options.onInvalid('message-too-large');
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(message.data) as unknown;
      } catch {
        options.onInvalid('invalid-json');
        return;
      }
      const parsed = parseDashboardEvent(decoded);
      if (!parsed.ok) {
        options.onInvalid(parsed.reason);
        return;
      }
      options.onEvent(parsed.event);
    });
    nextSocket.addEventListener('close', () => {
      if (!running || socket !== nextSocket) return;
      socket = undefined;
      scheduleReconnect();
    });
    nextSocket.addEventListener('error', () => {
      if (!running || socket !== nextSocket) return;
      options.onState('reconnecting');
    });
  };

  return {
    start() {
      if (running) return;
      running = true;
      connect(true);
    },
    stop() {
      if (!running) return;
      running = false;
      if (reconnectTimer !== undefined) clearTimer(reconnectTimer);
      reconnectTimer = undefined;
      const activeSocket = socket;
      socket = undefined;
      activeSocket?.close();
    },
  };
}
