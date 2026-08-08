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
