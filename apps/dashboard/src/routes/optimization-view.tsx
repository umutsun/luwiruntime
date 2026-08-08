import type { Bounded, OptimizationProposal } from '../api/intelligence-scope.js';
import { ConfidenceChip, ResourcePanel, TableWrap, Unavailable } from '../components/panel.js';
import { StatusChip, type StatusTone } from '../components/status-chip.js';
import type { PulseFinding, PulseSnapshot } from '../pulse/model.js';

const findingStateTones: Record<PulseFinding['state'], StatusTone> = {
  open: 'warning',
  proposed: 'info',
  dismissed: 'unknown',
  resolved: 'success',
};

/**
 * Findings and proposals, read-only.
 *
 * The daemon exposes accept, reject, evaluate, and analyze endpoints. None is
 * called and no control for them is rendered: acceptance leads to a Phase 3
 * ConfigPlan apply, and AGENTS.md section 12 keeps that path off every
 * read-only surface.
 */
export function OptimizationView({
  snapshot,
  proposals,
}: {
  snapshot: PulseSnapshot;
  proposals: Bounded<OptimizationProposal> | undefined;
}) {
  const findingResource =
    snapshot.findingsState === 'ready'
      ? ({ state: 'ready', data: snapshot.findings } as const)
      : ({ state: 'unavailable' } as const);

  return (
    <div className="route-stack">
      <ResourcePanel<PulseFinding[]>
        title="Findings"
        meta={
          snapshot.findingsState === 'ready' ? `${snapshot.findings.length} bounded` : undefined
        }
        resource={findingResource}
        emptyMessage="No structural findings recorded"
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <TableWrap caption="Structural optimization findings">
            <thead>
              <tr>
                <th scope="col">Finding</th>
                <th scope="col">Kind</th>
                <th scope="col">State</th>
                <th scope="col">Confidence</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.title}
                    <small>{row.summary}</small>
                  </td>
                  <td>{row.kind}</td>
                  <td>
                    <StatusChip tone={findingStateTones[row.state]}>{row.state}</StatusChip>
                  </td>
                  <td>
                    <ConfidenceChip confidence={row.confidence} />
                  </td>
                  <td>
                    {row.sessionCount} sessions, {row.observationCount} observations
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>

      <ResourcePanel<Bounded<OptimizationProposal>>
        title="Proposals"
        resource={proposals === undefined ? undefined : { state: 'ready', data: proposals }}
        emptyMessage="No proposals recorded"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <TableWrap caption="Optimization proposals">
              <thead>
                <tr>
                  <th scope="col">Proposal</th>
                  <th scope="col">State</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Actions</th>
                  <th scope="col">Estimated saving</th>
                </tr>
              </thead>
              <tbody>
                {value.items.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>
                      {proposal.title}
                      <small>
                        {proposal.findingCount} findings, {proposal.sessionCount} sessions
                      </small>
                    </td>
                    <td>{proposal.state}</td>
                    <td>
                      <ConfidenceChip confidence={proposal.confidence} />
                    </td>
                    <td>{proposal.actionCount}</td>
                    <td>
                      {proposal.estimatedSavingTokens === undefined ? (
                        <Unavailable label="Not estimated" />
                      ) : (
                        proposal.estimatedSavingTokens
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <p className="bounded-note">
              Read-only. Accepting or rejecting a proposal leads to a configuration apply, which is
              never exposed on a read surface.
            </p>
          </>
        )}
      </ResourcePanel>
    </div>
  );
}
