/**
 * Display formatting shared by more than one view.
 *
 * `abbreviatePath` keeps the head and tail of a long local path so both the
 * root and the leaf stay readable. Callers must also set the full value as an
 * accessible `title`, per the mockup audit's requirement that long paths use
 * middle abbreviation plus an accessible full value.
 */

const MAX_PATH_LENGTH = 42;
const HEAD_LENGTH = 18;
const TAIL_LENGTH = 20;

export function abbreviatePath(path: string): string {
  if (path.length <= MAX_PATH_LENGTH) return path;
  return `${path.slice(0, HEAD_LENGTH)}…${path.slice(-TAIL_LENGTH)}`;
}

/** Short, stable commit display. Full SHA stays available as a title. */
export function abbreviateSha(sha: string): string {
  return sha.slice(0, 12);
}

const MAX_ID_LENGTH = 12;

/**
 * Short, stable identifier display. The first UUID group is enough to tell rows
 * apart within one table; callers must keep the full value as an accessible
 * `title`, exactly as `abbreviatePath` requires.
 */
export function abbreviateId(id: string): string {
  if (id.length <= MAX_ID_LENGTH) return id;
  const firstGroup = id.split('-', 1)[0];
  if (firstGroup !== undefined && firstGroup.length > 0 && firstGroup.length <= MAX_ID_LENGTH) {
    return firstGroup;
  }
  return `${id.slice(0, MAX_ID_LENGTH)}…`;
}

/**
 * Two letters for an identity tile.
 *
 * The design system draws a monogram beside every project and agent. It is a
 * label, not a claim: it is derived from the display name the runtime already
 * holds, and it never encodes which product an agent is — there is no vendor
 * map here and `product-independence.test.ts` exists to keep it that way.
 */
export function monogramInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
  if (words.length === 0) return '??';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase();
  return `${(words[0] ?? '').slice(0, 1)}${(words[1] ?? '').slice(0, 1)}`.toUpperCase();
}

/**
 * A stable palette slot for an identifier.
 *
 * FNV-1a, because it mixes position: registries here are far more often
 * sequential (`project-1`, `project-2`) than random, and a sum-of-characters
 * hash would give a whole registry one colour. The colour carries no meaning
 * on its own — it only makes one row's tile distinguishable from the next.
 */
export function paletteIndex(id: string, size: number): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return Math.abs(hash) % size;
}

/**
 * Relative display for an observed timestamp. Callers keep the absolute value
 * as a `title`/`dateTime`. Skew into the future reads as "just now" — claiming
 * a negative age would be a statement the runtime never observed — and an
 * unparseable value is reported as such rather than silently formatted.
 */
export function formatRelativeTime(isoTimestamp: string, nowMs: number): string {
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed) || !Number.isFinite(nowMs)) return 'unavailable';
  const elapsedMs = Math.max(0, nowMs - parsed);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}
