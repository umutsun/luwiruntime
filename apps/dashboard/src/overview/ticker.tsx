import { routeHref } from '../routing.js';
import type { TickerRow } from './model.js';

/**
 * The STREAM line under every view: the four newest retained events.
 *
 * Released (paused), it keeps the rows it had and says how many arrived —
 * the same hold the old Realtime Stream header carried, on a smaller surface.
 */
export function Ticker({
  rows,
  following,
  pendingCount,
  available,
}: {
  rows: readonly TickerRow[];
  following: boolean;
  pendingCount: number;
  available: boolean;
}) {
  return (
    <div className="ticker" role="log" aria-label="Realtime stream" aria-live="off">
      <span className="ticker__label">STREAM</span>
      {!following ? <span className="ticker__paused">PAUSED · {pendingCount} NEW</span> : null}
      <div className="ticker__rows">
        {!available ? (
          <span className="ticker__empty">activity unavailable</span>
        ) : rows.length === 0 ? (
          <span className="ticker__empty">no retained events</span>
        ) : (
          rows.map((row, index) => (
            <div key={row.key} className="ticker__row" style={{ opacity: 1 - index * 0.22 }}>
              <span className="ticker__time">{row.time}</span>
              <span className="ticker__type">{row.type}</span>
              {row.detail === '' ? null : row.correlationId === undefined ? (
                <span className="ticker__detail">{row.detail}</span>
              ) : (
                <a
                  className="ticker__detail"
                  href={routeHref({ name: 'messages', correlationId: row.correlationId })}
                  title="Open this exchange in Messages"
                >
                  {row.detail}
                </a>
              )}
              <span className="ticker__project">· {row.project}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
