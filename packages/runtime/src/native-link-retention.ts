import { NATIVE_LINK_TRIM_MAX_PER_CALL } from '@luwi/protocol';

/** A link as retention sees it: enough to decide, and to declare it to Redis. */
export type RetainedNativeLink = {
  id: string;
  sessionId: string;
  unlinkedAt?: string;
};

export type NativeLinkTrimTarget = { id: string; sessionId: string };

/**
 * Which closed links a binding has to give up, oldest first.
 *
 * Two guards keep the open link: its identity, and the absence of `unlinkedAt`
 * on the record. The second is the stronger one — `openLinkId` is a pointer and
 * can be stale, while a link record cannot lie about being closed.
 *
 * `sessionId` travels with the id because the reverse index the trim also has
 * to delete is keyed by session, and a Function may not derive a key name.
 */
export function selectTrimmableNativeLinks(input: {
  openLinkId?: string;
  closedLinkCount: number;
  oldest: readonly RetainedNativeLink[];
  retentionMax: number;
  maxPerCall?: number;
}): NativeLinkTrimTarget[] {
  const excess = input.closedLinkCount - input.retentionMax;
  if (excess <= 0) {
    return [];
  }

  const limit = Math.min(excess, input.maxPerCall ?? NATIVE_LINK_TRIM_MAX_PER_CALL);
  const selected: NativeLinkTrimTarget[] = [];
  const seen = new Set<string>();
  for (const link of input.oldest) {
    if (selected.length >= limit) {
      break;
    }
    if (link.id === input.openLinkId || link.unlinkedAt === undefined || seen.has(link.id)) {
      continue;
    }
    seen.add(link.id);
    selected.push({ id: link.id, sessionId: link.sessionId });
  }
  return selected;
}

export type NativeLinkRetentionState = {
  version: number;
  openLinkId?: string;
  /** Members of the links index, open link included. */
  linkCount: number;
};

export interface NativeLinkRetentionRepository {
  /** The bindings still reachable from the supplied sessions. */
  listBindingIds(sessionIds: readonly string[]): Promise<string[]>;
  getRetentionState(bindingId: string): Promise<NativeLinkRetentionState | null>;
  listOldestLinks(bindingId: string, limit: number): Promise<RetainedNativeLink[]>;
  trimLinks(input: {
    bindingId: string;
    expectedVersion: number;
    links: NativeLinkTrimTarget[];
  }): Promise<'trimmed' | 'conflict'>;
}

export type NativeLinkRetentionSweepResult = {
  bindings: number;
  trimmed: number;
  conflicts: number;
  unchanged: number;
};

export type NativeLinkRetentionSweeperOptions = {
  repository: NativeLinkRetentionRepository;
  retentionMax: number;
  maxPerCall?: number;
};

export interface NativeLinkRetentionSweeper {
  sweepOnce(sessionIds: readonly string[]): Promise<NativeLinkRetentionSweepResult>;
  stop(): void;
}

/**
 * Bounds the closed links a binding retains.
 *
 * One batch per binding per sweep, and a conflict is left alone rather than
 * retried: a conflict means another writer won the compare-and-set, and racing
 * it inside this sweep would spend the batch on one binding while the others
 * keep growing. The overshoot survives to the next pass either way.
 */
class RuntimeNativeLinkRetentionSweeper implements NativeLinkRetentionSweeper {
  readonly #options: NativeLinkRetentionSweeperOptions;
  #stopped = false;

  constructor(options: NativeLinkRetentionSweeperOptions) {
    this.#options = options;
  }

  async sweepOnce(sessionIds: readonly string[]): Promise<NativeLinkRetentionSweepResult> {
    const result: NativeLinkRetentionSweepResult = {
      bindings: 0,
      trimmed: 0,
      conflicts: 0,
      unchanged: 0,
    };
    if (this.#stopped) {
      return result;
    }

    const { repository, retentionMax, maxPerCall } = this.#options;
    const bindingIds = await repository.listBindingIds(sessionIds);
    result.bindings = bindingIds.length;

    for (const bindingId of bindingIds) {
      const state = await repository.getRetentionState(bindingId);
      if (state === null) {
        result.unchanged += 1;
        continue;
      }

      const closedLinkCount = state.linkCount - (state.openLinkId === undefined ? 0 : 1);
      const excess = closedLinkCount - retentionMax;
      if (excess <= 0) {
        result.unchanged += 1;
        continue;
      }

      // One extra covers the single open link, which may sort oldest.
      const want = Math.min(excess, maxPerCall ?? NATIVE_LINK_TRIM_MAX_PER_CALL);
      const oldest = await repository.listOldestLinks(bindingId, want + 1);
      const links = selectTrimmableNativeLinks({
        ...(state.openLinkId === undefined ? {} : { openLinkId: state.openLinkId }),
        closedLinkCount,
        oldest,
        retentionMax,
        ...(maxPerCall === undefined ? {} : { maxPerCall }),
      });
      if (links.length === 0) {
        result.unchanged += 1;
        continue;
      }

      const outcome = await repository.trimLinks({
        bindingId,
        expectedVersion: state.version,
        links,
      });
      if (outcome === 'trimmed') {
        result.trimmed += 1;
      } else {
        result.conflicts += 1;
      }
    }

    return result;
  }

  stop(): void {
    this.#stopped = true;
  }
}

export function createNativeLinkRetentionSweeper(
  options: NativeLinkRetentionSweeperOptions,
): NativeLinkRetentionSweeper {
  return new RuntimeNativeLinkRetentionSweeper(options);
}
