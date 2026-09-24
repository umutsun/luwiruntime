import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import {
  canonicalJsonStringify,
  gitObservationSchema,
  type CanonicalJsonValue,
  type GitCommit,
  type GitObservation,
  type GitWorktree,
} from '@luwi/protocol';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMIT_LIMIT = 50;
const MAX_COMMIT_LIMIT = 200;

const LOG_FORMAT = '--format=%H%x1f%P%x1f%cI%x1f%an <%ae>%x1f%s%x1e';
const TRAILER_FORMAT = '--format=%(trailers:only,unfold=true)';
const commitIdentityPattern = /^[a-fA-F0-9]{40,64}$/;

function equals(arguments_: readonly string[], expected: readonly string[]): boolean {
  return (
    arguments_.length === expected.length &&
    arguments_.every((argument, index) => argument === expected[index])
  );
}

function isReadOnlyObservationCommand(arguments_: readonly string[]): boolean {
  if (
    [
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--verify', 'HEAD'],
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      ['status', '--porcelain=v1', '--branch'],
      ['branch', '--show-current'],
      ['branch', '--format=%(refname:short)'],
      ['tag', '--list'],
      ['worktree', 'list', '--porcelain'],
      ['config', '--get', 'remote.origin.url'],
      ['rev-list', '--count', 'HEAD'],
      ['ls-files', '-z', '--cached', '--', '.'],
    ].some((expected) => equals(arguments_, expected))
  ) {
    return true;
  }
  if (
    arguments_.length === 5 &&
    arguments_[0] === 'log' &&
    arguments_[1] === '-n' &&
    /^(?:[1-9]\d{0,2})$/.test(arguments_[2] ?? '') &&
    Number(arguments_[2]) <= MAX_COMMIT_LIMIT &&
    arguments_[3] === '--date=iso-strict' &&
    arguments_[4] === LOG_FORMAT
  ) {
    return true;
  }
  if (
    arguments_.length === 6 &&
    equals(arguments_.slice(0, 5), [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      '--root',
    ]) &&
    commitIdentityPattern.test(arguments_[5] ?? '')
  ) {
    return true;
  }
  if (
    arguments_.length === 4 &&
    equals(arguments_.slice(0, 3), ['show', '-s', TRAILER_FORMAT]) &&
    commitIdentityPattern.test(arguments_[3] ?? '')
  ) {
    return true;
  }
  return (
    arguments_.length === 3 &&
    arguments_[0] === 'cat-file' &&
    arguments_[1] === '-e' &&
    /^[0-9a-fA-F]{7,40}\^\{commit\}$/.test(arguments_[2] ?? '')
  );
}

/** Untrusted worker evidence: only this shape may ever reach a git invocation. */
const commitShaPattern = /^[0-9a-f]{7,40}$/i;

export type GitIntelligenceErrorCode =
  'GIT_REPOSITORY_NOT_FOUND' | 'GIT_COMMAND_TIMEOUT' | 'GIT_OBSERVATION_FAILED';

export class GitObservationError extends Error {
  constructor(
    readonly code: GitIntelligenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitObservationError';
  }
}

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitCommandOptions = {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export interface GitCommandRunner {
  run(arguments_: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

export function assertGitCommandAllowed(arguments_: readonly string[]): void {
  if (
    arguments_.some((argument) => argument.includes('\0')) ||
    !isReadOnlyObservationCommand(arguments_)
  ) {
    throw new GitObservationError(
      'GIT_OBSERVATION_FAILED',
      'The requested Git command is not allowed for local observation.',
    );
  }
}

/**
 * Git rejects repositories owned by the developer when LUWI itself runs in a
 * local sandbox account. Trust only this invocation's exact working directory
 * and disable repository-configured fsmonitor execution. These process-local
 * `-c` values change no global or repository configuration and do not widen
 * trust to sibling paths.
 */
export function gitInvocationArguments(
  cwd: string,
  arguments_: readonly string[],
): readonly string[] {
  return [
    '-c',
    `safe.directory=${cwd.replaceAll('\\', '/')}`,
    '-c',
    'core.fsmonitor=false',
    ...arguments_,
  ];
}

export class NodeGitCommandRunner implements GitCommandRunner {
  async run(arguments_: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    assertGitCommandAllowed(arguments_);
    return new Promise((resolve, reject) => {
      const child = spawn('git', gitInvocationArguments(options.cwd, arguments_), {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation();
      };
      const collect = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > options.maxOutputBytes) {
          child.kill();
          finish(() =>
            reject(
              new GitObservationError(
                'GIT_OBSERVATION_FAILED',
                'Git observation output exceeded the configured bound.',
              ),
            ),
          );
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.on('error', () =>
        finish(() =>
          reject(
            new GitObservationError(
              'GIT_OBSERVATION_FAILED',
              'The local Git executable could not be started.',
            ),
          ),
        ),
      );
      child.on('close', (exitCode) =>
        finish(() =>
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            exitCode: exitCode ?? 1,
          }),
        ),
      );
      const timer = setTimeout(() => {
        child.kill();
        finish(() =>
          reject(new GitObservationError('GIT_COMMAND_TIMEOUT', 'Git command timed out.')),
        );
      }, options.timeoutMs);
      timer.unref();
    });
  }
}

export function redactGitRemoteUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(
      /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i,
      (_match, protocol: string) => protocol,
    );
  }
}

function redactedAuthor(value: string): string {
  return `author:${createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseStatus(value: string): {
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  ahead?: number;
  behind?: number;
} {
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const aheadMatch = line.match(/ahead (\d+)/);
      const behindMatch = line.match(/behind (\d+)/);
      if (aheadMatch?.[1] !== undefined) ahead = Number(aheadMatch[1]);
      if (behindMatch?.[1] !== undefined) behind = Number(behindMatch[1]);
      continue;
    }
    if (line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') {
      untrackedCount += 1;
      continue;
    }
    if (x !== ' ' && x !== undefined) stagedCount += 1;
    if (y !== ' ' && y !== undefined) unstagedCount += 1;
  }
  return {
    clean: stagedCount + unstagedCount + untrackedCount === 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
  };
}

function parseWorktrees(value: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  for (const block of value.trim().split(/\r?\n\r?\n/)) {
    if (block.trim() === '') continue;
    const fields = new Map<string, string>();
    let detached = false;
    let locked = false;
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' ');
      const key = separator === -1 ? line : line.slice(0, separator);
      const fieldValue = separator === -1 ? '' : line.slice(separator + 1);
      if (key === 'detached') detached = true;
      else if (key === 'locked') locked = true;
      else fields.set(key, fieldValue);
    }
    const path = fields.get('worktree');
    const headSha = fields.get('HEAD');
    if (path === undefined || headSha === undefined) continue;
    const branchRef = fields.get('branch');
    worktrees.push({
      path,
      headSha,
      ...(branchRef === undefined ? {} : { branch: branchRef.replace(/^refs\/heads\//, '') }),
      ...(detached ? { detached: true } : {}),
      ...(locked ? { locked: true } : {}),
    });
  }
  return worktrees;
}

function parseTrailers(value: string): Record<string, string> {
  const trailers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^(Luwi-[A-Za-z0-9-]+):\s*(.{1,1000})$/i);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const normalized = match[1]
        .split('-')
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
        .join('-');
      trailers[normalized] = match[2].trim();
    }
  }
  return trailers;
}

export type ObserveGitInput = {
  projectId: string;
  localPath: string;
  commitLimit?: number;
};

export type GitObserverOptions = {
  runner?: GitCommandRunner;
  createId?: () => string;
  now?: () => Date;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export interface GitObserver {
  observe(input: ObserveGitInput): Promise<GitObservation>;
  listTrackedFiles(localPath: string): Promise<string[]>;
  /**
   * Whether a commit sha exists in the repository at `localPath`'s root —
   * used to accept a lane-worktree commit (a `lane/<role>` branch of the same
   * repository) as commit evidence without widening the observed log itself.
   * `sha` is untrusted worker evidence: an invalid shape never reaches git,
   * and any error (not a repository, git failure) answers `false` (fail closed).
   */
  commitExists(localPath: string, sha: string): Promise<boolean>;
}

export function createGitObserver(options: GitObserverOptions = {}): GitObserver {
  const runner = options.runner ?? new NodeGitCommandRunner();
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const run = async (cwd: string, arguments_: readonly string[]): Promise<GitCommandResult> => {
    assertGitCommandAllowed(arguments_);
    return runner.run(arguments_, { cwd, timeoutMs, maxOutputBytes });
  };
  const optional = async (
    cwd: string,
    arguments_: readonly string[],
  ): Promise<string | undefined> => {
    const result = await run(cwd, arguments_);
    return result.exitCode === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : undefined;
  };

  return {
    async listTrackedFiles(localPath) {
      const resolved = await realpath(localPath).catch(() => localPath);
      const root = await run(resolved, ['rev-parse', '--show-toplevel']);
      if (root.exitCode !== 0 || root.stdout.trim() === '') {
        throw new GitObservationError(
          'GIT_REPOSITORY_NOT_FOUND',
          'The project path is not inside a local Git repository.',
        );
      }
      const result = await run(resolved, ['ls-files', '-z', '--cached', '--', '.']);
      if (result.exitCode !== 0) {
        throw new GitObservationError('GIT_OBSERVATION_FAILED', 'Git tracked-file scan failed.');
      }
      return result.stdout
        .split('\0')
        .filter((path) => path !== '')
        .toSorted();
    },
    async commitExists(localPath, sha) {
      if (!commitShaPattern.test(sha)) return false;
      try {
        const resolved = await realpath(localPath).catch(() => localPath);
        const root = await run(resolved, ['rev-parse', '--show-toplevel']);
        if (root.exitCode !== 0 || root.stdout.trim() === '') return false;
        const result = await run(root.stdout.trim(), ['cat-file', '-e', `${sha}^{commit}`]);
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },
    async observe(input) {
      const localPath = await realpath(input.localPath).catch(() => input.localPath);
      let rootResult: GitCommandResult;
      try {
        rootResult = await run(localPath, ['rev-parse', '--show-toplevel']);
      } catch (error) {
        if (error instanceof GitObservationError) throw error;
        throw new GitObservationError('GIT_OBSERVATION_FAILED', 'Git observation failed.');
      }
      if (rootResult.exitCode !== 0 || rootResult.stdout.trim() === '') {
        throw new GitObservationError(
          'GIT_REPOSITORY_NOT_FOUND',
          'The project path is not inside a local Git repository.',
        );
      }
      const repositoryRoot = rootResult.stdout.trim();
      const limit = Math.min(
        Math.max(input.commitLimit ?? DEFAULT_COMMIT_LIMIT, 1),
        MAX_COMMIT_LIMIT,
      );

      try {
        const [
          branch,
          headSha,
          statusText,
          branchesText,
          tagsText,
          worktreesText,
          remoteText,
          defaultBranchText,
          logText,
          commitCountText,
        ] = await Promise.all([
          optional(repositoryRoot, ['branch', '--show-current']),
          optional(repositoryRoot, ['rev-parse', '--verify', 'HEAD']),
          optional(repositoryRoot, ['status', '--porcelain=v1', '--branch']),
          optional(repositoryRoot, ['branch', '--format=%(refname:short)']),
          optional(repositoryRoot, ['tag', '--list']),
          optional(repositoryRoot, ['worktree', 'list', '--porcelain']),
          optional(repositoryRoot, ['config', '--get', 'remote.origin.url']),
          optional(repositoryRoot, [
            'symbolic-ref',
            '--quiet',
            '--short',
            'refs/remotes/origin/HEAD',
          ]),
          optional(repositoryRoot, ['log', '-n', String(limit), '--date=iso-strict', LOG_FORMAT]),
          // The true reachable-commit total (not the bounded recent window), so
          // the registry can hint at repository size. Optional: an unborn HEAD
          // has no count, and the command is already in the read-only allowlist.
          optional(repositoryRoot, ['rev-list', '--count', 'HEAD']),
        ]);

        const recentCommits: GitCommit[] = [];
        for (const raw of (logText ?? '').split('\x1e')) {
          const record = raw.trim();
          if (record === '') continue;
          const [sha, parents = '', committedAt, author = '', subject = ''] = record.split('\x1f');
          if (sha === undefined || committedAt === undefined) continue;
          const [pathsResult, trailersResult] = await Promise.all([
            run(repositoryRoot, [
              'diff-tree',
              '--no-commit-id',
              '--name-only',
              '-r',
              '--root',
              sha,
            ]),
            run(repositoryRoot, ['show', '-s', TRAILER_FORMAT, sha]),
          ]);
          recentCommits.push({
            sha,
            parentShas: parents === '' ? [] : parents.split(' '),
            committedAt: new Date(committedAt).toISOString(),
            ...(subject === '' ? {} : { subject: subject.slice(0, 500) }),
            ...(author === '' ? {} : { authorIdentity: redactedAuthor(author) }),
            changedPaths: lines(pathsResult.stdout).slice(0, 5000),
            trailers: parseTrailers(trailersResult.stdout),
            merge: parents.split(' ').filter(Boolean).length > 1,
          });
        }

        const status = parseStatus(statusText ?? '');
        const parsedCommitCount =
          commitCountText === undefined ? Number.NaN : Number(commitCountText.trim());
        const commitCount = Number.isInteger(parsedCommitCount) ? parsedCommitCount : undefined;
        const observedAt = now().toISOString();
        const state = {
          projectId: input.projectId,
          repositoryRoot,
          ...(branch === undefined ? {} : { branch }),
          ...(headSha === undefined ? {} : { headSha }),
          ...(commitCount === undefined ? {} : { commitCount }),
          ...(defaultBranchText === undefined
            ? {}
            : { defaultBranch: defaultBranchText.replace(/^origin\//, '') }),
          ...(remoteText === undefined ? {} : { remoteUrl: redactGitRemoteUrl(remoteText) }),
          ...status,
          branches: lines(branchesText ?? '')
            .slice(0, 1000)
            .toSorted(),
          tags: lines(tagsText ?? '')
            .slice(0, 1000)
            .toSorted(),
          worktrees: parseWorktrees(worktreesText ?? '').slice(0, 1000),
          recentCommits,
        };
        return gitObservationSchema.parse({
          id: `git-${createId()}`,
          ...state,
          observedAt,
          repositoryStateHash: createHash('sha256')
            .update(canonicalJsonStringify(JSON.parse(JSON.stringify(state)) as CanonicalJsonValue))
            .digest('hex'),
        });
      } catch (error) {
        if (error instanceof GitObservationError) throw error;
        throw new GitObservationError('GIT_OBSERVATION_FAILED', 'Git observation failed.');
      }
    },
  };
}
