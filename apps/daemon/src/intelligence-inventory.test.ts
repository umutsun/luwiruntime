import type { PackageRecord, TechnologyRecord } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { samePackageInventory } from './intelligence-service.js';

const pkg = (over: Record<string, unknown> = {}): PackageRecord =>
  ({
    id: 'pkg-1',
    projectId: 'proj',
    ecosystem: 'npm',
    packageName: 'x',
    dependencyType: 'production',
    detectedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as PackageRecord;

const tech = (over: Record<string, unknown> = {}): TechnologyRecord =>
  ({
    id: 'tech-1',
    projectId: 'proj',
    name: 'TypeScript',
    category: 'language',
    confidence: 'high',
    evidence: [{ kind: 'manifest', detail: 'package.json' }],
    detectedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as TechnologyRecord;

describe('samePackageInventory', () => {
  it('treats a re-scan of the same packages as unchanged — detectedAt is ignored', () => {
    expect(
      samePackageInventory(
        [pkg()],
        [tech()],
        [pkg({ detectedAt: '2026-06-06T12:00:00.000Z' })],
        [tech({ detectedAt: '2026-06-06T12:00:00.000Z' })],
      ),
    ).toBe(true);
  });

  it('is order-insensitive', () => {
    expect(
      samePackageInventory(
        [pkg({ id: 'a' }), pkg({ id: 'b' })],
        [],
        [pkg({ id: 'b' }), pkg({ id: 'a' })],
        [],
      ),
    ).toBe(true);
  });

  it('detects a changed package version', () => {
    expect(samePackageInventory([pkg()], [], [pkg({ declaredVersion: '2.0.0' })], [])).toBe(false);
  });

  it('detects an added or removed package', () => {
    expect(
      samePackageInventory([pkg({ id: 'a' })], [], [pkg({ id: 'a' }), pkg({ id: 'b' })], []),
    ).toBe(false);
  });

  it('detects a changed technology', () => {
    expect(samePackageInventory([], [tech()], [], [tech({ confidence: 'low' })])).toBe(false);
  });
});
