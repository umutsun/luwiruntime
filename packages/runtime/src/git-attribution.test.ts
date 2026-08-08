import { describe, expect, it } from 'vitest';

import type { AgentSession, GitObservation } from '@luwi/protocol';

import { attributeGitObservation } from './git-attribution.js';

const observation: GitObservation = {
  id: 'git-1',
  projectId: 'project-1',
  repositoryRoot: 'C:/repo',
  branch: 'main',
  headSha: 'a'.repeat(40),
  clean: true,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  branches: ['main'],
  tags: [],
  worktrees: [{ path: 'C:/repo', headSha: 'a'.repeat(40), branch: 'main' }],
  recentCommits: [
    {
      sha: 'a'.repeat(40),
      parentShas: [],
      committedAt: '2026-07-30T10:30:00.000Z',
      changedPaths: ['src/a.ts'],
      trailers: { 'Luwi-Session': 'session-exact' },
      merge: false,
    },
    {
      sha: 'b'.repeat(40),
      parentShas: ['a'.repeat(40)],
      committedAt: '2026-07-30T11:30:00.000Z',
      changedPaths: ['src/b.ts'],
      trailers: {},
      merge: false,
    },
  ],
  observedAt: '2026-07-30T12:00:00.000Z',
  repositoryStateHash: 'c'.repeat(64),
};

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    agentId: 'codex',
    projectId: 'project-1',
    status: 'idle',
    workingDirectory: 'C:/repo',
    branch: 'main',
    startedAt: '2026-07-30T10:00:00.000Z',
    lastHeartbeatAt: '2026-07-30T12:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

describe('Git attribution', () => {
  it('uses an explicit LUWI session trailer as exact evidence', () => {
    const attributions = attributeGitObservation(observation, [
      session('session-exact'),
      session('session-correlated'),
    ]);
    expect(attributions.find(({ commitSha }) => commitSha === 'a'.repeat(40))).toMatchObject({
      sessionId: 'session-exact',
      confidence: 'exact',
      reasons: ['explicit-luwi-session-trailer'],
    });
  });

  it('labels a unique branch/time/worktree match as correlated, never exact', () => {
    const attributions = attributeGitObservation(observation, [
      session('session-exact', { lastHeartbeatAt: '2026-07-30T10:45:00.000Z' }),
      session('session-correlated', { startedAt: '2026-07-30T11:00:00.000Z' }),
    ]);
    expect(attributions.find(({ commitSha }) => commitSha === 'b'.repeat(40))).toMatchObject({
      sessionId: 'session-correlated',
      confidence: 'correlated',
      reasons: ['branch-time-worktree-correlation'],
    });
  });

  it('returns unknown when multiple sessions match instead of guessing authorship', () => {
    const attributions = attributeGitObservation(observation, [
      session('session-exact'),
      session('session-other'),
    ]);
    expect(attributions.find(({ commitSha }) => commitSha === 'b'.repeat(40))).toMatchObject({
      confidence: 'unknown',
      reasons: ['ambiguous-session-correlation'],
    });
  });

  it('rejects contradictory LUWI project or agent trailers as exact evidence', () => {
    const contradicted: GitObservation = {
      ...observation,
      recentCommits: [
        {
          ...observation.recentCommits[0]!,
          trailers: {
            'Luwi-Session': 'session-exact',
            'Luwi-Agent': 'gemini',
            'Luwi-Project': 'other-project',
          },
        },
      ],
    };
    expect(attributeGitObservation(contradicted, [session('session-exact')])[0]).toMatchObject({
      confidence: 'unknown',
      reasons: ['contradictory-luwi-trailers'],
    });
  });
});
