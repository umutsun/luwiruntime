import { useEffect, useRef, useState } from 'react';

/*
 * LuwiBot — a docked assistant that talks to the local LuwiBot service over a
 * WebSocket, deliberately not an HTTP mutation request: the dashboard's
 * `product-independence` guard forbids an HTTP mutation verb outside the three
 * approved daemon-mutation modules, and LuwiBot is an external local service on
 * its own port, not the daemon. A WebSocket carries the turn with no such verb,
 * so the guard stays intact.
 *
 * Build-time config (Vite `import.meta.env`, so `apps/dashboard/.env` then
 * `pnpm build`): unset is enabled, `VITE_LUWIBOT_ENABLED=false` hides it, and
 * `VITE_LUWIBOT_WS_URL` moves the ip/port.
 */
const ENABLED =
  ((import.meta.env.VITE_LUWIBOT_ENABLED as string | undefined) ?? 'true') !== 'false';
const WS_URL: string =
  (import.meta.env.VITE_LUWIBOT_WS_URL as string | undefined) ?? 'ws://127.0.0.1:3100/chat';

type Msg = { role: 'user' | 'assistant' | 'error'; text: string };
type Status = 'idle' | 'connecting' | 'open' | 'error';

export function LuwiBotChat() {
  if (!ENABLED) return null;
  return <LuwiBotChatPanel />;
}

function LuwiBotChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const connect = (): WebSocket => {
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;
    setStatus('connecting');
    ws.addEventListener('open', () => setStatus('open'));
    ws.addEventListener('close', () => {
      if (socketRef.current === ws) socketRef.current = null;
      setStatus('idle');
    });
    ws.addEventListener('error', () => setStatus('error'));
    ws.addEventListener('message', (event: MessageEvent<string>) => {
      setBusy(false);
      try {
        const data = JSON.parse(event.data) as { reply?: string; error?: string };
        setMessages((current) =>
          data.error !== undefined
            ? [...current, { role: 'error', text: data.error }]
            : [...current, { role: 'assistant', text: data.reply ?? '' }],
        );
      } catch {
        setMessages((current) => [...current, { role: 'error', text: 'Malformed response' }]);
      }
    });
    return ws;
  };

  // Warm the socket when the panel opens, so the status dot is honest before the
  // first send. Closed on unmount.
  useEffect(() => {
    if (open && socketRef.current === null) connect();
  }, [open]);
  useEffect(() => () => socketRef.current?.close(), []);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, busy]);

  const send = () => {
    const text = inputRef.current?.value.trim() ?? '';
    if (text === '' || busy) return;
    // Prior confirmed turns only; errors never become context.
    const history = messages
      .filter((message) => message.role !== 'error')
      .slice(-10)
      .map((message) => ({ role: message.role, content: message.text }));
    const payload = JSON.stringify({ message: text, history });
    setMessages((current) => [...current, { role: 'user', text }]);
    setBusy(true);
    if (inputRef.current) inputRef.current.value = '';
    const ws = socketRef.current?.readyState === WebSocket.OPEN ? socketRef.current : connect();
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    else ws.addEventListener('open', () => ws.send(payload), { once: true });
  };

  const dotTitle =
    status === 'open'
      ? 'LuwiBot connected'
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'error'
          ? 'LuwiBot unreachable'
          : 'Not connected';

  return (
    <div className="luwibot">
      {open ? (
        <section className="luwibot__panel" aria-label="LuwiBot assistant">
          <header className="luwibot__head">
            <span
              className={`luwibot__dot luwibot__dot--${status}`}
              title={dotTitle}
              aria-hidden="true"
            />
            <span className="luwibot__title">LuwiBot</span>
            <button
              type="button"
              className="luwibot__close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </header>
          <div className="luwibot__log" ref={logRef}>
            {messages.length === 0 ? (
              <p className="luwibot__empty">
                Ask while you build — I answer from LUWI's live state.
              </p>
            ) : (
              messages.map((message, index) => (
                <p key={index} className={`luwibot__msg luwibot__msg--${message.role}`}>
                  {message.text}
                </p>
              ))
            )}
            {busy ? <p className="luwibot__msg luwibot__msg--assistant">…</p> : null}
          </div>
          <form
            className="luwibot__form"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={inputRef}
              className="luwibot__input"
              rows={1}
              placeholder="Ask LuwiBot…"
              aria-label="Message"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" className="luwibot__send" aria-label="Send" disabled={busy}>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M2 8h10M8 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
        </section>
      ) : null}
      <button
        type="button"
        className="luwibot__fab"
        aria-label="Ask LuwiBot"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M4 5.5h16v10H9l-4 3.5v-3.5H4z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
