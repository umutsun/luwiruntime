import type { Bounded, ContextSource } from '../api/intelligence-scope.js';
import { abbreviatePath } from '../components/format.js';
import { Panel, ResourcePanel, TableWrap } from '../components/panel.js';
import type { PulseSnapshot } from '../pulse/model.js';

const counts = [
  { key: 'assigned', label: 'Assigned', hint: 'Available to the session' },
  { key: 'effective', label: 'Effective', hint: 'Eligible under current scope' },
  { key: 'loaded', label: 'Loaded', hint: 'Observed in the agent context' },
  { key: 'invoked', label: 'Invoked', hint: 'Observed being used' },
  { key: 'unknown', label: 'Unknown', hint: 'Insufficient observation' },
] as const;

/**
 * Context observation states.
 *
 * Assigned, effective, loaded, and invoked are rendered as four independent
 * counts rather than a funnel. They are not nested stages: a source can be
 * observed as loaded without ever having been observed as effective, so drawing
 * them as a pipeline would assert a relationship the runtime never measured.
 * `unknown` is its own count for the same reason, since ADR 0010 requires that
 * unknown is never treated as unused.
 */
export function ContextView({
  snapshot,
  sources,
  loading = false,
}: {
  snapshot: PulseSnapshot;
  sources: Bounded<ContextSource> | undefined;
  /** The intelligence scope has not returned yet; see `ResourcePanel`. */
  loading?: boolean;
}) {
  return (
    <div className="route-stack">
      <Panel title="Context observations">
        {snapshot.contextState === 'unavailable' ? (
          <p className="empty-state">Unavailable</p>
        ) : (
          <>
            <dl className="key-values">
              {counts.map((entry) => (
                <div key={entry.key}>
                  <dt>{entry.label}</dt>
                  <dd>
                    <strong className="metric">{snapshot.context[entry.key]}</strong>
                    <small>{entry.hint}</small>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="bounded-note">
              These are four independent observations, not stages of one pipeline. A source can be
              observed as loaded without having been observed as effective, and an unobserved value
              stays unknown rather than being counted as unused.
            </p>
          </>
        )}
      </Panel>

      <ResourcePanel<Bounded<ContextSource>>
        title="Context sources"
        resource={sources === undefined ? undefined : { state: 'ready', data: sources }}
        loading={loading}
        emptyMessage="No context sources detected"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <TableWrap caption="Detected context sources">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Type</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Loading</th>
                  <th scope="col">Lines</th>
                  <th scope="col">Estimated tokens</th>
                </tr>
              </thead>
              <tbody>
                {value.items.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <small title={source.path}>{abbreviatePath(source.path)}</small>
                    </td>
                    <td>{source.sourceType}</td>
                    <td>{source.loadingScope}</td>
                    <td>{source.loadingMode}</td>
                    <td>{source.lineCount}</td>
                    <td>{source.estimatedTokenCount}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <p className="bounded-note">
              Token figures are generic character estimates, not measured token counts. They are
              comparable to each other and must not be read as what any model actually consumed.
            </p>
            {value.truncated ? (
              <p className="bounded-note">
                Bounded list, and more context sources exist than are shown.
              </p>
            ) : null}
          </>
        )}
      </ResourcePanel>
    </div>
  );
}
