import { describe, expect, it } from 'vitest';

import {
  assertConfigChangeAllowed,
  reconcileOperation,
  transitionConfigOperation,
  transitionConfigPlan,
} from './config-policy.js';

describe('configuration management policy', () => {
  it('enforces one-way plan state transitions and expiry', () => {
    expect(transitionConfigPlan('prepared', 'approved', 100, 200)).toBe('approved');
    expect(() => transitionConfigPlan('prepared', 'applying', 100, 200)).toThrow();
    expect(() => transitionConfigPlan('prepared', 'approved', 201, 200)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_PLAN_EXPIRED' }),
    );
    expect(() => transitionConfigPlan('applied', 'approved', 100, 200)).toThrow();
  });

  it('refuses unmanaged writes and all observed-file writes', () => {
    expect(() =>
      assertConfigChangeAllowed({
        operation: 'update',
        managementMode: 'managed-file',
        currentlyOwned: false,
        explicitlyAdopted: false,
      }),
    ).toThrowError(expect.objectContaining({ code: 'NATIVE_CONFIG_UNMANAGED' }));
    expect(() =>
      assertConfigChangeAllowed({
        operation: 'delete',
        managementMode: 'observed',
        currentlyOwned: true,
        explicitlyAdopted: true,
      }),
    ).toThrow();
  });

  it('records filesystem/Redis split-brain for reconciliation instead of guessing rollback', () => {
    expect(transitionConfigOperation('writing', 'files_committed')).toBe('files_committed');
    expect(transitionConfigOperation('files_committed', 'redis_pending')).toBe('redis_pending');
    expect(
      reconcileOperation({
        state: 'redis_pending',
        expectedHashes: { 'C:/managed.json': 'a'.repeat(64) },
        observedHashes: { 'C:/managed.json': 'a'.repeat(64) },
      }),
    ).toEqual({ action: 'rebuild-redis', nextState: 'completed' });
    expect(
      reconcileOperation({
        state: 'redis_pending',
        expectedHashes: { 'C:/managed.json': 'a'.repeat(64) },
        observedHashes: { 'C:/managed.json': 'b'.repeat(64) },
      }),
    ).toEqual({ action: 'human-review', nextState: 'reconciliation_required' });
  });
});
