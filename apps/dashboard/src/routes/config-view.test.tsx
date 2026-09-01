// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigMutations } from '../api/config-mutations.js';
import {
  driftKind,
  type ConfigAgentOption,
  type ConfigDriftRecord,
  type ConfigPlanRecord,
  type ConfigSnapshotRecord,
} from '../api/config-scope.js';
import type { ResourceState } from '../components/panel.js';
import { ConfigView } from './config-view.js';

afterEach(cleanup);

const timestamp = '2026-08-10T00:00:00.000Z';
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function drift(overrides: Partial<ConfigDriftRecord> = {}): ConfigDriftRecord {
  const base = {
    id: 'drift-1',
    agentId: 'codex-main',
    projectId: 'proj-1',
    path: 'C:/fixture/.codex/config.toml',
    expectedHash: hashA as string | null,
    observedHash: hashB as string | null,
    severity: 'warning' as const,
    resolution: 'reapply' as const,
    detectedAt: timestamp,
    ...overrides,
  };
  return { ...base, kind: overrides.kind ?? driftKind(base) };
}

type PlanOverrides = { [K in keyof ConfigPlanRecord]?: ConfigPlanRecord[K] | undefined };

/**
 * `exactOptionalPropertyTypes` is on, so an override of `undefined` cannot be
 * spread in as a present-but-undefined key. Stripping those keys is how a
 * fixture expresses "this plan never produced one".
 */
function plan(overrides: PlanOverrides = {}): ConfigPlanRecord {
  const merged: Record<string, unknown> = {
    id: 'plan-1',
    agentId: 'codex-main',
    projectId: 'proj-1',
    state: 'applied',
    kind: 'render',
    changes: [
      {
        path: 'C:/fixture/.codex/config.toml',
        operation: 'update',
        managementMode: 'managed-fragment',
        redactedDiff: '+ enabled = true',
        warnings: ['Existing fragment replaced'],
      },
    ],
    createdAt: timestamp,
    expiresAt: '2026-08-10T00:30:00.000Z',
    snapshotId: 'snapshot-1',
    operationId: 'op-1',
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged as unknown as ConfigPlanRecord;
}

function snapshot(overrides: Partial<ConfigSnapshotRecord> = {}): ConfigSnapshotRecord {
  return {
    id: 'snapshot-1',
    planId: 'plan-1',
    operationId: 'op-1',
    agentId: 'codex-main',
    projectId: 'proj-1',
    createdAt: timestamp,
    adapterVersion: 'codex-native-v1',
    files: [{ targetPath: 'C:/fixture/.codex/config.toml', existed: true, originalHash: hashA }],
    ...overrides,
  };
}

function view({
  drifts = [drift()],
  plans = [plan()],
  snapshots = [snapshot()],
}: {
  drifts?: ConfigDriftRecord[];
  plans?: ConfigPlanRecord[];
  snapshots?: ConfigSnapshotRecord[];
} = {}) {
  return (
    <ConfigView
      drifts={{ state: 'ready', data: drifts }}
      plans={{ state: 'ready', data: plans }}
      snapshots={{ state: 'ready', data: snapshots }}
    />
  );
}

describe('ConfigView', () => {
  it('names what each drift record actually says about the file', () => {
    render(
      view({
        drifts: [
          drift(),
          drift({ id: 'drift-2', path: 'C:/fixture/.codex/gone.toml', observedHash: null }),
          drift({ id: 'drift-3', path: 'C:/fixture/.codex/new.toml', expectedHash: null }),
        ],
      }),
    );

    expect(
      within(screen.getByRole('row', { name: /config\.toml/ })).getByText('Edited'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('row', { name: /gone\.toml/ })).getByText('Removed'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('row', { name: /new\.toml/ })).getByText('Unexpected file'),
    ).toBeTruthy();
  });

  it('carries the runtime severity and its suggested resolution as text', () => {
    render(view());

    const row = screen.getByRole('row', { name: /config\.toml/ });
    expect(within(row).getByText('Warning')).toBeTruthy();
    expect(within(row).getByText('reapply')).toBeTruthy();
  });

  it('states a clean runtime as an observation rather than as an empty table', () => {
    render(view({ drifts: [] }));

    expect(screen.getByText('No drift detected against managed files')).toBeTruthy();
  });

  it('summarises what a plan does without opening it', () => {
    render(
      view({
        plans: [
          plan({
            changes: [
              {
                path: 'a',
                operation: 'create',
                managementMode: 'managed-file',
                redactedDiff: '',
                warnings: [],
              },
              {
                path: 'b',
                operation: 'update',
                managementMode: 'managed-fragment',
                redactedDiff: '',
                warnings: ['careful'],
              },
            ],
          }),
        ],
      }),
    );

    const panel = screen.getByRole('region', { name: 'Configuration plans' });
    const row = within(panel).getByRole('row', { name: /plan-1/ });
    expect(within(row).getByText('1 create · 1 update')).toBeTruthy();
    expect(within(row).getByText('1 warned')).toBeTruthy();
  });

  it('opens a plan and shows the redacted diff the daemon produced', () => {
    render(view());

    fireEvent.click(screen.getByRole('button', { name: 'Open plan-1' }));

    const detail = screen.getByRole('dialog', { name: 'Plan detail' });
    expect(within(detail).getByText('+ enabled = true')).toBeTruthy();
    expect(within(detail).getByText('Existing fragment replaced')).toBeTruthy();
    expect(within(detail).getByText('managed-fragment')).toBeTruthy();
  });

  it('says a change produced no diff rather than rendering an empty block', () => {
    render(
      view({
        plans: [
          plan({
            changes: [
              {
                path: 'a',
                operation: 'delete',
                managementMode: 'managed-file',
                redactedDiff: '',
                warnings: [],
              },
            ],
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open plan-1' }));

    const detail = screen.getByRole('dialog', { name: 'Plan detail' });
    expect(within(detail).getByText('No diff recorded')).toBeTruthy();
  });

  it('says a plan never reached a snapshot instead of showing a blank link', () => {
    render(view({ plans: [plan({ state: 'prepared', snapshotId: undefined })] }));

    const panel = screen.getByRole('region', { name: 'Configuration plans' });
    const row = within(panel).getByRole('row', { name: /plan-1/ });
    expect(within(row).getByText('Not applied')).toBeTruthy();
  });

  it('marks a snapshot file the apply created, because rolling it back is a delete', () => {
    render(
      view({
        snapshots: [
          snapshot({
            files: [
              { targetPath: 'C:/fixture/.codex/config.toml', existed: true, originalHash: hashA },
              { targetPath: 'C:/fixture/.codex/new.toml', existed: false, originalHash: null },
            ],
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open snapshot-1' }));

    const detail = screen.getByRole('dialog', { name: 'Snapshot detail' });
    const created = within(detail).getByRole('row', { name: /new\.toml/ });
    expect(within(created).getByText('Created by the apply')).toBeTruthy();
    const restored = within(detail).getByRole('row', { name: /config\.toml/ });
    expect(within(restored).getByText('Existed before')).toBeTruthy();
  });

  it('distinguishes an empty chain from a failed one', () => {
    const { unmount } = render(view({ drifts: [], plans: [], snapshots: [] }));
    expect(screen.getByText('No configuration plans recorded')).toBeTruthy();
    expect(screen.getByText('No configuration snapshots recorded')).toBeTruthy();
    unmount();

    render(
      <ConfigView
        drifts={{ state: 'unavailable' }}
        plans={{ state: 'unavailable' }}
        snapshots={{ state: 'unavailable' }}
      />,
    );
    expect(screen.getAllByText('Unavailable')).toHaveLength(3);
  });

  it('reports a first paint as loading rather than as a fault', () => {
    render(<ConfigView drifts={undefined} plans={undefined} snapshots={undefined} loading />);

    expect(screen.getAllByText('Loading')).toHaveLength(3);
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  /**
   * The mutation capability is a prop, not an import, so a caller that passes
   * none gets the surface exactly as it was before the chain became reachable.
   * These are the operations that write the developer's own agent
   * configuration, so the read-only render must offer literally none of them.
   */
  it('offers no control that plans, approves, applies, rolls back, or rescans', () => {
    render(view());

    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name).toMatch(/^(Open|Hide|Copy)\b/);
    }
    // Every other way to submit something, including the plan form's picker
    // and its adopt checkbox. Prose is deliberately not asserted on: the panel
    // notes describe operations the daemon performs, and a word in a sentence
    // is not a control.
    expect(document.querySelectorAll('select, input, textarea, form')).toHaveLength(0);
  });
});

function agentsReady(): ResourceState<ConfigAgentOption[]> {
  return { state: 'ready', data: [{ id: 'codex-main', displayName: 'Codex', enabled: true }] };
}

function stubMutations(overrides: Partial<ConfigMutations> = {}): ConfigMutations {
  return {
    createImportPlan: vi.fn(),
    createRenderPlan: vi.fn(),
    createRollbackPlan: vi.fn(),
    scanDrift: vi.fn(),
    applyPlanWithApproval: vi.fn(),
    ...overrides,
  } as unknown as ConfigMutations;
}

function mutableView({
  drifts = [drift()],
  plans = [plan()],
  snapshots = [snapshot()],
  agents = agentsReady(),
  mutations = stubMutations(),
  onMutated,
}: {
  drifts?: ConfigDriftRecord[];
  plans?: ConfigPlanRecord[];
  snapshots?: ConfigSnapshotRecord[];
  agents?: ResourceState<ConfigAgentOption[]>;
  mutations?: ConfigMutations;
  onMutated?: () => void;
} = {}) {
  return (
    <ConfigView
      drifts={{ state: 'ready', data: drifts }}
      plans={{ state: 'ready', data: plans }}
      snapshots={{ state: 'ready', data: snapshots }}
      agents={agents}
      mutations={mutations}
      {...(onMutated === undefined ? {} : { onMutated })}
    />
  );
}

describe('ConfigView mutations', () => {
  it('offers Apply on a prepared plan and nothing on an approved one', () => {
    render(
      mutableView({
        plans: [
          plan({ id: 'plan-prepared', state: 'prepared' }),
          plan({ id: 'plan-approved', state: 'approved' }),
        ],
      }),
    );

    expect(screen.getByRole('button', { name: 'Apply plan-prepared' })).toBeTruthy();
    // The dashboard holds no token for an already-approved plan and the state
    // machine mints no second one, so offering a control would be a lie.
    expect(screen.queryByRole('button', { name: 'Apply plan-approved' })).toBeNull();
  });

  it('does not approve anything until the dialog is confirmed', () => {
    const applyPlanWithApproval = vi.fn();
    render(
      mutableView({
        plans: [plan({ id: 'plan-1', state: 'prepared' })],
        mutations: stubMutations({ applyPlanWithApproval }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(applyPlanWithApproval).not.toHaveBeenCalled();
  });

  it('names every file the apply will write inside the dialog', () => {
    render(mutableView({ plans: [plan({ id: 'plan-1', state: 'prepared' })] }));

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText('C:/fixture/.codex/config.toml')).toBeTruthy();
    expect(within(dialog).getByText(/your own agent configuration files/i)).toBeTruthy();
  });

  it('cancelling the dialog approves nothing', () => {
    const applyPlanWithApproval = vi.fn();
    render(
      mutableView({
        plans: [plan({ id: 'plan-1', state: 'prepared' })],
        mutations: stubMutations({ applyPlanWithApproval }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(applyPlanWithApproval).not.toHaveBeenCalled();
  });

  it('applies once on confirmation and reports the outcome', async () => {
    const applyPlanWithApproval = vi.fn().mockResolvedValue({
      state: 'ok',
      httpStatus: 200,
      data: { id: 'op-1', planId: 'plan-1', state: 'completed', targetPaths: ['a'] },
    });
    const onMutated = vi.fn();
    render(
      mutableView({
        plans: [plan({ id: 'plan-1', state: 'prepared' })],
        mutations: stubMutations({ applyPlanWithApproval }),
        onMutated,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('Plan plan-1 applied.')).toBeTruthy();
    expect(applyPlanWithApproval).toHaveBeenCalledTimes(1);
    expect(applyPlanWithApproval).toHaveBeenCalledWith('plan-1');
    expect(onMutated).toHaveBeenCalled();
  });

  it('renders the daemon message when the apply is refused', async () => {
    const applyPlanWithApproval = vi.fn().mockResolvedValue({
      state: 'failed',
      reason: 'http',
      httpStatus: 409,
      code: 'CONFIG_APPLY_FAILED',
      message: 'Another configuration operation currently owns a target file.',
    });
    render(
      mutableView({
        plans: [plan({ id: 'plan-1', state: 'prepared' })],
        mutations: stubMutations({ applyPlanWithApproval }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply plan-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(
      await screen.findByText('Another configuration operation currently owns a target file.'),
    ).toBeTruthy();
  });

  it('rescans drift through its own control', async () => {
    const scanDrift = vi.fn().mockResolvedValue({ state: 'ok', httpStatus: 200, data: [] });
    render(mutableView({ mutations: stubMutations({ scanDrift }) }));

    fireEvent.click(screen.getByRole('button', { name: 'Rescan drift' }));

    expect(await screen.findByText('Drift rescanned.')).toBeTruthy();
    expect(scanDrift).toHaveBeenCalledTimes(1);
  });

  /**
   * A clean drift list is exactly when a reader wants to check for new drift,
   * and a `ResourcePanel` renders no children for an empty resource — so the
   * control cannot live inside the panel.
   */
  it('still offers the rescan when no drift is outstanding', () => {
    render(mutableView({ drifts: [] }));

    expect(screen.getByText('No drift detected against managed files')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rescan drift' })).toBeTruthy();
  });

  it('creates a rollback plan rather than rolling back directly', async () => {
    const createRollbackPlan = vi
      .fn()
      .mockResolvedValue({ state: 'ok', httpStatus: 201, data: plan({ kind: 'rollback' }) });
    render(mutableView({ mutations: stubMutations({ createRollbackPlan }) }));

    fireEvent.click(screen.getByRole('button', { name: 'Roll back to snapshot-1' }));

    // A rollback produces a plan that still has to pass the apply gate, so the
    // undo cannot skip the diff review the forward change needed.
    expect(
      await screen.findByText('Rollback plan prepared. Review its changes, then apply it.'),
    ).toBeTruthy();
    expect(createRollbackPlan).toHaveBeenCalledWith('snapshot-1');
  });

  it('creates a plan from the form at whichever endpoint was pressed', async () => {
    const createRenderPlan = vi
      .fn()
      .mockResolvedValue({ state: 'ok', httpStatus: 201, data: plan() });
    render(mutableView({ mutations: stubMutations({ createRenderPlan }) }));

    fireEvent.click(screen.getByRole('button', { name: 'Render plan' }));

    expect(
      await screen.findByText('Plan prepared. Review its changes, then apply it.'),
    ).toBeTruthy();
    expect(createRenderPlan).toHaveBeenCalledWith({
      agentId: 'codex-main',
      adoptUnmanaged: false,
    });
  });

  it('offers no plan form while the agent list is unavailable', () => {
    render(mutableView({ agents: { state: 'unavailable' } }));

    expect(screen.queryByRole('button', { name: 'Render plan' })).toBeNull();
    // The rest of the surface still works; only the picker is missing.
    expect(screen.getByRole('button', { name: 'Rescan drift' })).toBeTruthy();
  });
});
