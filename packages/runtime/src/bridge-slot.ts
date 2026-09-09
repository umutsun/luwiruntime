import { createHash } from 'node:crypto';

import type {
  BridgeExecutionProfile,
  BridgeProvider,
  BridgeSlotState,
  SessionStatus,
} from '@luwi/protocol';

const SEPARATOR = String.fromCharCode(0);
const CODEX_NATIVE_ADAPTER = 'codex-native-v1';
const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type BridgeSlotIdentity = {
  workspaceId: string;
  projectId: string;
  agentId: string;
};

export type ProviderProfileObservation = {
  provider: string;
  executionProfile: string;
  agent: {
    kind: string;
    enabled: boolean;
  };
  effectiveConfiguration: {
    valid: boolean;
  };
  sourceSession: {
    id: string;
    status: SessionStatus;
    presence: 'online' | 'offline';
    mcpSessionId: string;
    hostWake?: {
      adapter: string;
      mcpSessionId: string;
    };
  };
  nativeBinding: {
    adapterId: string;
    kind: 'main' | 'subagent';
    conflicted: boolean;
    trimmedLinkCount: number;
    openLink?: {
      sessionId: string;
    };
    identityProvenance?: {
      source: 'host_launcher' | 'filesystem_heuristic';
      launcherInstanceId?: string;
    };
  };
};

export type ProviderProfileRefusalReason =
  | 'provider_unsupported'
  | 'profile_unsupported'
  | 'agent_kind_mismatch'
  | 'agent_disabled'
  | 'effective_config_invalid'
  | 'source_session_not_live'
  | 'source_session_offline'
  | 'evidence_invalid'
  | 'native_binding_trimmed'
  | 'native_binding_conflict'
  | 'native_binding_stale'
  | 'native_subagent'
  | 'native_adapter_mismatch'
  | 'identity_untrusted'
  | 'adapter_mismatch'
  | 'mcp_session_mismatch';

export type ProviderProfileEvaluation =
  | {
      eligible: true;
      mode: 'automatic';
      provider: BridgeProvider;
      executionProfile: BridgeExecutionProfile;
    }
  | {
      eligible: false;
      mode: 'inbox_only';
      reasonCode: ProviderProfileRefusalReason;
    };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !value.includes(SEPARATOR) &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isValidProviderEvidence(observation: ProviderProfileObservation): boolean {
  const { nativeBinding, sourceSession } = observation;
  const hostWake = sourceSession.hostWake;

  return (
    isValidIdentifier(sourceSession.id) &&
    isValidIdentifier(sourceSession.mcpSessionId) &&
    isValidIdentifier(nativeBinding.adapterId) &&
    nativeBinding.openLink !== undefined &&
    isValidIdentifier(nativeBinding.openLink.sessionId) &&
    Number.isSafeInteger(nativeBinding.trimmedLinkCount) &&
    nativeBinding.trimmedLinkCount >= 0 &&
    typeof nativeBinding.conflicted === 'boolean' &&
    (hostWake === undefined ||
      (isValidIdentifier(hostWake.adapter) && isValidIdentifier(hostWake.mcpSessionId)))
  );
}

function assertValidBridgeSlotIdentity(identity: BridgeSlotIdentity): void {
  if (
    !isValidIdentifier(identity.workspaceId) ||
    !isValidIdentifier(identity.projectId) ||
    !isValidIdentifier(identity.agentId)
  ) {
    throw new RangeError('Bridge slot identity is invalid.');
  }
}

/**
 * Derives the singleton bridge ownership key for a workspace/project/agent tuple.
 * Provider is intentionally absent: providers contend for the same agent slot.
 */
export function deriveBridgeSlotId(identity: BridgeSlotIdentity): string {
  assertValidBridgeSlotIdentity(identity);
  return sha256([identity.workspaceId, identity.projectId, identity.agentId].join(SEPARATOR));
}

/** Slot state changes that can be represented by the durable owner projection. */
export function canTransitionBridgeSlot(from: BridgeSlotState, to: BridgeSlotState): boolean {
  switch (from) {
    case 'active':
      return to === 'standby' || to === 'degraded' || to === 'expired';
    case 'standby':
      return to === 'active' || to === 'degraded';
    case 'degraded':
      return to === 'active' || to === 'expired';
    case 'expired':
      return to === 'active';
  }
}

function isLive(status: SessionStatus): boolean {
  return status !== 'completed' && status !== 'disconnected';
}

/**
 * Accepts only the fixed, trusted Codex queue profile. Every other observation
 * remains deliverable through the durable inbox with a public bounded reason.
 */
export function evaluateProviderProfile(
  observation: ProviderProfileObservation,
): ProviderProfileEvaluation {
  if (observation.provider !== 'codex') {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'provider_unsupported' };
  }
  if (
    observation.executionProfile !== 'read-only' &&
    observation.executionProfile !== 'workspace-write'
  ) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'profile_unsupported' };
  }
  if (observation.agent.kind !== 'codex') {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'agent_kind_mismatch' };
  }
  if (!observation.agent.enabled) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'agent_disabled' };
  }
  if (!observation.effectiveConfiguration.valid) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'effective_config_invalid' };
  }
  if (!isValidProviderEvidence(observation)) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'evidence_invalid' };
  }
  if (!isLive(observation.sourceSession.status)) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'source_session_not_live' };
  }
  if (observation.sourceSession.presence !== 'online') {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'source_session_offline' };
  }
  if (observation.nativeBinding.trimmedLinkCount > 0) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'native_binding_trimmed' };
  }
  if (observation.nativeBinding.conflicted) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'native_binding_conflict' };
  }
  if (observation.nativeBinding.openLink?.sessionId !== observation.sourceSession.id) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'native_binding_stale' };
  }
  if (observation.nativeBinding.kind !== 'main') {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'native_subagent' };
  }
  if (observation.nativeBinding.adapterId !== CODEX_NATIVE_ADAPTER) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'native_adapter_mismatch' };
  }
  const provenance = observation.nativeBinding.identityProvenance;
  if (
    provenance?.source !== 'host_launcher' ||
    provenance.launcherInstanceId === undefined ||
    !isValidIdentifier(provenance.launcherInstanceId)
  ) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'identity_untrusted' };
  }
  if (observation.sourceSession.hostWake?.adapter !== 'codex-queue-v1') {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'adapter_mismatch' };
  }
  if (observation.sourceSession.hostWake.mcpSessionId !== observation.sourceSession.mcpSessionId) {
    return { eligible: false, mode: 'inbox_only', reasonCode: 'mcp_session_mismatch' };
  }

  return {
    eligible: true,
    mode: 'automatic',
    provider: 'codex',
    executionProfile: observation.executionProfile,
  };
}
