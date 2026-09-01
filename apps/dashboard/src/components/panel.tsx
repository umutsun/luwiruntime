import { useState, type ReactNode } from 'react';

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

/**
 * Attribution grades on its own scale.
 *
 * `attributionConfidenceSchema` is `exact | correlated | estimated | unknown`,
 * which is not the intelligence scale above, so the two cannot share a
 * component without one of them being mislabelled. The rule they do share is
 * the one that matters: the grade is text first, and the tone only reinforces
 * it.
 */
export const attributionConfidenceLabels = {
  exact: 'Exact',
  correlated: 'Correlated',
  estimated: 'Estimated',
  unknown: 'Unknown',
} as const;

export type AttributionConfidence = keyof typeof attributionConfidenceLabels;

export const attributionConfidenceTones: Record<AttributionConfidence, StatusTone> = {
  exact: 'success',
  correlated: 'info',
  estimated: 'warning',
  unknown: 'unknown',
};

export function AttributionConfidenceChip({ confidence }: { confidence: AttributionConfidence }) {
  return (
    <StatusChip tone={attributionConfidenceTones[confidence]}>
      {attributionConfidenceLabels[confidence]}
    </StatusChip>
  );
}

function panelId(title: string): string {
  return `panel-${title.toLowerCase().replaceAll(' ', '-')}`;
}

export function Panel({
  title,
  meta,
  collapsible = false,
  defaultCollapsed = false,
  children,
}: {
  title: string;
  meta?: ReactNode;
  /**
   * Lets the reader fold this panel away.
   *
   * Routes that stack many evidence cards become a page of full-height blocks,
   * and reaching the one you want means scrolling past the ones you do not.
   * Opt-in rather than automatic: a panel carrying one short block would only
   * gain noise from a control.
   */
  collapsible?: boolean;
  /** Starts folded, for evidence that is secondary to the panel above it. */
  defaultCollapsed?: boolean;
  children: ReactNode;
}) {
  const id = panelId(title);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const bodyId = `${id}-body`;

  if (!collapsible) {
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

  return (
    <section
      className={`panel panel--collapsible${collapsed ? ' panel--collapsed' : ''}`}
      aria-labelledby={id}
    >
      <header className="panel__header">
        {/*
         * The heading is inside the control rather than beside it, so the
         * accessible name of the button is the panel's own title and a screen
         * reader announces which card is folding.
         */}
        <button
          type="button"
          className="panel__toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => {
            setCollapsed((value) => !value);
          }}
        >
          <span className="panel__toggle-icon" aria-hidden="true" />
          <h2 id={id}>{title}</h2>
        </button>
        {meta === undefined ? null : <span className="panel__meta">{meta}</span>}
      </header>
      <div id={bodyId} hidden={collapsed}>
        {collapsed ? null : children}
      </div>
    </section>
  );
}

/** Shared inset and vertical rhythm for non-table content inside a Panel. */
export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`panel__body${className === undefined ? '' : ` ${className}`}`}>{children}</div>
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
  collapsible = false,
  defaultCollapsed = false,
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
  /** Passed through to `Panel`; see its note on why this is opt-in. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  isEmpty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  const fold = { collapsible, defaultCollapsed };
  if (resource === undefined && loading) {
    return (
      <Panel title={title} {...fold} {...(meta === undefined ? {} : { meta })}>
        <p className="empty-state" aria-busy="true">
          Loading
        </p>
      </Panel>
    );
  }
  const state = resource ?? { state: 'unavailable' as const };

  return (
    <Panel title={title} {...fold} {...(meta === undefined ? {} : { meta })}>
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

/**
 * A count that knows whether it was observed.
 *
 * The zero this avoids is the most convincing lie the dashboard can tell: it
 * looks like a measurement. Every count derived from a resource that can fail
 * goes through here.
 */
export function Count({
  value,
}: {
  value: { state: 'ready' | 'empty'; value: number } | { state: 'unavailable' };
}) {
  return value.state === 'unavailable' ? <Unavailable /> : <>{value.value}</>;
}

export function TableWrap({
  caption,
  tall = false,
  children,
}: {
  caption?: string;
  /**
   * Scrolls inside the card instead of lengthening the page.
   *
   * For a collection whose length the reader does not control — every session,
   * every node kind — a full-height table pushes the panels below it out of
   * reach. Opt-in, because a table of four rows in a scroll box is worse than
   * one that simply ends.
   */
  tall?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`table-wrap${tall ? ' table-wrap--tall' : ''}`}>
      <table>
        {caption === undefined ? null : <caption className="visually-hidden">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
