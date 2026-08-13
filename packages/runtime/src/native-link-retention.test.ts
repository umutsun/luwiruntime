import { describe, expect, it } from 'vitest';

import {
  createNativeLinkRetentionSweeper,
  selectTrimmableNativeLinks,
  type NativeLinkRetentionRepository,
  type NativeLinkTrimTarget,
  type RetainedNativeLink,
} from './native-link-retention.js';

const closed = (id: string): RetainedNativeLink => ({
  id,
  sessionId: `session-${id}`,
  unlinkedAt: '2026-08-12T00:00:00.000Z',
});

describe('selectTrimmableNativeLinks', () => {
  it('selects nothing when the binding sits exactly on the bound', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1000,
        oldest: [closed('a')],
        retentionMax: 1000,
      }),
    ).toEqual([]);
  });

  it('selects exactly the overshoot, oldest first', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1001,
        oldest: [closed('a'), closed('b')],
        retentionMax: 1000,
      }),
    ).toEqual([{ id: 'a', sessionId: 'session-a' }]);
  });

  it('skips the open link even when it is the oldest', () => {
    expect(
      selectTrimmableNativeLinks({
        openLinkId: 'open',
        closedLinkCount: 1001,
        oldest: [{ id: 'open', sessionId: 'session-open' }, closed('a')],
        retentionMax: 1000,
      }),
    ).toEqual([{ id: 'a', sessionId: 'session-a' }]);
  });

  /**
   * `openLinkId` is a pointer and can be stale; the link record itself cannot
   * lie about being closed, so the absence of `unlinkedAt` is the second and
   * stronger guard.
   */
  it('skips any link carrying no unlinkedAt, whatever openLinkId says', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1001,
        oldest: [{ id: 'unclosed', sessionId: 'session-unclosed' }, closed('a')],
        retentionMax: 1000,
      }),
    ).toEqual([{ id: 'a', sessionId: 'session-a' }]);
  });

  it('never selects more than the per-call cap', () => {
    const oldest = Array.from({ length: 40 }, (_, index) => closed(`link-${String(index)}`));

    expect(
      selectTrimmableNativeLinks({ closedLinkCount: 1040, oldest, retentionMax: 1000 }),
    ).toHaveLength(32);
  });

  it('never selects the same link twice', () => {
    expect(
      selectTrimmableNativeLinks({
        closedLinkCount: 1002,
        oldest: [closed('a'), closed('a'), closed('b')],
        retentionMax: 1000,
      }),
    ).toEqual([
      { id: 'a', sessionId: 'session-a' },
      { id: 'b', sessionId: 'session-b' },
    ]);
  });
});

type StubBinding = {
  version: number;
  openLinkId?: string;
  links: RetainedNativeLink[];
};

function harness(config: {
  bindings: Record<string, StubBinding>;
  retentionMax?: number;
  conflictOn?: Set<string>;
}): {
  repository: NativeLinkRetentionRepository;
  trimCalls: { bindingId: string; expectedVersion: number; links: NativeLinkTrimTarget[] }[];
  stateReads: string[];
} {
  const trimCalls: {
    bindingId: string;
    expectedVersion: number;
    links: NativeLinkTrimTarget[];
  }[] = [];
  const stateReads: string[] = [];
  const repository: NativeLinkRetentionRepository = {
    listBindingIds: async () => Object.keys(config.bindings),
    getRetentionState: async (bindingId) => {
      stateReads.push(bindingId);
      const binding = config.bindings[bindingId];
      if (binding === undefined) return null;
      return {
        version: binding.version,
        ...(binding.openLinkId === undefined ? {} : { openLinkId: binding.openLinkId }),
        linkCount: binding.links.length,
      };
    },
    listOldestLinks: async (bindingId, limit) =>
      (config.bindings[bindingId]?.links ?? []).slice(0, limit),
    trimLinks: async (input) => {
      trimCalls.push(input);
      if (config.conflictOn?.has(input.bindingId) === true) {
        return 'conflict';
      }
      const binding = config.bindings[input.bindingId];
      if (binding !== undefined) {
        const removed = new Set(input.links.map((link) => link.id));
        binding.links = binding.links.filter((link) => !removed.has(link.id));
        binding.version += 1;
      }
      return 'trimmed';
    },
  };
  return { repository, trimCalls, stateReads };
}

const closedLinks = (count: number, prefix = 'link'): RetainedNativeLink[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(5, '0')}`,
    sessionId: `session-${String(index).padStart(5, '0')}`,
    unlinkedAt: '2026-08-12T00:00:00.000Z',
  }));

describe('createNativeLinkRetentionSweeper', () => {
  it('trims one bounded batch per binding and leaves the rest to the next sweep', async () => {
    const { repository, trimCalls } = harness({
      bindings: { 'binding-1': { version: 1, links: closedLinks(1064) } },
    });
    const sweeper = createNativeLinkRetentionSweeper({ repository, retentionMax: 1000 });

    const first = await sweeper.sweepOnce(['session-1']);
    const second = await sweeper.sweepOnce(['session-1']);

    expect(first).toEqual({ bindings: 1, trimmed: 1, conflicts: 0, unchanged: 0 });
    expect(second).toEqual({ bindings: 1, trimmed: 1, conflicts: 0, unchanged: 0 });
    expect(trimCalls.map((call) => call.links.length)).toEqual([32, 32]);
    // The second call carries the version the first one produced.
    expect(trimCalls.map((call) => call.expectedVersion)).toEqual([1, 2]);
  });

  /**
   * A conflict means another writer won; retrying inside the same sweep would
   * spend the batch racing one binding instead of serving the rest.
   */
  it('does not retry a conflicted binding inside the same sweep', async () => {
    const { repository, trimCalls } = harness({
      bindings: {
        'binding-1': { version: 1, links: closedLinks(1010, 'a') },
        'binding-2': { version: 1, links: closedLinks(1010, 'b') },
      },
      conflictOn: new Set(['binding-1']),
    });
    const sweeper = createNativeLinkRetentionSweeper({ repository, retentionMax: 1000 });

    const result = await sweeper.sweepOnce(['session-1']);

    expect(result).toEqual({ bindings: 2, trimmed: 1, conflicts: 1, unchanged: 0 });
    expect(trimCalls.filter((call) => call.bindingId === 'binding-1')).toHaveLength(1);
  });

  it('leaves a binding under the bound untouched and reads no links for it', async () => {
    const { repository, trimCalls } = harness({
      bindings: { 'binding-1': { version: 1, links: closedLinks(1000) } },
    });
    const sweeper = createNativeLinkRetentionSweeper({ repository, retentionMax: 1000 });

    const result = await sweeper.sweepOnce(['session-1']);

    expect(result).toEqual({ bindings: 1, trimmed: 0, conflicts: 0, unchanged: 1 });
    expect(trimCalls).toEqual([]);
  });

  it('subtracts the open link from the retained count', async () => {
    const links = closedLinks(1000);
    const open: RetainedNativeLink = { id: 'open', sessionId: 'session-open' };
    const { repository, trimCalls } = harness({
      bindings: { 'binding-1': { version: 1, openLinkId: 'open', links: [open, ...links] } },
    });
    const sweeper = createNativeLinkRetentionSweeper({ repository, retentionMax: 1000 });

    const result = await sweeper.sweepOnce(['session-1']);

    expect(result).toEqual({ bindings: 1, trimmed: 0, conflicts: 0, unchanged: 1 });
    expect(trimCalls).toEqual([]);
  });

  it('never declares the open link even when it is the oldest member', async () => {
    const open: RetainedNativeLink = { id: 'open', sessionId: 'session-open' };
    const { repository, trimCalls } = harness({
      bindings: {
        'binding-1': { version: 1, openLinkId: 'open', links: [open, ...closedLinks(1001)] },
      },
    });
    const sweeper = createNativeLinkRetentionSweeper({ repository, retentionMax: 1000 });

    await sweeper.sweepOnce(['session-1']);

    expect(trimCalls[0]?.links).toEqual([{ id: 'link-00000', sessionId: 'session-00000' }]);
  });

  it('reports a binding that vanished between enumeration and read as unchanged', async () => {
    const { repository, trimCalls } = harness({ bindings: {} });
    const sweeper = createNativeLinkRetentionSweeper({ repository, retentionMax: 1000 });
    const withGhost: NativeLinkRetentionRepository = {
      ...repository,
      listBindingIds: async () => ['binding-gone'],
    };
    const ghostSweeper = createNativeLinkRetentionSweeper({
      repository: withGhost,
      retentionMax: 1000,
    });

    expect(await ghostSweeper.sweepOnce(['session-1'])).toEqual({
      bindings: 1,
      trimmed: 0,
      conflicts: 0,
      unchanged: 1,
    });
    expect(trimCalls).toEqual([]);
    void sweeper;
  });

  it('sweeps nothing after stop', async () => {
    const { repository, trimCalls, stateReads } = harness({
      bindings: { 'binding-1': { version: 1, links: closedLinks(1064) } },
    });
    const sweeper = createNativeLinkRetentionSweeper({ repository, retentionMax: 1000 });

    sweeper.stop();
    const result = await sweeper.sweepOnce(['session-1']);

    expect(result).toEqual({ bindings: 0, trimmed: 0, conflicts: 0, unchanged: 0 });
    expect(stateReads).toEqual([]);
    expect(trimCalls).toEqual([]);
  });
});
