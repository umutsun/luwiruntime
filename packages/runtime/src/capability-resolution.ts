import {
  effectiveAgentConfigurationSchema,
  type AdapterSupportLevel,
  type AgentKind,
  type CapabilityKind,
  type CapabilityPackage,
  type CapabilityProfile,
  type ConfigProvenance,
  type ContextFootprint,
  type EffectiveAgentConfiguration,
} from '@luwi/protocol';

type SourceScope = ConfigProvenance['sourceScope'];

export type CapabilityLayer = {
  precedence: number;
  sourceScope: SourceScope;
  sourceId?: string;
  sourceFile?: string;
  profileIds?: string[];
  capabilities: Array<{ capabilityId: string; enabled: boolean }>;
  settings: Record<string, unknown>;
};

export type CompileEffectiveConfigurationInput = {
  projectId: string;
  agentId: string;
  agentKind: AgentKind;
  catalog: CapabilityPackage[];
  profiles: CapabilityProfile[];
  layers: CapabilityLayer[];
  footprint: ContextFootprint;
  unsupportedCapabilityKinds?: CapabilityKind[];
  adapterCapabilitySupport?: Partial<Record<CapabilityKind, AdapterSupportLevel>>;
  policyMode?: 'enforced-native' | 'rendered-instruction' | 'informational-only' | 'unsupported';
};

type CapabilityDecision = {
  enabled: boolean;
  layer: CapabilityLayer;
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  layer: CapabilityLayer,
  provenance: ConfigProvenance[],
  prefix = 'settings',
): void {
  for (const key of Object.keys(source).toSorted()) {
    const value = source[key];
    const path = `${prefix}.${key}`;
    if (isRecord(value)) {
      const current = isRecord(target[key]) ? target[key] : {};
      target[key] = current;
      mergeSettings(current, value, layer, provenance, path);
      continue;
    }
    target[key] = value;
    const previous = provenance.findIndex(({ key: existingKey }) => existingKey === path);
    if (previous >= 0) provenance.splice(previous, 1);
    provenance.push({
      key: path,
      sourceScope: layer.sourceScope,
      ...(layer.sourceId === undefined ? {} : { sourceId: layer.sourceId }),
      ...(layer.sourceFile === undefined ? {} : { sourceFile: layer.sourceFile }),
      precedence: layer.precedence,
      overrideReason: 'Higher-precedence setting',
    });
  }
}

function orderedLayers(layers: CapabilityLayer[]): CapabilityLayer[] {
  return [...layers].sort(
    (left, right) =>
      left.precedence - right.precedence ||
      (left.sourceId ?? '').localeCompare(right.sourceId ?? '') ||
      (left.sourceFile ?? '').localeCompare(right.sourceFile ?? ''),
  );
}

export function compileEffectiveConfiguration(
  input: CompileEffectiveConfigurationInput,
): EffectiveAgentConfiguration {
  const conflicts: EffectiveAgentConfiguration['conflicts'] = [];
  const catalogById = new Map<string, CapabilityPackage[]>();
  for (const item of input.catalog) {
    const entries = catalogById.get(item.id) ?? [];
    entries.push(item);
    catalogById.set(item.id, entries);
  }
  for (const [id, entries] of catalogById) {
    const versions = new Set(entries.map(({ version }) => version ?? 'unversioned'));
    if (versions.size > 1) {
      conflicts.push({
        code: 'CAPABILITY_CONFLICT',
        message: 'Multiple capability versions are registered for one stable ID.',
        capabilityId: id,
      });
    }
  }

  const profilesById = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const decisions = new Map<string, CapabilityDecision>();
  const settings: Record<string, unknown> = {};
  const provenance: ConfigProvenance[] = [];
  const contributedProfiles = new Set<string>();

  for (const layer of orderedLayers(input.layers)) {
    mergeSettings(settings, layer.settings, layer, provenance);
    const assignments = [...layer.capabilities];
    for (const profileId of [...(layer.profileIds ?? [])].toSorted()) {
      const profile = profilesById.get(profileId);
      if (profile === undefined) {
        conflicts.push({
          code: 'PROFILE_CONFLICT',
          message: 'An assigned profile is not registered.',
          relatedCapabilityId: profileId,
        });
        continue;
      }
      contributedProfiles.add(profileId);
      assignments.push(
        ...profile.capabilityIds.map((capabilityId) => ({ capabilityId, enabled: true })),
        ...profile.policyIds.map((capabilityId) => ({ capabilityId, enabled: true })),
        ...profile.disabledCapabilityIds.map((capabilityId) => ({
          capabilityId,
          enabled: false,
        })),
      );
      mergeSettings(settings, profile.adapterSettings, layer, provenance);
    }
    for (const assignment of assignments.sort((left, right) =>
      left.capabilityId.localeCompare(right.capabilityId),
    )) {
      decisions.set(assignment.capabilityId, {
        enabled: assignment.enabled,
        layer,
        reason: assignment.enabled
          ? 'Higher-precedence capability assignment'
          : 'Explicit disable tombstone',
      });
    }
  }

  for (const [capabilityId, decision] of [...decisions].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    provenance.push({
      key: `capability.${capabilityId}`,
      sourceScope: decision.layer.sourceScope,
      ...(decision.layer.sourceId === undefined ? {} : { sourceId: decision.layer.sourceId }),
      ...(decision.layer.sourceFile === undefined ? {} : { sourceFile: decision.layer.sourceFile }),
      precedence: decision.layer.precedence,
      overrideReason: decision.reason,
    });
  }

  const enabledIds = new Set(
    [...decisions].filter(([, decision]) => decision.enabled).map(([capabilityId]) => capabilityId),
  );
  const selected: CapabilityPackage[] = [];
  const missingDependencies = new Set<string>();
  const unsupported = new Set<string>();
  const unsupportedCapabilityKinds = new Set(input.unsupportedCapabilityKinds ?? []);
  const availableIds = new Set<string>();
  for (const capabilityId of [...enabledIds].toSorted()) {
    const entries = catalogById.get(capabilityId);
    if (entries === undefined || entries.length === 0) {
      missingDependencies.add(capabilityId);
      conflicts.push({
        code: 'CAPABILITY_DEPENDENCY_MISSING',
        message: 'An assigned capability is not registered.',
        relatedCapabilityId: capabilityId,
      });
      continue;
    }
    const capability = [...entries].sort(
      (left, right) =>
        (left.version ?? '').localeCompare(right.version ?? '') ||
        left.checksum.localeCompare(right.checksum),
    )[0];
    if (capability === undefined) {
      continue;
    }
    if (!capability.enabled) {
      unsupported.add(capability.id);
      conflicts.push({
        code: 'CAPABILITY_CONFLICT',
        message: 'An assigned capability package is disabled.',
        capabilityId: capability.id,
      });
      continue;
    }
    selected.push(capability);
    availableIds.add(capability.id);
    const incompatibleAgentKind =
      capability.compatibleAgentKinds.length > 0 &&
      !capability.compatibleAgentKinds.includes(input.agentKind);
    const unsupportedByAdapter = unsupportedCapabilityKinds.has(capability.kind);
    if (incompatibleAgentKind || unsupportedByAdapter) {
      unsupported.add(capability.id);
      conflicts.push({
        code: 'CAPABILITY_INCOMPATIBLE',
        message: unsupportedByAdapter
          ? 'The selected native adapter does not support this capability kind.'
          : 'The capability is incompatible with the selected agent kind.',
        capabilityId: capability.id,
      });
    }
  }
  for (const capability of selected) {
    for (const dependency of [
      ...capability.requiredCapabilityIds,
      ...capability.requiredMcpIds,
    ].toSorted()) {
      if (!availableIds.has(dependency)) {
        missingDependencies.add(dependency);
        conflicts.push({
          code: 'CAPABILITY_DEPENDENCY_MISSING',
          message: 'A required capability is missing.',
          capabilityId: capability.id,
          relatedCapabilityId: dependency,
        });
      }
    }
  }

  return effectiveAgentConfigurationSchema.parse({
    projectId: input.projectId,
    agentId: input.agentId,
    agentKind: input.agentKind,
    valid: conflicts.length === 0,
    capabilities: selected.toSorted((left, right) => left.id.localeCompare(right.id)),
    profileIds: [...contributedProfiles].toSorted(),
    settings,
    provenance,
    conflicts: conflicts.toSorted(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        (left.capabilityId ?? '').localeCompare(right.capabilityId ?? '') ||
        (left.relatedCapabilityId ?? '').localeCompare(right.relatedCapabilityId ?? ''),
    ),
    missingDependencies: [...missingDependencies].toSorted(),
    unsupportedCapabilities: [...unsupported].toSorted(),
    nativeCapabilitySupport:
      input.adapterCapabilitySupport === undefined
        ? []
        : selected
            .map((capability) => ({
              capabilityId: capability.id,
              capabilityKind: capability.kind,
              supportLevel: input.adapterCapabilitySupport?.[capability.kind] ?? 'unsupported',
              ...(capability.kind === 'policy' && input.policyMode !== undefined
                ? { policyMode: input.policyMode }
                : {}),
            }))
            .toSorted((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
    estimatedContextFootprint: input.footprint,
  });
}
