import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GitObservationError,
  NodeGitCommandRunner,
  assertGitCommandAllowed,
  createGitObserver,
  redactGitRemoteUrl,
  type GitCommandRunner,
} from './git-observer.js';

const exec = promisify(execFile);

describe('local Git observer', () => {
  let repository: string;

  beforeEach(async () => {
    repository = await mkdtemp(join(tmpdir(), 'luwi-git-observer-'));
    await exec('git', ['init', '--initial-branch=main'], { cwd: repository });
    await exec('git', ['config', 'user.name', 'LUWI Test'], { cwd: repository });
    await exec('git', ['config', 'user.email', 'luwi@example.invalid'], { cwd: repository });
    await writeFile(join(repository, 'tracked.txt'), 'one\n', 'utf8');
    await exec('git', ['add', 'tracked.txt'], { cwd: repository });
    await exec(
      'git',
      [
        'commit',
        '-m',
        'Initial sandbox commit',
        '-m',
        'Luwi-Session: session-exact\nLuwi-Agent: codex',
      ],
      { cwd: repository },
    );
    await exec('git', ['tag', 'v0.1.0'], { cwd: repository });
  });

  afterEach(async () => {
    await rm(repository, { recursive: true, force: true });
  });

  it('observes clean state, branches, tags, worktrees, commits, trailers, and redacted authors', async () => {
    const observation = await createGitObserver().observe({
      projectId: 'project-1',
      localPath: repository,
    });

    expect(observation).toMatchObject({
      projectId: 'project-1',
      branch: 'main',
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      branches: ['main'],
      tags: ['v0.1.0'],
    });
    expect(observation.headSha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(observation.worktrees).toHaveLength(1);
    expect(observation.recentCommits[0]).toMatchObject({
      subject: 'Initial sandbox commit',
      merge: false,
      changedPaths: ['tracked.txt'],
      trailers: { 'Luwi-Agent': 'codex', 'Luwi-Session': 'session-exact' },
    });
    expect(observation.recentCommits[0]?.authorIdentity).toMatch(/^author:[a-f0-9]{16}$/);
  });

  it('counts staged, unstaged, and untracked paths without reading their contents', async () => {
    await writeFile(join(repository, 'tracked.txt'), 'two\n', 'utf8');
    await writeFile(join(repository, 'staged.txt'), 'staged\n', 'utf8');
    await writeFile(join(repository, 'untracked.txt'), 'untracked\n', 'utf8');
    await exec('git', ['add', 'staged.txt'], { cwd: repository });

    const observation = await createGitObserver().observe({
      projectId: 'project-1',
      localPath: repository,
    });

    expect(observation.clean).toBe(false);
    expect(observation.stagedCount).toBe(1);
    expect(observation.unstagedCount).toBe(1);
    expect(observation.untrackedCount).toBe(1);
    expect(JSON.stringify(observation)).not.toContain('untracked\\n');
  });

  it('lists only Git-tracked paths through an exact read-only template', async () => {
    await writeFile(join(repository, 'untracked.ts'), 'never inventoried\n', 'utf8');
    await expect(createGitObserver().listTrackedFiles(repository)).resolves.toEqual([
      'tracked.txt',
    ]);
  });

  it('returns tracked paths relative to a registered project below the repository root', async () => {
    const projectDirectory = join(repository, 'packages', 'app');
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, 'package.json'), '{"name":"nested-app"}\n', 'utf8');
    await writeFile(join(repository, 'outside.json'), '{"name":"outside"}\n', 'utf8');
    await exec('git', ['add', 'packages/app/package.json', 'outside.json'], { cwd: repository });

    await expect(createGitObserver().listTrackedFiles(projectDirectory)).resolves.toEqual([
      'package.json',
    ]);
  });

  it('redacts credential-bearing remote URLs', () => {
    expect(redactGitRemoteUrl('https://alice:secret@example.com/org/repo.git')).toBe(
      'https://example.com/org/repo.git',
    );
    expect(redactGitRemoteUrl('ssh://alice@example.com/org/repo.git')).toBe(
      'ssh://example.com/org/repo.git',
    );
    expect(redactGitRemoteUrl('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
  });

  it.each(
    [
      ['fetch'],
      ['pull'],
      ['push'],
      ['clone', 'https://example.invalid/repo.git'],
      ['commit'],
      ['reset', '--hard'],
      ['checkout', 'other'],
      ['-c', 'credential.helper=x', 'status'],
      ['branch', '-D', 'main'],
      ['tag', 'release'],
      ['worktree', 'add', '../other'],
      ['worktree', 'remove', '../other'],
      ['symbolic-ref', 'HEAD', 'refs/heads/other'],
      ['config', '--global', 'user.name', 'attacker'],
      ['config', 'remote.origin.url', 'https://example.invalid/repo.git'],
    ].map((arguments_) => ({ arguments_ })),
  )('rejects mutating or network Git arguments: $arguments_', ({ arguments_ }) => {
    expect(() => assertGitCommandAllowed(arguments_)).toThrow(/not allowed/i);
  });

  it('maps timeouts and non-repositories to safe errors', async () => {
    const timeoutRunner: GitCommandRunner = {
      run: async () => {
        throw new GitObservationError('GIT_COMMAND_TIMEOUT', 'Git command timed out.');
      },
    };
    await expect(
      createGitObserver({ runner: timeoutRunner }).observe({
        projectId: 'project-1',
        localPath: repository,
      }),
    ).rejects.toMatchObject({ code: 'GIT_COMMAND_TIMEOUT' });

    const directory = await mkdtemp(join(tmpdir(), 'luwi-not-git-'));
    try {
      await expect(
        createGitObserver({ runner: new NodeGitCommandRunner() }).observe({
          projectId: 'project-1',
          localPath: directory,
        }),
      ).rejects.toMatchObject({ code: 'GIT_REPOSITORY_NOT_FOUND' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
