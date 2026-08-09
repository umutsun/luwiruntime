import type { ReactNode } from 'react';

import { StatusChip, type StatusTone } from './status-chip.js';

/**
 * The state of one independently loaded resource.
 *
 * `not-observed` and `unavailable` are deliberately distinct. A 404 from the
 * project Git read means no scan has been recorded, which is a complete and
 * true answer; reporting it as `unavailable` would claim a fault that does not
 * exist. Resources with no such distinction simply never produce it.
 */
export type ResourceState<T> =
  { state: 'ready'; data: T } | { state: 'not-observed' } | { state: 'unavailable' };

export const confidenceLabels = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unknown',
} as const;

export type Confidence = keyof typeof confidenceLabels;

export const confidenceTones: Record<Confidence, StatusTone> = {
  high: 'success',
  medium: 'info',
  low: 'warning',
  unknown: 'unknown',
};

/** Confidence always carries its label as text, never colour alone. */
export function ConfidenceChip({ confidence }: { confidence: Confidence }) {
  return <StatusChip tone={confidenceTones[confidence]}>{confidenceLabels[confidence]}</StatusChip>;
}

function panelId(title: string): string {
  return `panel-${title.toLowerCase().replaceAll(' ', '-')}`;
}

export function Panel({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const id = panelId(title);
  return (
    <section className="panel" aria-labelledby={id}>
      <header className="panel__header">
        <h2 id={id}>{title}</h2>
        {meta === undefined ? null : <span className="panel__meta">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

/**
 * Renders one resource with its three failure-shaped outcomes kept apart:
 * unavailable, not observed, and genuinely empty. Collapsing empty into
 * unavailable would report a fault where the answer is simply "none".
 */
export function ResourcePanel<T>({
  title,
  meta,
  resource,
  notObservedMessage,
  emptyMessage,
  loading = false,
  isEmpty,
  children,
}: {
  title: string;
  meta?: ReactNode;
  resource: ResourceState<T> | undefined;
  notObservedMessage?: string;
  emptyMessage: string;
  /**
   * A read that has not returned yet. Without this, an absent resource is
   * indistinguishable from a failed one, so every panel on a route's first
   * paint claimed a fault that had not happened.
   */
  loading?: boolean;
  isEmpty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (resource === undefined && loading) {
    return (
      <Panel title={title} {...(meta === undefined ? {} : { meta })}>
        <p className="empty-state" aria-busy="true">
          Loading
        </p>
      </Panel>
    );
  }
  const state = resource ?? { state: 'unavailable' as const };

  return (
    <Panel title={title} {...(meta === undefined ? {} : { meta })}>
      {state.state === 'not-observed' ? (
        <p className="empty-state">{notObservedMessage ?? 'Not observed'}</p>
      ) : state.state === 'unavailable' ? (
        <p className="empty-state">Unavailable</p>
      ) : isEmpty(state.data) ? (
        <p className="empty-state">{emptyMessage}</p>
      ) : (
        children(state.data)
      )}
    </Panel>
  );
}

/** A value the runtime did not observe. Never rendered as zero or blank. */
export function Unavailable({ label = 'Unavailable' }: { label?: string }) {
  return <span className="unavailable">{label}</span>;
}

export function TableWrap({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        {caption === undefined ? null : <caption className="visually-hidden">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
