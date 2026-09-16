// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CatalogCapability, CatalogProfile } from '../api/capability-catalog.js';
import { CapabilitiesView } from './capabilities-view.js';

afterEach(cleanup);

type CapabilityOverrides = { [K in keyof CatalogCapability]?: CatalogCapability[K] | undefined };

/**
 * `exactOptionalPropertyTypes` is on, so an override of `undefined` cannot be
 * spread in as a present-but-undefined key. Stripping those keys is how a
 * fixture expresses "the runtime never recorded this".
 */
function capability(overrides: CapabilityOverrides = {}): CatalogCapability {
  const merged: Record<string, unknown> = {
    id: 'cap-review',
    kind: 'skill',
    name: 'Code review',
    version: '1.2.0',
    scope: 'global',
    source: 'luwi-global',
    path: 'C:/luwi/skills/review',
    checksum: 'a'.repeat(64),
    compatibleAgentKinds: ['codex', 'claude-code'],
    requiredCapabilityIds: [],
    requiredMcpIds: [],
    enabled: true,
    observed: false,
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged as unknown as CatalogCapability;
}

function profile(overrides: Partial<CatalogProfile> = {}): CatalogProfile {
  return {
    id: 'profile-reviewer',
    name: 'Reviewer',
    scope: 'global',
    capabilityIds: ['cap-review'],
    policyIds: [],
    disabledCapabilityIds: [],
    adapterSettingKeys: [],
    ...overrides,
  };
}

function view({
  capabilities = [capability()],
  truncated = false,
  profiles = [profile()],
}: {
  capabilities?: CatalogCapability[];
  truncated?: boolean;
  profiles?: CatalogProfile[];
} = {}) {
  return (
    <CapabilitiesView
      capabilities={{ state: 'ready', data: { items: capabilities, truncated } }}
      profiles={{ state: 'ready', data: profiles }}
    />
  );
}

describe('CapabilitiesView', () => {
  it('insets catalogue controls and notes without adding padding around the table', () => {
    render(view({ truncated: true }));

    const panel = screen.getByRole('region', { name: 'Capability packages' });
    const filters = within(panel).getByLabelText('Kind').closest('.table-filters');
    const note = within(panel).getByText(/more capability packages exist/i);
    expect(filters?.parentElement?.classList.contains('panel__body')).toBe(true);
    expect(note.closest('.panel__body')).toBeTruthy();
    expect(within(panel).getByRole('table').closest('.panel__body')).toBeNull();
  });

  it('lists a package with the evidence that identifies it', () => {
    render(view());

    const row = screen.getByRole('row', { name: /Code review/ });
    expect(within(row).getByText('skill')).toBeTruthy();
    expect(within(row).getByText('global')).toBeTruthy();
    expect(within(row).getByText('luwi-global')).toBeTruthy();
    expect(within(row).getByText('1.2.0')).toBeTruthy();
    expect(within(row).getByText('Enabled')).toBeTruthy();
  });

  it('says a package carries no version rather than leaving the cell blank', () => {
    render(view({ capabilities: [capability({ version: undefined })] }));

    const row = screen.getByRole('row', { name: /Code review/ });
    expect(within(row).getByText('Not versioned')).toBeTruthy();
  });

  it('shows observed provenance separately from enabled state', () => {
    render(view({ capabilities: [capability({ observed: true, source: 'agent-native' })] }));

    const row = screen.getByRole('row', { name: /Code review/ });
    expect(within(row).getByText('Observed')).toBeTruthy();
    expect(within(row).getByText('Enabled')).toBeTruthy();
  });

  it('filters the catalogue by kind and keeps the empty result distinct from an empty catalogue', () => {
    render(
      view({
        capabilities: [capability(), capability({ id: 'cap-mcp', name: 'Search', kind: 'mcp' })],
      }),
    );

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'policy' } });

    expect(screen.getByText('No capability packages match this filter')).toBeTruthy();
    expect(screen.queryByText('No capability packages registered')).toBeNull();
  });

  it('filters by scope and by enabled state', () => {
    render(
      view({
        capabilities: [
          capability(),
          capability({
            id: 'cap-local',
            name: 'Local rule',
            scope: 'project',
            projectId: 'proj-1',
            enabled: false,
          }),
        ],
      }),
    );

    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'project' } });
    expect(screen.queryByRole('row', { name: /Code review/ })).toBeNull();
    expect(screen.getByRole('row', { name: /Local rule/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'enabled' } });
    expect(screen.getByRole('row', { name: /Code review/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /Local rule/ })).toBeNull();
  });

  it('opens a package and names the profiles that carry it', () => {
    render(
      view({
        profiles: [
          profile(),
          profile({ id: 'profile-off', name: 'Restricted', disabledCapabilityIds: ['cap-review'] }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Code review' }));

    const detail = screen.getByRole('region', { name: 'Package detail' });
    expect(within(detail).getByText('Reviewer')).toBeTruthy();
    expect(within(detail).getByText('Restricted')).toBeTruthy();
    expect(within(detail).getByText('Disabled by this profile')).toBeTruthy();
    expect(within(detail).getByText('C:/luwi/skills/review')).toBeTruthy();
  });

  it('states that no profile carries a package instead of leaving the section empty', () => {
    render(view({ profiles: [profile({ capabilityIds: [] })] }));

    fireEvent.click(screen.getByRole('button', { name: 'Open Code review' }));

    const detail = screen.getByRole('region', { name: 'Package detail' });
    expect(within(detail).getByText('No profile names this package')).toBeTruthy();
  });

  /**
   * The profile list is a separate read. If it failed, "no profile carries
   * this" would be a fabrication — the honest answer is that it is unknown.
   */
  it('does not claim a package is unused when the profile read failed', () => {
    render(
      <CapabilitiesView
        capabilities={{ state: 'ready', data: { items: [capability()], truncated: false } }}
        profiles={{ state: 'unavailable' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Code review' }));

    const detail = screen.getByRole('region', { name: 'Package detail' });
    expect(within(detail).getByText('Profile list unavailable')).toBeTruthy();
    expect(within(detail).queryByText('No profile names this package')).toBeNull();
  });

  it('resolves a profile reference to its package name and marks the disabled one', () => {
    render(
      view({
        capabilities: [capability(), capability({ id: 'cap-migrate', name: 'Migrate' })],
        profiles: [
          profile({
            capabilityIds: ['cap-review', 'cap-migrate'],
            disabledCapabilityIds: ['cap-migrate'],
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Reviewer' }));

    const detail = screen.getByRole('region', { name: 'Profile detail' });
    expect(within(detail).getByText('Code review')).toBeTruthy();
    const migrate = within(detail).getByRole('row', { name: /Migrate/ });
    expect(within(migrate).getByText('Disabled by profile')).toBeTruthy();
  });

  it('separates a reference beyond the loaded page from one that does not exist', () => {
    const { unmount } = render(
      view({
        capabilities: [capability()],
        truncated: true,
        profiles: [profile({ capabilityIds: ['cap-ghost'] })],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Reviewer' }));
    expect(
      within(screen.getByRole('region', { name: 'Profile detail' })).getByText(
        'Beyond loaded page',
      ),
    ).toBeTruthy();
    unmount();

    render(
      view({ capabilities: [capability()], profiles: [profile({ capabilityIds: ['cap-ghost'] })] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Reviewer' }));
    expect(
      within(screen.getByRole('region', { name: 'Profile detail' })).getByText('Not registered'),
    ).toBeTruthy();
  });

  it('discloses truncation rather than presenting a cut page as the whole catalogue', () => {
    render(view({ truncated: true }));

    expect(screen.getByText(/Bounded list/)).toBeTruthy();
  });

  it('says nothing about truncation when the page held everything', () => {
    render(view());

    expect(screen.queryByText(/Bounded list/)).toBeNull();
  });

  it('distinguishes an empty catalogue from a failed read', () => {
    const { unmount } = render(
      <CapabilitiesView
        capabilities={{ state: 'ready', data: { items: [], truncated: false } }}
        profiles={{ state: 'ready', data: [] }}
      />,
    );
    expect(screen.getByText('No capability packages registered')).toBeTruthy();
    expect(screen.getByText('No capability profiles registered')).toBeTruthy();
    unmount();

    render(
      <CapabilitiesView
        capabilities={{ state: 'unavailable' }}
        profiles={{ state: 'unavailable' }}
      />,
    );
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
  });

  it('reports a first paint as loading rather than as a fault', () => {
    render(<CapabilitiesView capabilities={undefined} profiles={undefined} loading />);

    expect(screen.getAllByText('Loading')).toHaveLength(2);
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  /** Section 21 keeps every catalogue mutation the daemon serves off this surface. */
  it('offers no control that registers, enables, assigns, or scans', () => {
    render(view());

    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name).toMatch(/^(Open|Hide|Copy)\b/);
    }
  });
});
