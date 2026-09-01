import { useState } from 'react';

import type { ConfigMutations, MutationResult } from '../api/config-mutations.js';
import {
  changeSummary,
  type ConfigAgentOption,
  type ConfigDriftRecord,
  type ConfigPlanRecord,
  type ConfigSnapshotRecord,
  type DriftKind,
  type DriftSeverity,
} from '../api/config-scope.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { DetailDrawer } from '../components/detail-drawer.js';
import { IdBadge } from '../components/id-badge.js';
import {
  Panel,
  PanelBody,
  ResourcePanel,
  TableWrap,
  type ResourceState,
} from '../components/panel.js';
import { StatusChip, type StatusTone } from '../components/status-chip.js';

/**
 * Native configuration management.
 *
 * The three panels are one chain, in the order a reader needs them: what is
 * wrong now (drift), what was proposed and what became of it (plans), and what
 * the runtime preserved before it wrote (snapshots). Twelve `config.*` event
 * types have been reaching Activity since Phase 3 recording that these steps
 * happened; this is the surface that says which files they touched.
 *
 * Plan creation, apply, rollback and rescan are reachable here as of the
 * dashboard-mutation approval recorded in AGENTS.md section 21. Apply is the
 * only one behind a confirmation, because it is the only one that writes the
 * developer's own configuration files — a plan prepares changes and writes
 * nothing until it is applied. `reconcile` remains absent.
 *
 * Every control is driven by the optional `mutations` prop. A caller that
 * passes none gets the read-only surface unchanged.
 */

/** What the surface says after a mutation returned. */
type Outcome = { tone: 'success' | 'danger'; text: string };

function outcomeOf(result: MutationResult<unknown>, success: string): Outcome {
  if (result.state === 'ok') return { tone: 'success', text: success };
  if (result.reason === 'transport') {
    return { tone: 'danger', text: 'The daemon could not be reached.' };
  }
  if (result.reason === 'invalid') {
    return { tone: 'danger', text: 'The daemon returned a response this view cannot validate.' };
  }
  // The daemon's own words. It knows why it refused and this view does not.
  return { tone: 'danger', text: result.message };
}

function OutcomeLine({ outcome }: { outcome: Outcome | undefined }) {
  if (outcome === undefined) return null;
  return (
    <p className={outcome.tone === 'success' ? 'outcome outcome--ok' : 'outcome outcome--bad'}>
      {outcome.text}
    </p>
  );
}

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

/**
 * Creating a plan touches no file of the developer's, so it needs no
 * confirmation. The gate is on apply, which is where the writing happens.
 */
function PlanForm({
  agents,
  mutations,
  onMutated,
}: {
  agents: readonly ConfigAgentOption[];
  mutations: ConfigMutations;
  onMutated: () => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [adoptUnmanaged, setAdoptUnmanaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  const run = (
    create: (input: {
      agentId: string;
      adoptUnmanaged: boolean;
    }) => Promise<MutationResult<unknown>>,
  ) => {
    setBusy(true);
    setOutcome(undefined);
    void create({ agentId, adoptUnmanaged }).then((result) => {
      setBusy(false);
      setOutcome(outcomeOf(result, 'Plan prepared. Review its changes, then apply it.'));
      if (result.state === 'ok') onMutated();
    });
  };

  return (
    <Panel title="New plan" meta="Prepares changes; writes nothing until applied">
      <PanelBody>
        <div className="plan-form">
          <label htmlFor="plan-form-agent">Agent</label>
          <select
            id="plan-form-agent"
            value={agentId}
            disabled={busy}
            onChange={(event) => setAgentId(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName}
              </option>
            ))}
          </select>

          <label htmlFor="plan-form-adopt">
            <input
              id="plan-form-adopt"
              type="checkbox"
              checked={adoptUnmanaged}
              disabled={busy}
              onChange={(event) => setAdoptUnmanaged(event.target.checked)}
            />
            Adopt files LUWI does not already manage
          </label>

          <div className="plan-form__actions">
            <button
              type="button"
              disabled={busy || agentId === ''}
              onClick={() => run(mutations.createImportPlan)}
            >
              Import plan
            </button>
            <button
              type="button"
              disabled={busy || agentId === ''}
              onClick={() => run(mutations.createRenderPlan)}
            >
              Render plan
            </button>
          </div>
        </div>
        <OutcomeLine outcome={outcome} />
        <p className="bounded-note">
          An import plan brings the agent&apos;s existing native configuration under management. A
          render plan writes what LUWI would produce. Neither touches a file until it is applied.
        </p>
      </PanelBody>
    </Panel>
  );
}

function PlanDetail({ plan }: { plan: ConfigPlanRecord }) {
  return (
    <div className="detail-content">
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
        The diff is the one the daemon recorded, already redacted at the source. This view does not
        redact it a second time.
      </p>
    </div>
  );
}

function SnapshotDetail({ snapshot }: { snapshot: ConfigSnapshotRecord }) {
  return (
    <div className="detail-content">
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
    </div>
  );
}

export function ConfigView({
  drifts,
  plans,
  snapshots,
  agents,
  mutations,
  onMutated,
  loading = false,
}: {
  drifts: ResourceState<ConfigDriftRecord[]> | undefined;
  plans: ResourceState<ConfigPlanRecord[]> | undefined;
  snapshots: ResourceState<ConfigSnapshotRecord[]> | undefined;
  agents?: ResourceState<ConfigAgentOption[]> | undefined;
  /** Absent on a read-only render, which is what every read-only test does. */
  mutations?: ConfigMutations | undefined;
  onMutated?: (() => void) | undefined;
  loading?: boolean;
}) {
  const [selection, setSelection] = useState<
    { kind: 'plan' | 'snapshot'; id: string } | undefined
  >();
  const [pendingPlan, setPendingPlan] = useState<ConfigPlanRecord>();
  const [busy, setBusy] = useState(false);
  const [planOutcome, setPlanOutcome] = useState<Outcome>();
  const [driftOutcome, setDriftOutcome] = useState<Outcome>();

  const allPlans = plans?.state === 'ready' ? plans.data : [];
  const allSnapshots = snapshots?.state === 'ready' ? snapshots.data : [];
  const selectedPlan =
    selection?.kind === 'plan' ? allPlans.find((plan) => plan.id === selection.id) : undefined;
  const selectedSnapshot =
    selection?.kind === 'snapshot'
      ? allSnapshots.find((snapshot) => snapshot.id === selection.id)
      : undefined;
  const notifyMutated = onMutated ?? (() => undefined);

  const confirmApply = () => {
    if (mutations === undefined || pendingPlan === undefined) return;
    const planId = pendingPlan.id;
    setBusy(true);
    void mutations.applyPlanWithApproval(planId).then((result) => {
      setBusy(false);
      setPendingPlan(undefined);
      setPlanOutcome(outcomeOf(result, `Plan ${planId} applied.`));
      if (result.state === 'ok') notifyMutated();
    });
  };

  return (
    <div className="route-stack">
      {mutations === undefined || agents?.state !== 'ready' || agents.data.length === 0 ? null : (
        <PlanForm agents={agents.data} mutations={mutations} onMutated={notifyMutated} />
      )}
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
              resolution is the runtime&apos;s own. Rescanning re-reads the managed files; carrying
              out a suggested resolution means preparing a plan and applying it.
            </p>
          </>
        )}
      </ResourcePanel>

      {/*
       * Outside the panel deliberately. A `ResourcePanel` renders its children
       * only for a non-empty ready resource, and a clean drift list is exactly
       * when a reader wants to rescan for new drift.
       */}
      {mutations === undefined ? null : (
        <div className="panel-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setDriftOutcome(undefined);
              void mutations.scanDrift().then((result) => {
                setBusy(false);
                setDriftOutcome(outcomeOf(result, 'Drift rescanned.'));
                if (result.state === 'ok') notifyMutated();
              });
            }}
          >
            Rescan drift
          </button>
          <OutcomeLine outcome={driftOutcome} />
        </div>
      )}

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
                {/* A column whose every cell is a dash is noise, so the
                    read-only surface does not carry one. */}
                {mutations === undefined ? null : <th scope="col">Apply</th>}
              </tr>
            </thead>
            <tbody>
              {value.map((plan) => {
                const counts = changeSummary(plan.changes);
                return (
                  <tr
                    key={plan.id}
                    aria-selected={selection?.kind === 'plan' && plan.id === selection.id}
                  >
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
                        aria-label={`${selection?.kind === 'plan' && plan.id === selection.id ? 'Hide' : 'Open'} ${plan.id}`}
                        onClick={() => {
                          setSelection((current) =>
                            current?.kind === 'plan' && current.id === plan.id
                              ? undefined
                              : { kind: 'plan', id: plan.id },
                          );
                        }}
                      >
                        {selection?.kind === 'plan' && plan.id === selection.id ? 'Hide' : 'Open'}
                      </button>
                    </td>
                    {/*
                     * Only a prepared plan is actionable. An approved one needs
                     * the token its approval returned, which this surface
                     * deliberately never held past the gesture, and the state
                     * machine mints no second one.
                     */}
                    {mutations === undefined ? null : (
                      <td>
                        {plan.state === 'prepared' ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setPendingPlan(plan)}
                          >
                            {`Apply ${plan.id}`}
                          </button>
                        ) : (
                          <span className="unavailable">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>

      <OutcomeLine outcome={planOutcome} />

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
                {mutations === undefined ? null : <th scope="col">Roll back</th>}
              </tr>
            </thead>
            <tbody>
              {value.map((snapshot) => (
                <tr
                  key={snapshot.id}
                  aria-selected={selection?.kind === 'snapshot' && snapshot.id === selection.id}
                >
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
                      aria-label={`${selection?.kind === 'snapshot' && snapshot.id === selection.id ? 'Hide' : 'Open'} ${snapshot.id}`}
                      onClick={() => {
                        setSelection((current) =>
                          current?.kind === 'snapshot' && current.id === snapshot.id
                            ? undefined
                            : { kind: 'snapshot', id: snapshot.id },
                        );
                      }}
                    >
                      {selection?.kind === 'snapshot' && snapshot.id === selection.id
                        ? 'Hide'
                        : 'Open'}
                    </button>
                  </td>
                  {mutations === undefined ? null : (
                    <td>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Roll back to ${snapshot.id}`}
                        onClick={() => {
                          setBusy(true);
                          void mutations.createRollbackPlan(snapshot.id).then((result) => {
                            setBusy(false);
                            setPlanOutcome(
                              outcomeOf(
                                result,
                                'Rollback plan prepared. Review its changes, then apply it.',
                              ),
                            );
                            if (result.state === 'ok') notifyMutated();
                          });
                        }}
                      >
                        Roll back
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>

      {selectedPlan === undefined ? null : (
        <DetailDrawer
          eyebrow="Configuration evidence"
          title="Plan detail"
          meta={selectedPlan.kind}
          onClose={() => setSelection(undefined)}
        >
          <PlanDetail plan={selectedPlan} />
        </DetailDrawer>
      )}

      {selectedSnapshot === undefined ? null : (
        <DetailDrawer
          eyebrow="Configuration evidence"
          title="Snapshot detail"
          meta={selectedSnapshot.adapterVersion}
          onClose={() => setSelection(undefined)}
        >
          <SnapshotDetail snapshot={selectedSnapshot} />
        </DetailDrawer>
      )}

      {pendingPlan === undefined ? null : (
        <ConfirmDialog
          title={`Apply ${pendingPlan.id}`}
          confirmLabel="Apply"
          busy={busy}
          onConfirm={confirmApply}
          onCancel={() => setPendingPlan(undefined)}
        >
          <p>
            This writes {pendingPlan.changes.length} file
            {pendingPlan.changes.length === 1 ? '' : 's'} belonging to{' '}
            <code>{pendingPlan.agentId}</code>. These are your own agent configuration files.
          </p>
          <ul className="name-list">
            {pendingPlan.changes.map((change, index) => (
              <li key={`${change.path}-${String(index)}`}>
                <code>{change.path}</code> — {change.operation}
                {change.warnings.length === 0
                  ? null
                  : ` (${String(change.warnings.length)} warning${
                      change.warnings.length === 1 ? '' : 's'
                    })`}
              </li>
            ))}
          </ul>
          <p className="bounded-note">
            A snapshot of what is there now is written first, so this can be rolled back.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
