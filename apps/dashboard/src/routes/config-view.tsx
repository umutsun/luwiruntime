import { useState } from 'react';

import {
  changeSummary,
  type ConfigDriftRecord,
  type ConfigPlanRecord,
  type ConfigSnapshotRecord,
  type DriftKind,
  type DriftSeverity,
} from '../api/config-scope.js';
import { IdBadge } from '../components/id-badge.js';
import { Panel, ResourcePanel, TableWrap, type ResourceState } from '../components/panel.js';
import { StatusChip, type StatusTone } from '../components/status-chip.js';

/**
 * Native configuration management, read-only.
 *
 * The three panels are one chain, in the order a reader needs them: what is
 * wrong now (drift), what was proposed and what became of it (plans), and what
 * the runtime preserved before it wrote (snapshots). Twelve `config.*` event
 * types have been reaching Activity since Phase 3 recording that these steps
 * happened; this is the first surface that says which files they touched.
 *
 * Every mutation in this domain — plan, approve, apply, rollback, drift scan,
 * reconcile — is a POST the daemon serves and none of them is reachable here.
 * AGENTS.md section 21 keeps them off read surfaces, and these are the
 * operations that write to the developer's own agent configuration files.
 */

const driftLabels: Record<DriftKind, string> = {
  edited: 'Edited',
  removed: 'Removed',
  appeared: 'Unexpected file',
  unchanged: 'Hashes match',
  unrecorded: 'No hashes recorded',
};

/**
 * Tone follows what the record means for the file, not the runtime's own
 * severity — those are two different scales and both are rendered as text.
 */
const driftTones: Record<DriftKind, StatusTone> = {
  edited: 'warning',
  removed: 'danger',
  appeared: 'info',
  unchanged: 'success',
  unrecorded: 'unknown',
};

const severityLabels: Record<DriftSeverity, string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
};

const severityTones: Record<DriftSeverity, StatusTone> = {
  info: 'info',
  warning: 'warning',
  error: 'danger',
};

const planTones: Record<ConfigPlanRecord['state'], StatusTone> = {
  prepared: 'unknown',
  approved: 'info',
  applying: 'info',
  applied: 'success',
  failed: 'danger',
  expired: 'unknown',
  superseded: 'unknown',
};

/** A path is identified by its tail; the full value stays in the title. */
function PathCell({ path }: { path: string }) {
  const tail = path.split(/[/\\]/).filter(Boolean).slice(-2).join('/');
  return <code title={path}>{tail === '' ? path : tail}</code>;
}

function summaryLine(changes: ConfigPlanRecord['changes']): string {
  const counts = changeSummary(changes);
  const parts = [
    counts.create === 0 ? undefined : `${String(counts.create)} create`,
    counts.update === 0 ? undefined : `${String(counts.update)} update`,
    counts.delete === 0 ? undefined : `${String(counts.delete)} delete`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'No changes' : parts.join(' · ');
}

function PlanDetail({ plan }: { plan: ConfigPlanRecord }) {
  return (
    <Panel title="Plan detail" meta={plan.kind}>
      <dl className="key-values">
        <div>
          <dt>Agent</dt>
          <dd>
            <code title={plan.agentId}>{plan.agentId}</code>
          </dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>
            {plan.projectId === undefined ? (
              // A global plan targets an agent's own configuration rather than
              // a project's, which is a scope and not a missing field.
              <span className="unavailable">Global scope</span>
            ) : (
              <code title={plan.projectId}>{plan.projectId}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{plan.createdAt}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{plan.expiresAt}</dd>
        </div>
        <div>
          <dt>Operation</dt>
          <dd>
            {plan.operationId === undefined ? (
              <span className="unavailable">Never applied</span>
            ) : (
              <code title={plan.operationId}>{plan.operationId}</code>
            )}
          </dd>
        </div>
      </dl>

      <p className="group-label">
        <span>Changes</span>
        <span className="group-label__count">{plan.changes.length}</span>
      </p>
      {plan.changes.map((change, index) => (
        <div key={`${change.path}-${String(index)}`} className="plan-change">
          <p className="plan-change__head">
            <PathCell path={change.path} />
            <StatusChip tone={change.operation === 'delete' ? 'danger' : 'info'}>
              {change.operation}
            </StatusChip>
            <small>{change.managementMode}</small>
          </p>
          {change.redactedDiff === '' ? (
            <p className="empty-state">No diff recorded</p>
          ) : (
            <pre className="message-body">{change.redactedDiff}</pre>
          )}
          {change.warnings.length === 0 ? null : (
            <ul className="name-list">
              {change.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <p className="bounded-note">
        The diff is the one the daemon recorded, already redacted at the source. This view neither
        redacts it a second time nor can apply it.
      </p>
    </Panel>
  );
}

function SnapshotDetail({ snapshot }: { snapshot: ConfigSnapshotRecord }) {
  return (
    <Panel title="Snapshot detail" meta={snapshot.adapterVersion}>
      <dl className="key-values">
        <div>
          <dt>Plan</dt>
          <dd>
            <code title={snapshot.planId}>{snapshot.planId}</code>
          </dd>
        </div>
        <div>
          <dt>Operation</dt>
          <dd>
            <code title={snapshot.operationId}>{snapshot.operationId}</code>
          </dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>
            <code title={snapshot.agentId}>{snapshot.agentId}</code>
          </dd>
        </div>
        <div>
          <dt>Captured</dt>
          <dd>{snapshot.createdAt}</dd>
        </div>
      </dl>

      <p className="group-label">
        <span>Preserved files</span>
        <span className="group-label__count">{snapshot.files.length}</span>
      </p>
      <TableWrap caption="Files preserved by this snapshot">
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">Before the apply</th>
            <th scope="col">Original hash</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.files.map((file) => (
            <tr key={file.targetPath}>
              <td>
                <PathCell path={file.targetPath} />
              </td>
              <td>
                {/*
                 * A file that did not exist has nothing to restore: undoing the
                 * apply would delete it. Rendering both as "preserved" would
                 * describe two opposite rollbacks with one word.
                 */}
                {file.existed ? 'Existed before' : 'Created by the apply'}
              </td>
              <td>
                {file.originalHash === null ? (
                  <span className="unavailable">No original</span>
                ) : (
                  <code title={file.originalHash}>{file.originalHash.slice(0, 12)}</code>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </Panel>
  );
}

export function ConfigView({
  drifts,
  plans,
  snapshots,
  loading = false,
}: {
  drifts: ResourceState<ConfigDriftRecord[]> | undefined;
  plans: ResourceState<ConfigPlanRecord[]> | undefined;
  snapshots: ResourceState<ConfigSnapshotRecord[]> | undefined;
  loading?: boolean;
}) {
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>();

  const allPlans = plans?.state === 'ready' ? plans.data : [];
  const allSnapshots = snapshots?.state === 'ready' ? snapshots.data : [];
  const selectedPlan = allPlans.find((plan) => plan.id === selectedPlanId);
  const selectedSnapshot = allSnapshots.find((snapshot) => snapshot.id === selectedSnapshotId);

  return (
    <div className="route-stack">
      <ResourcePanel<ConfigDriftRecord[]>
        title="Configuration drift"
        meta={drifts?.state === 'ready' ? `${String(drifts.data.length)} outstanding` : undefined}
        resource={drifts}
        loading={loading}
        emptyMessage="No drift detected against managed files"
        isEmpty={(value) => value.length === 0}
      >
        {(value) => (
          <>
            <TableWrap caption="Configuration drift">
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Finding</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Suggested</th>
                  <th scope="col">Detected</th>
                </tr>
              </thead>
              <tbody>
                {value.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <PathCell path={record.path} />
                    </td>
                    <td>
                      <code title={record.agentId}>{record.agentId}</code>
                    </td>
                    <td>
                      <StatusChip tone={driftTones[record.kind]}>
                        {driftLabels[record.kind]}
                      </StatusChip>
                    </td>
                    <td>
                      <StatusChip tone={severityTones[record.severity]}>
                        {severityLabels[record.severity]}
                      </StatusChip>
                    </td>
                    <td>{record.resolution}</td>
                    <td>{record.detectedAt}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <p className="bounded-note">
              The finding is derived from the two hashes the runtime recorded, and the suggested
              resolution is the runtime&apos;s own. Nothing here carries it out: importing,
              reapplying, and rescanning are all daemon operations.
            </p>
          </>
        )}
      </ResourcePanel>

      <ResourcePanel<ConfigPlanRecord[]>
        title="Configuration plans"
        meta={plans?.state === 'ready' ? `${String(allPlans.length)} recorded` : undefined}
        resource={plans}
        loading={loading}
        emptyMessage="No configuration plans recorded"
        isEmpty={(value) => value.length === 0}
      >
        {(value) => (
          <TableWrap caption="Configuration plans">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Agent</th>
                <th scope="col">Kind</th>
                <th scope="col">State</th>
                <th scope="col">Changes</th>
                <th scope="col">Snapshot</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {value.map((plan) => {
                const counts = changeSummary(plan.changes);
                return (
                  <tr key={plan.id} aria-selected={plan.id === selectedPlanId}>
                    <td>
                      <IdBadge id={plan.id} label="plan" />
                    </td>
                    <td>
                      <IdBadge id={plan.agentId} label="agent" />
                    </td>
                    <td>{plan.kind}</td>
                    <td>
                      <StatusChip tone={planTones[plan.state]}>{plan.state}</StatusChip>
                    </td>
                    <td>
                      <span>{summaryLine(plan.changes)}</span>
                      {counts.warned === 0 ? null : <small>{String(counts.warned)} warned</small>}
                    </td>
                    <td>
                      {plan.snapshotId === undefined ? (
                        // No snapshot means the plan never reached an apply,
                        // which is a state and not a missing identifier.
                        <span className="unavailable">Not applied</span>
                      ) : (
                        <IdBadge id={plan.snapshotId} label="snapshot" />
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        aria-label={`${plan.id === selectedPlanId ? 'Hide' : 'Open'} ${plan.id}`}
                        onClick={() =>
                          setSelectedPlanId((current) =>
                            current === plan.id ? undefined : plan.id,
                          )
                        }
                      >
                        {plan.id === selectedPlanId ? 'Hide' : 'Open'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>

      {selectedPlan === undefined ? null : <PlanDetail plan={selectedPlan} />}

      <ResourcePanel<ConfigSnapshotRecord[]>
        title="Configuration snapshots"
        meta={snapshots?.state === 'ready' ? `${String(allSnapshots.length)} retained` : undefined}
        resource={snapshots}
        loading={loading}
        emptyMessage="No configuration snapshots recorded"
        isEmpty={(value) => value.length === 0}
      >
        {(value) => (
          <TableWrap caption="Configuration snapshots">
            <thead>
              <tr>
                <th scope="col">Snapshot</th>
                <th scope="col">Plan</th>
                <th scope="col">Agent</th>
                <th scope="col">Adapter</th>
                <th scope="col">Files</th>
                <th scope="col">Captured</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {value.map((snapshot) => (
                <tr key={snapshot.id} aria-selected={snapshot.id === selectedSnapshotId}>
                  <td>
                    <IdBadge id={snapshot.id} label="snapshot" />
                  </td>
                  <td>
                    <IdBadge id={snapshot.planId} label="plan" />
                  </td>
                  <td>
                    <IdBadge id={snapshot.agentId} label="agent" />
                  </td>
                  <td>{snapshot.adapterVersion}</td>
                  <td>{snapshot.files.length}</td>
                  <td>{snapshot.createdAt}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={`${snapshot.id === selectedSnapshotId ? 'Hide' : 'Open'} ${snapshot.id}`}
                      onClick={() =>
                        setSelectedSnapshotId((current) =>
                          current === snapshot.id ? undefined : snapshot.id,
                        )
                      }
                    >
                      {snapshot.id === selectedSnapshotId ? 'Hide' : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>

      {selectedSnapshot === undefined ? null : <SnapshotDetail snapshot={selectedSnapshot} />}
    </div>
  );
}
