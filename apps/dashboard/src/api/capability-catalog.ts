import {
  capabilityCollectionSchema,
  capabilityProfileCollectionSchema,
} from '@luwi/protocol/browser';

import type { ResourceState } from '../components/panel.js';
import type { DaemonClient } from './client.js';

/**
 * The capability and profile catalogue, read-only.
 *
 * ADR 0008 makes capabilities scope-aware and profiles the way several of them
 * are named at once, and every project-agent pair on the Projects route already
 * renders the resolved subset. What no surface showed was the inventory itself:
 * which packages the runtime knows, where each came from, which agent kinds it
 * fits, and which profiles name it. A capability bound to nothing was invisible.
 *
 * Loaded only while `#/capabilities` is open, matching the rule the message and
 * intelligence scopes already follow.
 *
 * Nothing here registers, enables, assigns, or scans. The daemon serves those
 * endpoints and AGENTS.md section 21 keeps them off every read surface.
 */

const PAGE_SIZE = 100;

export type CapabilityKind =
  'skill' | 'plugin' | 'hook' | 'mcp' | 'policy' | 'profile' | 'instruction';

export type CapabilityScope = 'global' | 'project';

export type CatalogCapability = {
  id: string;
  kind: CapabilityKind;
  name: string;
  version?: string;
  scope: CapabilityScope;
  projectId?: string;
  source: string;
  path?: string;
  checksum: string;
  compatibleAgentKinds: string[];
  requiredCapabilityIds: string[];
  requiredMcpIds: string[];
  enabled: boolean;
};

export type CatalogProfile = {
  id: string;
  name: string;
  scope: CapabilityScope;
  projectId?: string;
  capabilityIds: string[];
  policyIds: string[];
  disabledCapabilityIds: string[];
  /**
   * Only the keys. Adapter settings are free-form JSON that can carry native
   * agent configuration, and the catalogue's job is to say which knobs a
   * profile sets, not to reprint their values on a screen.
   */
  adapterSettingKeys: string[];
};

export type Bounded<T> = { items: T[]; truncated: boolean };

export type CapabilityCatalogResources = {
  capabilities: ResourceState<Bounded<CatalogCapability>>;
  profiles: ResourceState<CatalogProfile[]>;
};

export type CapabilityCatalogResourceKey = keyof CapabilityCatalogResources;

export const capabilityCatalogResourceKeys: readonly CapabilityCatalogResourceKey[] = [
  'capabilities',
  'profiles',
];

/**
 * Maps a runtime event type to the catalogue panels it invalidates.
 *
 * The match is exact rather than by prefix on purpose: `context.capability.*`
 * records an agent loading a skill, which changes the context reads and not one
 * row of this inventory.
 */
const CAPABILITY_EVENTS = new Set([
  'capability.registered',
  'capability.updated',
  'capability.disabled',
  'capability.assigned',
  'capability.unassigned',
]);
const PROFILE_EVENTS = new Set(['profile.registered', 'profile.updated', 'profile.assigned']);

export function capabilityCatalogResourcesForEvent(
  eventType: string,
): CapabilityCatalogResourceKey[] {
  if (eventType.startsWith('runtime.')) return [...capabilityCatalogResourceKeys];
  if (CAPABILITY_EVENTS.has(eventType)) return ['capabilities'];
  if (PROFILE_EVENTS.has(eventType)) return ['profiles'];
  return [];
}

export async function loadCapabilityCatalog(
  client: DaemonClient,
  keys: readonly CapabilityCatalogResourceKey[],
  options: { signal?: AbortSignal } = {},
): Promise<Partial<CapabilityCatalogResources>> {
  const get = options.signal === undefined ? {} : { signal: options.signal };
  const result: Partial<CapabilityCatalogResources> = {};

  if (keys.includes('capabilities')) {
    /**
     * No over-read here, unlike the message list: this collection carries a
     * `truncated` flag and the daemon now computes it from its own over-read
     * rather than hardcoding `false`. Deriving a second one would only be able
     * to disagree with it.
     */
    const response = await client.get(
      `/api/v1/capabilities?limit=${String(PAGE_SIZE)}`,
      capabilityCollectionSchema,
      get,
    );
    result.capabilities =
      response.state === 'ready'
        ? {
            state: 'ready',
            data: {
              items: response.data.capabilities.map((entry) => ({
                id: entry.id,
                kind: entry.kind,
                name: entry.name,
                ...(entry.version === undefined ? {} : { version: entry.version }),
                scope: entry.scope,
                ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
                source: entry.source,
                ...(entry.path === undefined ? {} : { path: entry.path }),
                checksum: entry.checksum,
                compatibleAgentKinds: [...entry.compatibleAgentKinds],
                requiredCapabilityIds: [...entry.requiredCapabilityIds],
                requiredMcpIds: [...entry.requiredMcpIds],
                enabled: entry.enabled,
              })),
              truncated: response.data.truncated,
            },
          }
        : { state: 'unavailable' };
  }

  if (keys.includes('profiles')) {
    const response = await client.get('/api/v1/profiles', capabilityProfileCollectionSchema, get);
    result.profiles =
      response.state === 'ready'
        ? {
            state: 'ready',
            data: response.data.profiles.map((entry) => ({
              id: entry.id,
              name: entry.name,
              scope: entry.scope,
              ...(entry.projectId === undefined ? {} : { projectId: entry.projectId }),
              capabilityIds: [...entry.capabilityIds],
              policyIds: [...entry.policyIds],
              disabledCapabilityIds: [...entry.disabledCapabilityIds],
              adapterSettingKeys: Object.keys(entry.adapterSettings).sort(),
            })),
          }
        : { state: 'unavailable' };
  }

  return result;
}

/**
 * Why a profile's capability reference does or does not have a name.
 *
 * `beyond-page` and `absent` look identical on screen if collapsed, and they
 * are opposite facts: one is a bound this view imposed, the other is a profile
 * naming a package the runtime does not have.
 */
export type CapabilityResolution = 'resolved' | 'beyond-page' | 'absent' | 'unavailable';

export type ResolvedProfileCapability = {
  id: string;
  resolution: CapabilityResolution;
  name?: string;
  kind?: CapabilityKind;
  enabled?: boolean;
  disabledByProfile?: boolean;
};

export function resolveProfileCapabilities(
  profile: CatalogProfile,
  catalogue: Bounded<CatalogCapability> | undefined,
): ResolvedProfileCapability[] {
  return profile.capabilityIds.map((capabilityId) => {
    if (catalogue === undefined) return { id: capabilityId, resolution: 'unavailable' as const };
    const match = catalogue.items.find((entry) => entry.id === capabilityId);
    if (match === undefined) {
      return {
        id: capabilityId,
        resolution: catalogue.truncated ? ('beyond-page' as const) : ('absent' as const),
      };
    }
    return {
      id: capabilityId,
      resolution: 'resolved' as const,
      name: match.name,
      kind: match.kind,
      enabled: match.enabled,
      disabledByProfile: profile.disabledCapabilityIds.includes(capabilityId),
    };
  });
}

/** The profiles naming a capability, and whether each of them turns it off. */
export function profilesUsing(
  capabilityId: string,
  profiles: readonly CatalogProfile[],
): { id: string; name: string; disabled: boolean }[] {
  return profiles
    .filter((profile) => profile.capabilityIds.includes(capabilityId))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      disabled: profile.disabledCapabilityIds.includes(capabilityId),
    }));
}
