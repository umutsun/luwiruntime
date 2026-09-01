import { useMemo, useState } from 'react';

import {
  profilesUsing,
  resolveProfileCapabilities,
  type Bounded,
  type CapabilityKind,
  type CatalogCapability,
  type CatalogProfile,
  type ResolvedProfileCapability,
} from '../api/capability-catalog.js';
import { DetailDrawer } from '../components/detail-drawer.js';
import { PanelBody, ResourcePanel, TableWrap, type ResourceState } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';

/**
 * The capability and profile catalogue, read-only.
 *
 * The Projects route resolves capabilities for one project-agent pair; this is
 * the inventory behind it. It answers what the pair view structurally cannot:
 * which packages exist at all, where each came from, which agent kinds it fits,
 * and which profiles name it — including the packages no profile names, which
 * were invisible on every other surface.
 *
 * No control here registers, enables, assigns, or rescans anything. The daemon
 * serves all of those and AGENTS.md section 21 keeps them off read surfaces.
 */

const KINDS: readonly CapabilityKind[] = [
  'skill',
  'plugin',
  'hook',
  'mcp',
  'policy',
  'profile',
  'instruction',
];

/** How a profile's reference to a package resolved, as text before colour. */
const resolutionLabels: Record<ResolvedProfileCapability['resolution'], string> = {
  resolved: 'Resolved',
  'beyond-page': 'Beyond loaded page',
  absent: 'Not registered',
  unavailable: 'Catalogue unavailable',
};

function ScopeCell({ scope, projectId }: { scope: 'global' | 'project'; projectId?: string }) {
  return (
    <>
      {scope}
      {projectId === undefined ? null : <small title={projectId}>{projectId}</small>}
    </>
  );
}

function CapabilityTable({
  capabilities,
  selectedId,
  onToggle,
}: {
  capabilities: CatalogCapability[];
  selectedId: string | undefined;
  onToggle: (id: string) => void;
}) {
  return (
    <TableWrap caption="Capability packages">
      <thead>
        <tr>
          <th scope="col">Package</th>
          <th scope="col">Kind</th>
          <th scope="col">Scope</th>
          <th scope="col">Source</th>
          <th scope="col">Version</th>
          <th scope="col">State</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody>
        {capabilities.map((capability) => (
          <tr key={capability.id} aria-selected={capability.id === selectedId}>
            <td>
              {capability.name}
              <small title={capability.id}>{capability.id}</small>
            </td>
            <td>{capability.kind}</td>
            <td>
              <ScopeCell
                scope={capability.scope}
                {...(capability.projectId === undefined ? {} : { projectId: capability.projectId })}
              />
            </td>
            <td>{capability.source}</td>
            <td>{capability.version ?? <span className="unavailable">Not versioned</span>}</td>
            <td>
              {capability.observed ? <StatusChip tone="unknown">Observed</StatusChip> : null}
              <StatusChip tone={capability.enabled ? 'success' : 'unknown'}>
                {capability.enabled ? 'Enabled' : 'Disabled'}
              </StatusChip>
            </td>
            <td>
              <button
                type="button"
                aria-label={`${capability.id === selectedId ? 'Hide' : 'Open'} ${capability.name}`}
                onClick={() => onToggle(capability.id)}
              >
                {capability.id === selectedId ? 'Hide' : 'Open'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

function PackageDetail({
  capability,
  profiles,
}: {
  capability: CatalogCapability;
  profiles: ResourceState<CatalogProfile[]> | undefined;
}) {
  const carriers = profiles?.state === 'ready' ? profilesUsing(capability.id, profiles.data) : [];

  return (
    <div className="detail-content">
      <dl className="key-values">
        <div>
          <dt>Identifier</dt>
          <dd>
            <code title={capability.id}>{capability.id}</code>
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{capability.source}</dd>
        </div>
        <div>
          <dt>Provenance</dt>
          <dd>{capability.observed ? 'Observed from native filesystem' : 'Declared'}</dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd>
            {capability.path === undefined ? (
              // A package can be registered without a filesystem path — a
              // bundled one, for instance. That is not a missing measurement.
              <span className="unavailable">No path recorded</span>
            ) : (
              <code title={capability.path}>{capability.path}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Checksum</dt>
          <dd>
            <code title={capability.checksum}>{capability.checksum.slice(0, 12)}</code>
          </dd>
        </div>
      </dl>

      <p className="group-label">
        <span>Compatible agent kinds</span>
        <span className="group-label__count">{capability.compatibleAgentKinds.length}</span>
      </p>
      {capability.compatibleAgentKinds.length === 0 ? (
        <p className="empty-state">Declared compatible with no agent kind</p>
      ) : (
        <ul className="name-list">
          {capability.compatibleAgentKinds.map((kind) => (
            <li key={kind}>{kind}</li>
          ))}
        </ul>
      )}

      <p className="group-label">
        <span>Requires</span>
        <span className="group-label__count">
          {capability.requiredCapabilityIds.length + capability.requiredMcpIds.length}
        </span>
      </p>
      {capability.requiredCapabilityIds.length === 0 && capability.requiredMcpIds.length === 0 ? (
        <p className="empty-state">Requires nothing else</p>
      ) : (
        <ul className="name-list">
          {capability.requiredCapabilityIds.map((id) => (
            <li key={`cap-${id}`}>{id}</li>
          ))}
          {capability.requiredMcpIds.map((id) => (
            <li key={`mcp-${id}`}>{id} (MCP)</li>
          ))}
        </ul>
      )}

      {/*
       * A package no profile names is a real and interesting state, but it can
       * only be asserted when the profile read succeeded. With that read
       * unavailable the honest answer is that it is unknown, not "unused".
       */}
      <p className="group-label">
        <span>Carried by profiles</span>
        {profiles?.state === 'ready' ? (
          <span className="group-label__count">{carriers.length}</span>
        ) : null}
      </p>
      {profiles === undefined || profiles.state !== 'ready' ? (
        <p className="empty-state">Profile list unavailable</p>
      ) : carriers.length === 0 ? (
        <p className="empty-state">No profile names this package</p>
      ) : (
        <ul className="name-list">
          {carriers.map((carrier) => (
            <li key={carrier.id}>
              {carrier.name}
              {carrier.disabled ? <small>Disabled by this profile</small> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProfileDetail({
  profile,
  capabilities,
}: {
  profile: CatalogProfile;
  capabilities: ResourceState<Bounded<CatalogCapability>> | undefined;
}) {
  const resolved = resolveProfileCapabilities(
    profile,
    capabilities?.state === 'ready' ? capabilities.data : undefined,
  );

  return (
    <div className="detail-content">
      <dl className="key-values">
        <div>
          <dt>Identifier</dt>
          <dd>
            <code title={profile.id}>{profile.id}</code>
          </dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>
            <ScopeCell
              scope={profile.scope}
              {...(profile.projectId === undefined ? {} : { projectId: profile.projectId })}
            />
          </dd>
        </div>
      </dl>

      <p className="group-label">
        <span>Capabilities</span>
        <span className="group-label__count">{resolved.length}</span>
      </p>
      {resolved.length === 0 ? (
        <p className="empty-state">This profile names no capability</p>
      ) : (
        <TableWrap caption="Capabilities named by this profile">
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Kind</th>
              <th scope="col">Resolution</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {resolved.map((entry) => (
              <tr key={entry.id}>
                <td>
                  {entry.name ?? <code title={entry.id}>{entry.id}</code>}
                  {entry.name === undefined ? null : <small title={entry.id}>{entry.id}</small>}
                </td>
                <td>{entry.kind ?? <span className="unavailable">Unknown</span>}</td>
                <td>
                  {entry.resolution === 'resolved' ? (
                    resolutionLabels.resolved
                  ) : (
                    <span className="unavailable">{resolutionLabels[entry.resolution]}</span>
                  )}
                </td>
                <td>
                  {entry.disabledByProfile === true ? (
                    <StatusChip tone="warning">Disabled by profile</StatusChip>
                  ) : entry.enabled === undefined ? (
                    <span className="unavailable">Not resolved</span>
                  ) : (
                    <StatusChip tone={entry.enabled ? 'success' : 'unknown'}>
                      {entry.enabled ? 'Enabled' : 'Disabled'}
                    </StatusChip>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <p className="group-label">
        <span>Policies</span>
        <span className="group-label__count">{profile.policyIds.length}</span>
      </p>
      {profile.policyIds.length === 0 ? (
        <p className="empty-state">This profile names no policy</p>
      ) : (
        <ul className="name-list">
          {profile.policyIds.map((id) => (
            <li key={id}>{id}</li>
          ))}
        </ul>
      )}

      {/* Keys only: adapter settings can carry native agent configuration, and
          which knobs a profile sets is the catalogue's question, not what it
          sets them to. */}
      <p className="group-label">
        <span>Adapter settings</span>
        <span className="group-label__count">{profile.adapterSettingKeys.length}</span>
      </p>
      {profile.adapterSettingKeys.length === 0 ? (
        <p className="empty-state">This profile overrides no adapter setting</p>
      ) : (
        <ul className="name-list">
          {profile.adapterSettingKeys.map((key) => (
            <li key={key}>{key}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CapabilitiesView({
  capabilities,
  profiles,
  loading = false,
}: {
  capabilities: ResourceState<Bounded<CatalogCapability>> | undefined;
  profiles: ResourceState<CatalogProfile[]> | undefined;
  loading?: boolean;
}) {
  const [kindFilter, setKindFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [selection, setSelection] = useState<
    { kind: 'capability' | 'profile'; id: string } | undefined
  >();

  const allCapabilities = capabilities?.state === 'ready' ? capabilities.data.items : [];
  const allProfiles = profiles?.state === 'ready' ? profiles.data : [];

  const filtered = useMemo(
    () =>
      allCapabilities.filter(
        (capability) =>
          (kindFilter === '' || capability.kind === kindFilter) &&
          (scopeFilter === '' || capability.scope === scopeFilter) &&
          (stateFilter === '' || capability.enabled === (stateFilter === 'enabled')),
      ),
    [allCapabilities, kindFilter, scopeFilter, stateFilter],
  );

  const selectedCapability =
    selection?.kind === 'capability'
      ? allCapabilities.find((capability) => capability.id === selection.id)
      : undefined;
  const selectedProfile =
    selection?.kind === 'profile'
      ? allProfiles.find((profile) => profile.id === selection.id)
      : undefined;
  const disabledCount = allCapabilities.filter((capability) => !capability.enabled).length;

  return (
    <div className="route-stack">
      <ResourcePanel<Bounded<CatalogCapability>>
        title="Capability packages"
        meta={
          capabilities?.state === 'ready'
            ? `${String(allCapabilities.length)} registered · ${String(disabledCount)} disabled`
            : undefined
        }
        resource={capabilities}
        loading={loading}
        emptyMessage="No capability packages registered"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <PanelBody>
              <div className="table-filters">
                <label>
                  Kind
                  <select
                    value={kindFilter}
                    onChange={(event) => setKindFilter(event.target.value)}
                  >
                    <option value="">All kinds</option>
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Scope
                  <select
                    value={scopeFilter}
                    onChange={(event) => setScopeFilter(event.target.value)}
                  >
                    <option value="">All scopes</option>
                    <option value="global">global</option>
                    <option value="project">project</option>
                  </select>
                </label>
                <label>
                  State
                  <select
                    value={stateFilter}
                    onChange={(event) => setStateFilter(event.target.value)}
                  >
                    <option value="">Any state</option>
                    <option value="enabled">Enabled</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
                <span className="table-filters__count">
                  {String(filtered.length)} of {String(allCapabilities.length)}
                </span>
              </div>
            </PanelBody>

            {filtered.length === 0 ? (
              <PanelBody>
                <p className="empty-state">No capability packages match this filter</p>
              </PanelBody>
            ) : (
              <CapabilityTable
                capabilities={filtered}
                selectedId={selection?.kind === 'capability' ? selection.id : undefined}
                onToggle={(id) => {
                  setSelection((current) =>
                    current?.kind === 'capability' && current.id === id
                      ? undefined
                      : { kind: 'capability', id },
                  );
                }}
              />
            )}

            {value.truncated ? (
              <PanelBody>
                <p className="bounded-note">
                  Bounded list — more capability packages exist than are shown, and a profile naming
                  one of them resolves as beyond the loaded page rather than as missing.
                </p>
              </PanelBody>
            ) : null}
          </>
        )}
      </ResourcePanel>

      <ResourcePanel<CatalogProfile[]>
        title="Capability profiles"
        meta={profiles?.state === 'ready' ? `${String(allProfiles.length)} registered` : undefined}
        resource={profiles}
        loading={loading}
        emptyMessage="No capability profiles registered"
        isEmpty={(value) => value.length === 0}
      >
        {(value) => (
          <TableWrap caption="Capability profiles">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Scope</th>
                <th scope="col">Capabilities</th>
                <th scope="col">Disabled</th>
                <th scope="col">Policies</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {value.map((profile) => (
                <tr
                  key={profile.id}
                  aria-selected={selection?.kind === 'profile' && profile.id === selection.id}
                >
                  <td>
                    {profile.name}
                    <small title={profile.id}>{profile.id}</small>
                  </td>
                  <td>
                    <ScopeCell
                      scope={profile.scope}
                      {...(profile.projectId === undefined ? {} : { projectId: profile.projectId })}
                    />
                  </td>
                  <td>{profile.capabilityIds.length}</td>
                  <td>{profile.disabledCapabilityIds.length}</td>
                  <td>{profile.policyIds.length}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={`${selection?.kind === 'profile' && profile.id === selection.id ? 'Hide' : 'Open'} ${profile.name}`}
                      onClick={() => {
                        setSelection((current) =>
                          current?.kind === 'profile' && current.id === profile.id
                            ? undefined
                            : { kind: 'profile', id: profile.id },
                        );
                      }}
                    >
                      {selection?.kind === 'profile' && profile.id === selection.id
                        ? 'Hide'
                        : 'Open'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </ResourcePanel>

      {selectedCapability === undefined ? null : (
        <DetailDrawer
          eyebrow="Read-only evidence"
          title="Package detail"
          meta={selectedCapability.kind}
          onClose={() => setSelection(undefined)}
        >
          <PackageDetail capability={selectedCapability} profiles={profiles} />
        </DetailDrawer>
      )}

      {selectedProfile === undefined ? null : (
        <DetailDrawer
          eyebrow="Read-only evidence"
          title="Profile detail"
          meta={selectedProfile.scope}
          onClose={() => setSelection(undefined)}
        >
          <ProfileDetail profile={selectedProfile} capabilities={capabilities} />
        </DetailDrawer>
      )}

      <p className="bounded-note">
        Scope follows ADR 0008: a global package is available to every project, a project-scoped one
        only to the project it names. A profile disabling a capability it also names is not a
        contradiction — it is how a profile narrows an inherited set.
      </p>
    </div>
  );
}
