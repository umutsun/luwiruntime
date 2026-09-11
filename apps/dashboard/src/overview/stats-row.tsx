import type { ReactNode } from 'react';

import type { Stat } from './model.js';

/**
 * The hero numbers every view opens with.
 *
 * `fill` draws the comps' thin progress bar (Flow), `bars` their ten mini bars
 * (Radial), `plain` neither (Timeline), and `inline` is the Board's one-line
 * summary. Every variant renders the same five stats from the same model, so a
 * number cannot disagree with itself between two lenses. An unavailable read is
 * `—` with the word in the sub, never a zero.
 */
export function StatsRow({
  stats,
  variant,
  onSelect,
  trailing,
}: {
  stats: readonly Stat[];
  variant: 'fill' | 'bars' | 'plain' | 'inline';
  onSelect: () => void;
  trailing?: ReactNode;
}) {
  const max = (bars: readonly number[]) => bars.reduce((high, value) => Math.max(high, value), 0);
  return (
    <div className={`stats stats--${variant}`} role="group" aria-label="Runtime totals">
      {stats.map((stat, index) => (
        <button
          key={stat.key}
          type="button"
          className={`stat-tile${stat.unavailable ? ' stat-tile--unavailable' : ''}`}
          style={{ animationDelay: `${String(0.1 + index * 0.06)}s` }}
          onClick={onSelect}
          title={`${stat.label}: ${stat.value} — ${stat.sub}`}
        >
          {variant === 'inline' ? (
            <>
              <span className="stat-tile__value">{stat.value}</span>
              <span className="stat-tile__label">
                {stat.unavailable ? stat.sub : stat.label.toLowerCase()}
              </span>
            </>
          ) : (
            <>
              <span className="stat-tile__label">{stat.label}</span>
              <span className="stat-tile__figure">
                <span className="stat-tile__value">{stat.value}</span>
                {variant === 'plain' ? null : <span className="stat-tile__sub">{stat.sub}</span>}
              </span>
              {variant === 'plain' ? <span className="stat-tile__sub">{stat.sub}</span> : null}
              {variant === 'fill' ? (
                <span className="stat-tile__bar" aria-hidden="true">
                  <span
                    className="stat-tile__fill"
                    style={{ width: `${String(Math.round(stat.fraction * 100))}%` }}
                  />
                </span>
              ) : null}
              {variant === 'bars' && stat.bars !== undefined && stat.bars.length > 0 ? (
                <span className="stat-tile__bars" aria-hidden="true">
                  {stat.bars.slice(-10).map((value, barIndex, all) => (
                    <span
                      key={barIndex}
                      className="stat-tile__mini"
                      style={{
                        height: `${String(max(all) === 0 ? 0 : Math.max(2, Math.round((value / max(all)) * 14)))}px`,
                        opacity: barIndex === all.length - 1 ? 1 : 0.35,
                        animationDelay: `${String(0.5 + barIndex * 0.04)}s`,
                      }}
                    />
                  ))}
                </span>
              ) : null}
            </>
          )}
        </button>
      ))}
      {trailing}
    </div>
  );
}
