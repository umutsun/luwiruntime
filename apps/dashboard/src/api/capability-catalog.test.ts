import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { DaemonClient, ResourceResult } from './client.js';
import {
  capabilityCatalogResourcesForEvent,
  loadCapabilityCatalog,
  profilesUsing,
  resolveProfileCapabilities,
  type CatalogCapability,
} from './capability-catalog.js';

const timestamp = '2026-08-10T00:00:00.000Z';

function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    manifest: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'profile-reviewer',
    name: 'Reviewer',
    scope: 'global',
    capabilityIds: ['cap-review'],
    policyIds: [],
    disabledCapabilityIds: [],
    adapterSettings: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

/** Runs the real protocol schemas, so a drifted fixture fails here, not in a browser. */
function stubClient(payloads: {
  capabilities?: unknown[];
  truncated?: boolean;
  profiles?: unknown[];
}): { client: DaemonClient; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    client: {
      async get<T>(path: string, schema: z.ZodType<T>): Promise<ResourceResult<T>> {
        paths.push(path);
        const body = path.startsWith('/api/v1/profiles')
          ? { profiles: payloads.profiles ?? [] }
          : { capabilities: payloads.capabilities ?? [], truncated: payloads.truncated ?? false };
        return {
          state: 'ready',
          data: schema.parse(body),
          httpStatus: 200,
          receivedAt: timestamp,
        };
      },
    },
  };
}

describe('loadCapabilityCatalog', () => {
  it('maps a capability package with its optional fields', async () => {
    const { client, paths } = stubClient({ capabilities: [capability()] });

    const result = await loadCapabilityCatalog(client, ['capabilities']);

    expect(paths).toEqual(['/api/v1/capabilities?limit=100']);
    expect(result.capabilities).toMatchObject({
      state: 'ready',
      data: {
        truncated: false,
        items: [
          {
            id: 'cap-review',
            kind: 'skill',
            name: 'Code review',
            version: '1.2.0',
            scope: 'global',
            source: 'luwi-global',
            enabled: true,
            observed: false,
            compatibleAgentKinds: ['codex', 'claude-code'],
          },
        ],
      },
    });
  });

  it('maps only the explicit observation marker as observed provenance', async () => {
    const { client } = stubClient({
      capabilities: [
        capability({
          source: 'agent-native',
          manifest: {
            managementMode: 'observed',
            observation: {
              adapterId: 'claude-code-native-v1',
              root: 'C:/home/.claude/skills',
              manifestPath: 'C:/home/.claude/skills/review/SKILL.md',
              observedAt: timestamp,
            },
          },
        }),
      ],
    });

    const result = await loadCapabilityCatalog(client, ['capabilities']);
    const item =
      result.capabilities?.state === 'ready' ? result.capabilities.data.items[0] : undefined;

    expect(item?.observed).toBe(true);
  });

  it('omits an unversioned, pathless package rather than inventing blanks for it', async () => {
    const { client } = stubClient({
      capabilities: [capability({ version: undefined, path: undefined })],
    });

    const result = await loadCapabilityCatalog(client, ['capabilities']);
    const item =
      result.capabilities?.state === 'ready' ? result.capabilities.data.items[0] : undefined;

    expect(item === undefined ? true : 'version' in item).toBe(false);
    expect(item === undefined ? true : 'path' in item).toBe(false);
  });

  it('carries the truncation the daemon reports rather than deriving one of its own', async () => {
    const { client } = stubClient({ capabilities: [capability()], truncated: true });

    const result = await loadCapabilityCatalog(client, ['capabilities']);

    expect(result.capabilities).toMatchObject({ data: { truncated: true } });
  });

  it('maps profiles and keeps the project scope a project-scoped one carries', async () => {
    const { client, paths } = stubClient({
      profiles: [
        profile(),
        profile({
          id: 'profile-local',
          name: 'Local',
          scope: 'project',
          projectId: 'proj-1',
          capabilityIds: ['cap-review', 'cap-migrate'],
          disabledCapabilityIds: ['cap-migrate'],
          policyIds: ['policy-1'],
          adapterSettings: { model: 'x' },
        }),
      ],
    });

    const result = await loadCapabilityCatalog(client, ['profiles']);

    expect(paths).toEqual(['/api/v1/profiles']);
    expect(result.profiles).toMatchObject({
      state: 'ready',
      data: [
        { id: 'profile-reviewer', scope: 'global', capabilityIds: ['cap-review'] },
        {
          id: 'profile-local',
          scope: 'project',
          projectId: 'proj-1',
          disabledCapabilityIds: ['cap-migrate'],
          policyIds: ['policy-1'],
          adapterSettingKeys: ['model'],
        },
      ],
    });
  });

  it('reports each read as unavailable on its own, never as an empty catalogue', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'transport' }),
    } as unknown as DaemonClient;

    const result = await loadCapabilityCatalog(client, ['capabilities', 'profiles']);

    expect(result.capabilities).toEqual({ state: 'unavailable' });
    expect(result.profiles).toEqual({ state: 'unavailable' });
  });

  it('issues no request for a key that was not asked for', async () => {
    const { client, paths } = stubClient({});

    const result = await loadCapabilityCatalog(client, ['profiles']);

    expect(paths).toEqual(['/api/v1/profiles']);
    expect('capabilities' in result).toBe(false);
  });
});

describe('resolveProfileCapabilities', () => {
  const catalogue: CatalogCapability[] = [
    {
      id: 'cap-review',
      kind: 'skill',
      name: 'Code review',
      scope: 'global',
      source: 'luwi-global',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      observed: false,
      checksum: 'a'.repeat(64),
    },
  ];

  it('resolves a named capability and marks the ones the profile disables', () => {
    const resolved = resolveProfileCapabilities(
      {
        id: 'p',
        name: 'P',
        scope: 'global',
        capabilityIds: ['cap-review'],
        policyIds: [],
        disabledCapabilityIds: ['cap-review'],
        adapterSettingKeys: [],
      },
      { items: catalogue, truncated: false },
    );

    expect(resolved).toEqual([
      {
        id: 'cap-review',
        resolution: 'resolved',
        name: 'Code review',
        kind: 'skill',
        enabled: true,
        disabledByProfile: true,
      },
    ]);
  });

  /**
   * The two ways a name can be missing are not the same fact, and collapsing
   * them would either invent a dangling reference or hide a real one.
   */
  it('separates a reference beyond the loaded page from one that does not exist', () => {
    const beyond = resolveProfileCapabilities(
      {
        id: 'p',
        name: 'P',
        scope: 'global',
        capabilityIds: ['cap-missing'],
        policyIds: [],
        disabledCapabilityIds: [],
        adapterSettingKeys: [],
      },
      { items: catalogue, truncated: true },
    );
    const absent = resolveProfileCapabilities(
      {
        id: 'p',
        name: 'P',
        scope: 'global',
        capabilityIds: ['cap-missing'],
        policyIds: [],
        disabledCapabilityIds: [],
        adapterSettingKeys: [],
      },
      { items: catalogue, truncated: false },
    );

    expect(beyond[0]).toMatchObject({ id: 'cap-missing', resolution: 'beyond-page' });
    expect(absent[0]).toMatchObject({ id: 'cap-missing', resolution: 'absent' });
  });

  it('reports every reference as unresolvable when the catalogue read failed', () => {
    const resolved = resolveProfileCapabilities(
      {
        id: 'p',
        name: 'P',
        scope: 'global',
        capabilityIds: ['cap-review'],
        policyIds: [],
        disabledCapabilityIds: [],
        adapterSettingKeys: [],
      },
      undefined,
    );

    expect(resolved).toEqual([{ id: 'cap-review', resolution: 'unavailable' }]);
  });
});

describe('profilesUsing', () => {
  const profiles = [
    {
      id: 'p1',
      name: 'One',
      scope: 'global' as const,
      capabilityIds: ['cap-review', 'cap-migrate'],
      policyIds: [],
      disabledCapabilityIds: ['cap-migrate'],
      adapterSettingKeys: [],
    },
    {
      id: 'p2',
      name: 'Two',
      scope: 'global' as const,
      capabilityIds: [],
      policyIds: [],
      disabledCapabilityIds: [],
      adapterSettingKeys: [],
    },
  ];

  it('finds the profiles naming a capability and says which of them disable it', () => {
    expect(profilesUsing('cap-review', profiles)).toEqual([
      { id: 'p1', name: 'One', disabled: false },
    ]);
    expect(profilesUsing('cap-migrate', profiles)).toEqual([
      { id: 'p1', name: 'One', disabled: true },
    ]);
  });

  it('returns nothing for a capability no profile names', () => {
    expect(profilesUsing('cap-orphan', profiles)).toEqual([]);
  });
});

describe('capabilityCatalogResourcesForEvent', () => {
  it('refreshes the catalogue on every capability transition', () => {
    for (const type of [
      'capability.registered',
      'capability.updated',
      'capability.disabled',
      'capability.assigned',
      'capability.unassigned',
    ]) {
      expect(capabilityCatalogResourcesForEvent(type)).toEqual(['capabilities']);
    }
  });

  it('refreshes profiles on every profile transition', () => {
    for (const type of ['profile.registered', 'profile.updated', 'profile.assigned']) {
      expect(capabilityCatalogResourcesForEvent(type)).toEqual(['profiles']);
    }
  });

  it('refreshes both on a runtime lifecycle event', () => {
    expect(capabilityCatalogResourcesForEvent('runtime.started')).toEqual([
      'capabilities',
      'profiles',
    ]);
  });

  /**
   * `context.capability.loaded` is a context observation, not a catalogue
   * change. A prefix match on `capability.` would refresh on it every time an
   * agent loads a skill.
   */
  it('ignores families this route does not render, including context capability events', () => {
    for (const type of [
      'context.capability.loaded',
      'context.capability.invoked',
      'session.heartbeat',
      'config.drift.detected',
      'unknown.x',
    ]) {
      expect(capabilityCatalogResourcesForEvent(type)).toEqual([]);
    }
  });
});
