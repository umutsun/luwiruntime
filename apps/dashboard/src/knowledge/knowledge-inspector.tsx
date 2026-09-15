import type { KnowledgePanel } from './model.js';

/** The docked inspector: one summary panel, or one node panel once selected. */
export function KnowledgeInspector({
  panel,
  onSelectNode,
}: {
  panel: KnowledgePanel;
  onSelectNode: (id: string) => void;
}) {
  return (
    <aside className="knowledge__inspector" aria-label="Node inspector">
      <div className="knowledge__inspector-head">
        {panel.kind === 'node' ? (
          <p className="knowledge__inspector-eyebrow">{panel.eyebrow}</p>
        ) : null}
        <div className="knowledge__inspector-title-row">
          <h2 className="knowledge__inspector-title">{panel.title}</h2>
          <span className="knowledge__badge">{panel.badge}</span>
        </div>
        <p className="knowledge__inspector-sub">{panel.sub}</p>
      </div>

      <div className="knowledge__facts">
        {panel.facts.map((fact) => (
          <div key={fact.k} className="knowledge__fact">
            <span className="knowledge__fact-k">{fact.k}</span>
            <span className="knowledge__fact-v">{fact.v}</span>
          </div>
        ))}
      </div>

      {panel.kind === 'summary' && panel.communities.length > 0 ? (
        <div className="knowledge__communities">
          <p className="knowledge__section-label">Communities</p>
          {panel.communities.map((community) => (
            <div key={community.label} className="knowledge__community-row">
              <span className="knowledge__community-label">{community.label}</span>
              <span className="knowledge__community-track">
                <span className="knowledge__community-fill" style={{ width: community.pct }} />
              </span>
              <span className="knowledge__community-n">{community.n}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="knowledge__list">
        <p className="knowledge__section-label">
          {panel.kind === 'summary'
            ? 'God & hub nodes'
            : `Edges · ${String(panel.rows.length)} connected`}
        </p>
        {panel.rows.length === 0 ? (
          <p className="knowledge__empty-inline">No connections observed</p>
        ) : (
          panel.rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className="knowledge__row"
              onClick={() => onSelectNode(row.id)}
            >
              <span className="knowledge__row-glyph" aria-hidden="true">
                {row.rel}
              </span>
              <span className="knowledge__row-text">
                <span className="knowledge__row-title">{row.title}</span>
                <span className="knowledge__row-sub">{row.sub}</span>
              </span>
              <span className="knowledge__row-meta">{row.meta}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
