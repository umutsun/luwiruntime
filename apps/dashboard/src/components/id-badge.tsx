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
export function IdBadge({ id, label }: { id: string; label: string }) {
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

  return (
    <span className="id-badge">
      <code title={id}>{abbreviateId(id)}</code>
      <button
        className="id-badge__copy"
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${label} id ${id}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
