import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A confirmation gate for an action that writes to the developer's own files.
 *
 * Built from a plain element rather than `<dialog>` because `showModal` is not
 * reliably implemented in jsdom, and a gate whose behaviour cannot be asserted
 * is not a gate. Focus is moved in on mount, trapped while open, and returned
 * to whatever opened it on unmount.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  /** The confirmed work is in flight; neither control may fire again. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  return (
    <div className="dialog-scrim">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          // Two controls, so the trap is a swap rather than a ring walk.
          event.preventDefault();
          const target = document.activeElement === cancelRef.current ? confirmRef : cancelRef;
          target.current?.focus();
        }}
      >
        <h2 id={headingId}>{title}</h2>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions">
          <button type="button" ref={cancelRef} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="dialog__confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
