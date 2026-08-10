// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  driftKind,
  type ConfigDriftRecord,
  type ConfigPlanRecord,
  type ConfigSnapshotRecord,
} from '../api/config-scope.js';
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

    const detail = screen.getByRole('region', { name: 'Plan detail' });
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

    const detail = screen.getByRole('region', { name: 'Plan detail' });
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

    const detail = screen.getByRole('region', { name: 'Snapshot detail' });
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
   * Section 21 matters more here than anywhere else on this dashboard: these
   * are the operations that write to the developer's own agent configuration.
   */
  it('offers no control that plans, approves, applies, rolls back, or rescans', () => {
    render(view());

    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name).toMatch(/^(Open|Hide|Copy)\b/);
    }
    expect(screen.queryByText(/Apply|Approve|Roll back|Rescan|Reconcile/)).toBeNull();
  });
});
