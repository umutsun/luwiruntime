import { useEffect, useId, useRef, useState } from 'react';

import type { MessageMutations } from '../api/message-mutations.js';
import type { PulseSnapshot } from '../pulse/model.js';

type SessionRow = PulseSnapshot['sessions'][number];

const defaultIdempotencyKey = (): string => crypto.randomUUID();

function failureMessage(result: Awaited<ReturnType<MessageMutations['ask']>>): string {
  if (result.state === 'ok') return '';
  if (result.reason === 'http' || result.reason === 'input') return result.message;
  if (result.reason === 'transport') {
    return 'The daemon could not be reached. Check runtime status and retry this draft.';
  }
  return 'The daemon returned an invalid response. The question was not confirmed.';
}

export function AskSessionDialog({
  target,
  sources,
  mutations,
  createIdempotencyKey = defaultIdempotencyKey,
  onSuccess,
  onCancel,
}: {
  target: SessionRow;
  sources: readonly SessionRow[];
  mutations: MessageMutations;
  createIdempotencyKey?: () => string;
  onSuccess: (correlationId: string) => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const busyRef = useRef(false);
  const idempotencyKey = useRef<string | undefined>(undefined);
  idempotencyKey.current ??= createIdempotencyKey();
  const [sourceSessionId, setSourceSessionId] = useState(sources[0]?.id ?? '');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(120_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const opener = document.activeElement;
    sourceRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  const changeDraft = (change: () => void) => {
    change();
    idempotencyKey.current = createIdempotencyKey();
    setError(undefined);
  };

  const submit = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    const draftIdempotencyKey = (idempotencyKey.current ??= createIdempotencyKey());
    const result = await mutations.ask({
      sourceSessionId,
      targetSessionId: target.id,
      ...(subject === '' ? {} : { subject }),
      content,
      timeoutMs,
      idempotencyKey: draftIdempotencyKey,
    });
    if (result.state === 'ok') {
      onSuccess(result.data.correlationId);
      return;
    }
    busyRef.current = false;
    setBusy(false);
    setError(failureMessage(result));
  };

  return (
    <div className="dialog-scrim">
      <div
        ref={dialogRef}
        className="dialog ask-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busyRef.current) {
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])',
          );
          if (focusable === undefined || focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <h2 id={headingId}>Ask agent</h2>
        <p className="bounded-note">
          Dispatch one durable question between two online sessions in {target.projectName}.
        </p>
        <form
          aria-label="Ask agent"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div
            className="ask-dispatch"
            aria-label={`Dispatch ${sourceSessionId} to ${target.id}`}
            aria-live="polite"
          >
            <code>{sourceSessionId}</code>
            <span aria-hidden="true">→</span>
            <code>{target.id}</code>
          </div>
          <div className="ask-form">
            <label>
              Source session
              <select
                ref={sourceRef}
                value={sourceSessionId}
                disabled={busy}
                onChange={(event) => changeDraft(() => setSourceSessionId(event.target.value))}
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.id} · {source.agentId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Subject (optional)
              <input
                value={subject}
                disabled={busy}
                onChange={(event) => changeDraft(() => setSubject(event.target.value))}
              />
            </label>
            <label>
              Question
              <textarea
                required
                rows={6}
                value={content}
                disabled={busy}
                onChange={(event) => changeDraft(() => setContent(event.target.value))}
              />
            </label>
            <label>
              Deadline
              <select
                value={timeoutMs}
                disabled={busy}
                onChange={(event) => changeDraft(() => setTimeoutMs(Number(event.target.value)))}
              >
                <option value={120_000}>2 minutes</option>
                <option value={300_000}>5 minutes</option>
                <option value={600_000}>10 minutes</option>
              </select>
            </label>
          </div>
          {error === undefined ? null : (
            <p className="outcome outcome--bad" role="alert">
              {error}
            </p>
          )}
          <div className="dialog__actions">
            <button type="button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={busy || content.trim() === ''}>
              {busy ? 'Dispatching…' : 'Dispatch question'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
