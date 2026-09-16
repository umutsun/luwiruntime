import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function DetailDrawer({
  eyebrow,
  title,
  meta,
  wide = false,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  /** The wide variant, for a route whose tables run six to eight columns. */
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const surface = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // A child that placed focus on mount (a form's first field) keeps it.
    if (!surface.current?.contains(document.activeElement)) closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      opener.current?.focus();
    };
  }, []);

  const keepFocusInside = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = [...(surface.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (element) =>
        !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="detail-drawer-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={surface}
        className={`detail-drawer${wide ? ' detail-drawer--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={keepFocusInside}
      >
        <header className="detail-drawer__header">
          <div className="detail-drawer__heading">
            <p className="eyebrow">{eyebrow}</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          <div className="detail-drawer__tools">
            {meta === undefined ? null : <span className="detail-drawer__meta">{meta}</span>}
            <button
              ref={closeButton}
              className="detail-drawer__close"
              type="button"
              onClick={close}
              aria-label="Close drawer"
            >
              ×
            </button>
          </div>
        </header>
        <div className="detail-drawer__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
