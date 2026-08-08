import type {
  ConfigOperationReceipt,
  ConfigOperationState,
  ConfigPlanState,
  ManagementMode,
} from './phase3-types.js';

import { ApplicationError } from './application-error.js';

const planTransitions: Readonly<Record<ConfigPlanState, readonly ConfigPlanState[]>> = {
  prepared: ['approved', 'expired', 'superseded'],
  approved: ['applying', 'expired', 'superseded'],
  applying: ['applied', 'failed'],
  applied: [],
  failed: [],
  expired: [],
  superseded: [],
};

export function transitionConfigPlan(
  current: ConfigPlanState,
  target: ConfigPlanState,
  nowMs: number,
  expiresAtMs: number,
): ConfigPlanState {
  if (nowMs > expiresAtMs && current !== 'applied') {
    throw new ApplicationError('CONFIG_PLAN_EXPIRED', 'The configuration plan has expired.', 409);
  }
  if (!(planTransitions[current] ?? []).includes(target)) {
    throw new ApplicationError(
      'CONFIG_PLAN_SUPERSEDED',
      'The configuration plan transition is not allowed.',
      409,
    );
  }
  return target;
}

export function assertConfigChangeAllowed(input: {
  operation: 'create' | 'update' | 'delete';
  managementMode: ManagementMode;
  currentlyOwned: boolean;
  explicitlyAdopted: boolean;
}): void {
  if (input.managementMode === 'observed') {
    throw new ApplicationError(
      'NATIVE_CONFIG_UNMANAGED',
      'Observed native configuration cannot be changed.',
      409,
    );
  }
  if (input.operation !== 'create' && !input.currentlyOwned && !input.explicitlyAdopted) {
    throw new ApplicationError(
      'NATIVE_CONFIG_UNMANAGED',
      'The native configuration file is not managed by LUWI.',
      409,
    );
  }
}

const operationTransitions: Readonly<
  Record<ConfigOperationState, readonly ConfigOperationState[]>
> = {
  prepared: ['snapshotted', 'failed'],
  snapshotted: ['writing', 'failed'],
  writing: ['files_committed', 'failed'],
  files_committed: ['redis_pending', 'completed', 'reconciliation_required'],
  redis_pending: ['completed', 'reconciliation_required'],
  completed: ['rolled_back'],
  failed: [],
  reconciliation_required: ['completed', 'rolled_back'],
  rolled_back: [],
};

export function transitionConfigOperation(
  current: ConfigOperationState,
  target: ConfigOperationState,
): ConfigOperationState {
  if (!(operationTransitions[current] ?? []).includes(target)) {
    throw new ApplicationError(
      'CONFIG_APPLY_FAILED',
      'The configuration operation transition is not allowed.',
      409,
    );
  }
  return target;
}

export function reconcileOperation(input: {
  state: ConfigOperationReceipt['state'];
  expectedHashes: Record<string, string | null>;
  observedHashes: Record<string, string | null>;
}):
  | { action: 'rebuild-redis'; nextState: 'completed' }
  | { action: 'human-review'; nextState: 'reconciliation_required' } {
  const paths = [
    ...new Set([...Object.keys(input.expectedHashes), ...Object.keys(input.observedHashes)]),
  ];
  const matches = paths.every(
    (path) => (input.expectedHashes[path] ?? null) === (input.observedHashes[path] ?? null),
  );
  return matches
    ? { action: 'rebuild-redis', nextState: 'completed' }
    : { action: 'human-review', nextState: 'reconciliation_required' };
}
