import type { ReactNode } from 'react';

export type StatusTone = 'success' | 'warning' | 'danger' | 'unknown' | 'info';

export function StatusChip({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`status-chip status-chip--${tone}`}>
      <span className="status-chip__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
