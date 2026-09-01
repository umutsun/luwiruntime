import { nativeSessionRefSchema, type AgentKind, type NativeSessionRef } from '@luwi/protocol';

import { NodeTranscriptFileSystem } from './node-collaborators.js';
import type { TranscriptFileSystem } from './types.js';

/**
 * Filesystem-backed native-identity resolution — the strict fallback to the pure
 * environment resolver in `native-identity.ts`.
 *
 * Some vendors keep their session id only on disk. Codex is the measured case
 * (2026-09-01, `docs/superpowers/specs/2026-09-01-codex-gemini-identity-measurement.md`):
 * the id lives in a rollout file and no environment variable exposes it when Codex
 * is launched by Codex Desktop or the VSCode extension. With the owner's approval
 * (2026-09-01, ADR 0028) this recovers it from the rollout tree.
 *
 * The design keeps the environment resolver's "never bind a guess" rule as strong
 * as the evidence allows, so a wrong binding — which would attribute one session's
 * tokens to another — stays impossible in every case but a genuinely ambiguous
 * one:
 *
 * - **Environment wins.** This runs only when the pure resolver returned nothing,
 *   so a Codex build that ever exports `CODEX_SESSION_ID` is resolved by the
 *   deterministic path and never reaches disk.
 * - **cwd must match.** A rollout is a candidate only if its recorded `cwd` equals
 *   the attaching session's working directory (normalized, case-insensitive on
 *   Windows). A Codex session in another project is never bound to this one.
 * - **Freshness gates it.** A rollout whose file has not been written within the
 *   freshness window is treated as not-the-current-session and skipped, so an
 *   attach in a directory where Codex ran yesterday binds nothing rather than a
 *   dead session.
 * - **The logical session id, not the file.** A resumed Codex session writes a new
 *   rollout file whose own `id` differs from `session_id`; the binding takes
 *   `session_id`, the stable root of the resume chain.
 *
 * The residual, owner-accepted risk is two live Codex sessions sharing one working
 * directory: "freshest" then names one of them. That is the only case the
 * environment resolver's rule is relaxed for, and it is bounded to it.
 */

export type DiskNativeIdentityContext = {
  /** Injected so a test does not resolve merely because the host runs Codex. */
  environment: Readonly<Record<string, string | undefined>>;
  /** The attaching session's working directory — matched against the rollout cwd. */
  workingDirectory: string;
  platform?: NodeJS.Platform;
  fileSystem?: TranscriptFileSystem;
  now?: () => Date;
};

type DiskNativeIdentityResolver = (
  context: DiskNativeIdentityContext,
) => Promise<NativeSessionRef | undefined>;

/** A rollout untouched for this long is not the current session. Env-overridable. */
const DEFAULT_CODEX_FRESHNESS_MS = 900_000;
const CODEX_FRESHNESS_ENV = 'LUWI_CODEX_SESSION_FRESHNESS_MS';
/**
 * A file dated more than this far in the future is not trusted as the current
 * session. Its mtime cannot pass the freshness gate honestly; a backup restore or
 * a timestamp-preserving copy from a clock-ahead machine can leave a **dead**
 * session's file dated well ahead of now, and skipping it keeps that ghost from
 * being admitted as fresh or winning the freshest-sort.
 *
 * The tolerance is small on purpose. A file cannot be distinguished from clock
 * jitter within it, so it is the width of the only window where a future-dated
 * ghost could still outrank a live session — kept to a couple of seconds (benign
 * filesystem/clock granularity) rather than a minute. A clock step-back larger than
 * this rejects the ghost **and** any concurrently-written live file, which is the
 * safe outcome (an honest absence, resolved correctly on the next attach) rather
 * than a wrong binding; a step-back smaller than this falls under the same accepted
 * residual as two live sessions sharing one working directory.
 */
const CODEX_FUTURE_TOLERANCE_MS = 2_000;
/**
 * A runaway guard on how many day directories the scan will enumerate, not a
 * correctness bound: a rollout's `YYYY/MM/DD` directory is fixed at creation, but
 * the freshness gate reads its mtime, so a session open across several days keeps
 * one file in an older directory with a current mtime. The scan therefore cannot
 * stop at "today and yesterday" without missing a genuinely live session; it walks
 * day directories newest-first and lets freshness (on mtime) be the real bound,
 * capping enumeration at roughly one year so an unbounded tree can never stall an
 * attach.
 */
const MAX_CODEX_DAY_DIRECTORIES = 366;
/** One measured `session_meta` line reached ~46 KB (base instructions inline). */
const SESSION_META_MAX_BYTES = 262_144;
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/u;

function usable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Joins path segments with a single forward slash. Forward slashes address the
 * filesystem on Windows too, and keeping one separator makes the in-memory
 * filesystem a test uses addressable without mirroring the host's separator.
 */
function joinPath(...segments: string[]): string {
  return segments
    .map((segment, index) => {
      const forward = segment.replace(/\\/gu, '/').replace(/\/+$/u, '');
      // The first segment keeps its leading slash, so an absolute POSIX root
      // (`/home/dev`) does not silently become a relative path.
      return index === 0 ? forward : forward.replace(/^\/+/u, '');
    })
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * Normalizes a path for equality only. Windows filesystems are case-insensitive
 * and the rollout `cwd` and the attach cwd routinely differ by drive-letter case
 * and separator on this machine.
 */
function normalizeForCompare(path: string, platform: NodeJS.Platform): string {
  const forward = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return platform === 'win32' ? forward.toLowerCase() : forward;
}

function codexSessionsRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const codexHome = usable(environment['CODEX_HOME']);
  if (codexHome !== undefined) return joinPath(codexHome, 'sessions');
  const home = usable(environment['USERPROFILE']) ?? usable(environment['HOME']);
  return home === undefined ? undefined : joinPath(home, '.codex', 'sessions');
}

function codexFreshnessMs(environment: Readonly<Record<string, string | undefined>>): number {
  const raw = usable(environment[CODEX_FRESHNESS_ENV]);
  if (raw === undefined) return DEFAULT_CODEX_FRESHNESS_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_FRESHNESS_MS;
}

async function listNumericDirectories(
  fileSystem: TranscriptFileSystem,
  path: string,
  digits: number,
): Promise<string[]> {
  const entries = await fileSystem.listDirectory(path);
  if (entries === undefined) return [];
  const pattern = new RegExp(`^\\d{${digits}}$`, 'u');
  return entries
    .filter((entry) => entry.isDirectory && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/**
 * The newest calendar-day directories under `sessions/YYYY/MM/DD`, newest first,
 * bounded so the scan stays cheap regardless of how many sessions have accrued.
 */
async function newestDayDirectories(
  fileSystem: TranscriptFileSystem,
  root: string,
): Promise<string[]> {
  const dayDirectories: string[] = [];
  for (const year of await listNumericDirectories(fileSystem, root, 4)) {
    const yearPath = joinPath(root, year);
    for (const month of await listNumericDirectories(fileSystem, yearPath, 2)) {
      const monthPath = joinPath(yearPath, month);
      for (const day of await listNumericDirectories(fileSystem, monthPath, 2)) {
        dayDirectories.push(joinPath(monthPath, day));
        if (dayDirectories.length >= MAX_CODEX_DAY_DIRECTORIES) return dayDirectories;
      }
    }
  }
  return dayDirectories;
}

function parseSessionMeta(line: string): { sessionId: string; cwd: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['type'] !== 'session_meta') return undefined;
  const payload = record['payload'];
  if (typeof payload !== 'object' || payload === null) return undefined;
  const fields = payload as Record<string, unknown>;
  // `session_id` is the logical root, stable across a resume chain; the file's own
  // `id` is per-rollout and is deliberately not read here.
  const sessionId = fields['session_id'];
  const cwd = fields['cwd'];
  if (typeof sessionId !== 'string' || typeof cwd !== 'string') return undefined;
  return { sessionId, cwd };
}

function codexRef(nativeSessionId: string): NativeSessionRef | undefined {
  const parsed = nativeSessionRefSchema.safeParse({ adapterId: 'codex', nativeSessionId });
  return parsed.success ? parsed.data : undefined;
}

const resolveCodexFromDisk: DiskNativeIdentityResolver = async (context) => {
  const environment = context.environment;
  const platform = context.platform ?? process.platform;
  const fileSystem = context.fileSystem ?? new NodeTranscriptFileSystem();
  const nowMs = (context.now ?? (() => new Date()))().getTime();

  const root = codexSessionsRoot(environment);
  if (root === undefined) return undefined;

  const freshnessMs = codexFreshnessMs(environment);
  const targetCwd = normalizeForCompare(context.workingDirectory, platform);

  const candidates: Array<{ path: string; modifiedAtMs: number }> = [];
  for (const directory of await newestDayDirectories(fileSystem, root)) {
    const entries = await fileSystem.listDirectory(directory);
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (entry.isDirectory || !ROLLOUT_FILE.test(entry.name)) continue;
      const path = joinPath(directory, entry.name);
      const stat = await fileSystem.stat(path);
      if (stat === undefined) continue;
      const age = nowMs - stat.modifiedAtMs;
      // Skip before the read: too old to be the current session, or dated in the
      // future beyond clock jitter (a restored/ghost file that must not be trusted
      // as fresh or allowed to win the freshest-sort).
      if (age > freshnessMs || age < -CODEX_FUTURE_TOLERANCE_MS) continue;
      candidates.push({ path, modifiedAtMs: stat.modifiedAtMs });
    }
  }

  // The active session's rollout is the most recently written of the matches.
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

  for (const candidate of candidates) {
    const read = await fileSystem.readLines(candidate.path, SESSION_META_MAX_BYTES);
    const firstLine = read?.lines[0];
    if (firstLine === undefined) continue;
    const meta = parseSessionMeta(firstLine);
    if (meta === undefined) continue;
    if (normalizeForCompare(meta.cwd, platform) !== targetCwd) continue;
    return codexRef(meta.sessionId);
  }
  return undefined;
};

/**
 * Vendors whose identity is recoverable from disk. Only Codex has an entry: Claude
 * is complete from the environment and Gemini has no per-session identity to read
 * at all (measured 2026-09-01). A kind with no entry resolves to nothing here.
 */
const DISK_RESOLVERS: Partial<Record<AgentKind, DiskNativeIdentityResolver>> = {
  codex: resolveCodexFromDisk,
};

/**
 * Resolves a vendor-native identity that lives on disk rather than in the
 * environment. Best-effort by construction: any failure to read the tree is an
 * honest absence of evidence, never a thrown error that would break an agent's
 * startup, and never a fabricated binding.
 */
export async function resolveNativeIdentityFromDisk(
  kind: AgentKind,
  context: DiskNativeIdentityContext,
): Promise<NativeSessionRef | undefined> {
  const resolver = DISK_RESOLVERS[kind];
  if (resolver === undefined) return undefined;
  try {
    return await resolver(context);
  } catch {
    return undefined;
  }
}
