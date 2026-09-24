import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

/**
 * Transient action feedback as a corner notification instead of inline text.
 *
 * The coordinator/autopilot switches used to drop their result into the
 * drill-down body (a `drill__empty` line), which pushed the layout around and
 * read as broken when it was just "already coordinated". Those outcomes are
 * transient, so they belong in a toast that overlays without moving anything.
 *
 * A context with a no-op default value, so a component that calls `useToast()`
 * outside a provider (an isolated unit test) simply gets a function that does
 * nothing rather than throwing.
 */
type ToastTone = 'error' | 'info';
type Toast = { id: number; message: string; tone: ToastTone };
type PushToast = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<PushToast>(() => {});

export function useToast(): PushToast {
  return useContext(ToastContext);
}

/** How long a toast stays before it dismisses itself. */
const TOAST_TTL_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const push = useCallback<PushToast>(
    (message, tone = 'error') => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current, { id, message, tone }]);
      setTimeout(() => dismiss(id), TOAST_TTL_MS);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">
            <span className="toast__message">{toast.message}</span>
            <button
              type="button"
              className="toast__dismiss"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
