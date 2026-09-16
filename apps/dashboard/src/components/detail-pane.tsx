import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A detail card stacked inline under the list that opened it.
 *
 * The routes' inner details — a message, a package, a plan — used to open a
 * second `DetailDrawer`. Once the routes themselves became drawers over the
 * overview that nested two modal surfaces, two focus traps and two scroll-lock
 * owners. This keeps the drawer header's anatomy and drops the modal: a
 * labelled region in the flow, no portal, no trap, no lock. Nothing about the
 * evidence changes; only where it sits.
 *
 * It scrolls itself into view on mount because a drawer caps its tables in
 * height, so the card lands below the fold of the list that opened it.
 */
export function DetailPane({
  eyebrow,
  title,
  meta,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    // jsdom implements no scrollIntoView; the guard keeps the tests honest
    // about that rather than stubbing it.
    if (typeof surface.current?.scrollIntoView === 'function') {
      surface.current.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  return (
    <section ref={surface} className="detail-pane" aria-labelledby={titleId}>
      <header className="detail-pane__header">
        <div className="detail-drawer__heading">
          <p className="eyebrow">{eyebrow}</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="detail-drawer__tools">
          {meta === undefined ? null : <span className="detail-drawer__meta">{meta}</span>}
          <button
            className="detail-drawer__close"
            type="button"
            onClick={onClose}
            aria-label="Close detail"
          >
            ×
          </button>
        </div>
      </header>
      <div className="detail-pane__body">{children}</div>
    </section>
  );
}
