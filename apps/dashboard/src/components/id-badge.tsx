import { useEffect, useRef, useState } from 'react';

import { abbreviateId } from './format.js';

const COPIED_RESET_MS = 1_500;

/**
 * An identifier cell: abbreviated for scanning, full value in the accessible
 * `title`, and a copy control so the full id never has to be selected out of a
 * truncated cell. When the clipboard is unavailable the control stays inert and
 * the title keeps carrying the full value; claiming "Copied" without evidence
 * would be a lie the rest of this dashboard is careful never to tell.
 */
function useCopied(id: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const clipboard: Pick<Clipboard, 'writeText'> | undefined = navigator.clipboard;
    if (clipboard === undefined) return;
    try {
      await clipboard.writeText(id);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return { copied, copy: () => void copy() };
}

export function IdBadge({ id, label }: { id: string; label: string }) {
  const { copied, copy } = useCopied(id);
  return (
    <span className="id-badge">
      <code title={id}>{abbreviateId(id)}</code>
      <button
        className="id-badge__copy"
        type="button"
        onClick={copy}
        aria-label={`Copy ${label} id ${id}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

/**
 * The copy control alone, as an icon, for a head that already names its
 * subject and only lacks a way to take the full id. Same clipboard rule as the
 * badge: the check mark appears only once the write succeeded.
 */
export function CopyIdButton({
  id,
  label,
  className,
}: {
  id: string;
  label: string;
  className?: string;
}) {
  const { copied, copy } = useCopied(id);
  return (
    <button
      className={className}
      type="button"
      onClick={copy}
      aria-label={`Copy ${label} id ${id}`}
      title={copied ? 'Copied' : `Copy ${label} id`}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect
            x="5.5"
            y="5.5"
            width="8"
            height="8"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      )}
    </button>
  );
}
