import { useState } from 'react';

import type { CapabilityMutations } from '../api/capability-mutations.js';
import type { LeaseResources } from '../api/lease-scope.js';
import type { ProjectMutations } from '../api/project-mutations.js';
import { LeasePanel } from './lease-panel.js';
import type {
  AgentPairResources,
  ContextFootprint,
  EffectiveConfig,
  PairContextSummary,
} from '../api/agent-pair-scope.js';
import type {
  Bounded,
  FlowRole,
  ProjectAttribution,
  ProjectBinding,
  ProjectCapability,
  ProjectGit,
  ProjectPackage,
  ProjectScopeResources,
  ProjectTechnology,
  ProjectWorktree,
} from '../api/project-scope.js';
import {
  abbreviatePath,
  abbreviateSha,
  monogramInitials,
  paletteIndex,
} from '../components/format.js';
import {
  AttributionConfidenceChip,
  ConfidenceChip,
  Count,
  Panel,
  ResourcePanel,
  Unavailable,
} from '../components/panel.js';
import { StatusChip, type StatusTone } from '../components/status-chip.js';
import type { PulseFinding, PulseProject, PulseSnapshot } from '../pulse/model.js';

const findingStateTones: Record<PulseFinding['state'], StatusTone> = {
  open: 'warning',
  proposed: 'info',
  dismissed: 'unknown',
  resolved: 'success',
};

/**
 * How many branch or tag names one panel shows.
 *
 * This is a display bound, not a read bound. The observation delivers both
 * arrays complete, so the sentence below says "showing the first N of M"
 * rather than borrowing `TruncationNote`, which asserts the different and
 * stronger fact that records exist which were never read.
 */
const NAME_LIST_LIMIT = 25;
const RECENT_COMMIT_LIMIT = 10;

/**
 * Names one observed collection and carries its size.
 *
 * The label is not decoration. Branches and tags render as identical rows of
 * pills, so two unlabelled lists next to each other are indistinguishable —
 * which is exactly how they first shipped and what looking at the page caught.
 * The count lives here rather than in a separate summary grid so the number and
 * the thing it counts cannot drift apart on screen.
 */
function GroupLabel({ label, count }: { label: string; count: number }) {
  return (
    <p className="group-label">
      <span>{label}</span>
      <span className="group-label__count">{count}</span>
    </p>
  );
}

/*
 * A native disclosure, closed by default: 325 branches as pills made the
 * Repository card taller than the drawer, and the count in the summary is the
 * fact most readers came for. The label and count stay visible while closed.
 */
function NameList({ names, label, noun }: { names: string[]; label: string; noun: string }) {
  return (
    <details className="name-group">
      <summary className="group-label">
        <span>{label}</span>
        <span className="group-label__count">{names.length}</span>
      </summary>
      {names.length === 0 ? (
        // An observed empty collection is an answer, so it is stated rather
        // than omitted — an absent section would read as "not measured".
        <p className="empty-state">No {noun} recorded</p>
      ) : (
        <ul className="name-list">
          {names.slice(0, NAME_LIST_LIMIT).map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
      {names.length > NAME_LIST_LIMIT ? (
        <p className="bounded-note">
          Showing the first {NAME_LIST_LIMIT} of {names.length} {noun}. The observation carries them
          all; only this list is shortened.
        </p>
      ) : null}
    </details>
  );
}

function WorktreeTable({ worktrees }: { worktrees: ProjectWorktree[] }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">Worktrees in this repository</caption>
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">HEAD</th>
            <th scope="col">Branch</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {worktrees.map((worktree) => (
            <tr key={worktree.path}>
              <td>
                <small title={worktree.path}>{abbreviatePath(worktree.path)}</small>
              </td>
              <td>
                <code title={worktree.headSha}>{abbreviateSha(worktree.headSha)}</code>
              </td>
              <td>{worktree.branch ?? <span className="unavailable">None</span>}</td>
              <td>
                {/* An absent flag is not a reported state, so nothing is drawn
                    for it — an attached, unlocked worktree shows no chip. */}
                {worktree.detached === true ? (
                  <StatusChip tone="warning">Detached</StatusChip>
                ) : null}
                {worktree.locked === true ? <StatusChip tone="info">Locked</StatusChip> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A browsable commit URL from a git remote, or `undefined` when there is no usable remote (then the
 * sha renders as plain text). Normalizes an scp-style `git@host:user/repo(.git)` to
 * `https://host/user/repo` and strips a trailing `.git`.
 * ponytail: emits the GitHub/GitLab web `/commit/<sha>` path; a Bitbucket remote would want
 * `/commits/`. Add that branch only if a Bitbucket remote actually shows up.
 */
/**
 * A browsable web URL for a git remote, or undefined when it is not one an owner
 * can open: an scp-style `git@host:owner/repo` becomes `https://host/owner/repo`,
 * a trailing `.git` and slash are dropped, and a non-http remote (a local path,
 * ssh://, unknown) yields nothing rather than a broken link.
 */
export function remoteWebUrl(remote: string | undefined): string | undefined {
  if (remote === undefined || remote.trim() === '') return undefined;
  const scp = /^git@([^:]+):(.+)$/.exec(remote.trim());
  const base = (scp ? `https://${scp[1]}/${scp[2]}` : remote.trim())
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  return /^https?:\/\//.test(base) ? base : undefined;
}

export function commitUrl(remote: string | undefined, sha: string): string | undefined {
  const base = remoteWebUrl(remote);
  return base === undefined ? undefined : `${base}/commit/${encodeURIComponent(sha)}`;
}

function RepositoryBody({ git, project }: { git: ProjectGit; project: PulseProject }) {
  // A clickable link to the repository home, from whichever remote resolves to a
  // web URL (observed first, then the registered one). Absent for a local-only
  // or non-http remote — no broken link.
  const repoUrl = remoteWebUrl(git.remoteUrl ?? project.repositoryUrl);
  return (
    <div className="project-detail__body">
      {repoUrl === undefined ? null : (
        <p className="repo-link">
          <a href={repoUrl} target="_blank" rel="noreferrer">
            Open repository ↗
          </a>
        </p>
      )}
      <dl className="key-values">
        <div>
          <dt>Branch</dt>
          <dd>{git.branch ?? <span className="unavailable">Unknown</span>}</dd>
        </div>
        <div>
          <dt>Observed default</dt>
          <dd>{git.defaultBranch ?? <span className="unavailable">Not reported</span>}</dd>
        </div>
        <div>
          <dt>Registered default</dt>
          <dd>{project.defaultBranch ?? <span className="unavailable">Not registered</span>}</dd>
        </div>
        <div>
          <dt>HEAD</dt>
          <dd>
            {git.headSha === undefined ? (
              <span className="unavailable">Unknown</span>
            ) : (
              <code title={git.headSha}>{abbreviateSha(git.headSha)}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Observed remote</dt>
          <dd>
            {git.remoteUrl === undefined ? (
              <span className="unavailable">Not reported</span>
            ) : (
              <code>{git.remoteUrl}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Registered remote</dt>
          <dd>
            {project.repositoryUrl === undefined ? (
              <span className="unavailable">Not registered</span>
            ) : (
              <code>{project.repositoryUrl}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Root</dt>
          <dd>
            <small title={git.repositoryRoot}>{abbreviatePath(git.repositoryRoot)}</small>
          </dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>{git.observedAt}</dd>
        </div>
        <div>
          <dt>Divergence</dt>
          <dd>
            {git.ahead === undefined && git.behind === undefined ? (
              <span className="unavailable">Not reported</span>
            ) : (
              `${git.ahead === undefined ? 'Unknown' : String(git.ahead)} ahead / ${git.behind === undefined ? 'Unknown' : String(git.behind)} behind`
            )}
          </dd>
        </div>
      </dl>
      <p className="worktree-state">
        <StatusChip tone={git.clean ? 'success' : 'warning'}>
          {git.clean ? 'Clean working tree' : 'Modified working tree'}
        </StatusChip>
        <span>{git.stagedCount} staged</span>
        <span>{git.unstagedCount} unstaged</span>
        <span>{git.untrackedCount} untracked</span>
      </p>
      <NameList names={git.branches} label="Branches" noun="branches" />
      <NameList names={git.tags} label="Tags" noun="tags" />
      {/* Folded like the name lists: a project with seventy worktrees made
          this table the tallest thing in the drawer. */}
      <details className="name-group">
        <summary className="group-label">
          <span>Worktrees</span>
          <span className="group-label__count">{git.worktrees.length}</span>
        </summary>
        {git.worktrees.length === 0 ? (
          <p className="empty-state">No worktrees recorded</p>
        ) : (
          <WorktreeTable worktrees={git.worktrees} />
        )}
      </details>
      {/* The summary counts what the observation carries; the table shows the
          first ten and says so, rather than a count of fifty over ten rows. */}
      <details className="name-group">
        <summary className="group-label">
          <span>Recent commits</span>
          <span className="group-label__count">{git.recentCommits.length}</span>
        </summary>
        {git.recentCommits.length === 0 ? (
          <p className="empty-state">No retained commits</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="visually-hidden">Recent commits</caption>
              <thead>
                <tr>
                  <th scope="col">Commit</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Files</th>
                </tr>
              </thead>
              <tbody>
                {git.recentCommits.slice(0, RECENT_COMMIT_LIMIT).map((commit) => {
                  const url = commitUrl(git.remoteUrl ?? project.repositoryUrl, commit.sha);
                  return (
                    <tr key={commit.sha}>
                      <td>
                        {url === undefined ? (
                          <code title={commit.sha}>{abbreviateSha(commit.sha)}</code>
                        ) : (
                          <a href={url} target="_blank" rel="noreferrer" title={commit.sha}>
                            <code>{abbreviateSha(commit.sha)}</code>
                          </a>
                        )}
                      </td>
                      <td>{commit.subject ?? <span className="unavailable">No subject</span>}</td>
                      <td>{commit.changedPathCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {git.recentCommits.length > RECENT_COMMIT_LIMIT ? (
          <p className="bounded-note">
            Showing the first {RECENT_COMMIT_LIMIT} of {git.recentCommits.length} commits. The
            observation carries them all; only this list is shortened.
          </p>
        ) : null}
      </details>
    </div>
  );
}

function TruncationNote({ truncated, noun }: { truncated: boolean; noun: string }) {
  if (!truncated) return null;
  return (
    <p className="bounded-note">
      Bounded list — more {noun} exist than are shown. Truncation is disclosed rather than hidden.
    </p>
  );
}

/**
 * What a project-agent binding actually resolves to.
 *
 * `profileCount` and `capabilityCount` have been on screen since Phase 5C as
 * two numbers whose contents could not be opened — the 2026-08-09 audit's one
 * coverage gap with a concrete dead end. These panels are the other side of
 * those numbers, and they are also where an invalid effective configuration
 * becomes visible instead of staying an unreadable `valid: false`.
 */
function AgentPairPanels({
  agentId,
  resources,
  loading,
}: {
  agentId: string;
  resources: Partial<AgentPairResources>;
  loading: boolean;
}) {
  return (
    <>
      <ResourcePanel<EffectiveConfig>
        title="Effective configuration"
        meta={agentId}
        collapsible
        resource={resources.effectiveConfig}
        loading={loading}
        emptyMessage="No effective configuration resolved"
        isEmpty={() => false}
      >
        {(config) => (
          <div className="project-detail__body">
            <dl className="key-values">
              <div>
                <dt>Resolves</dt>
                <dd>
                  <StatusChip tone={config.valid ? 'success' : 'warning'}>
                    {config.valid ? 'Valid' : 'Unresolved'}
                  </StatusChip>
                </dd>
              </div>
              <div>
                <dt>Agent kind</dt>
                <dd>{config.agentKind}</dd>
              </div>
              <div>
                <dt>Provenance entries</dt>
                <dd>
                  <strong className="metric">{config.provenanceCount}</strong>
                  <small>Every value the resolver traced to a source</small>
                </dd>
              </div>
              <div>
                <dt>Estimated context</dt>
                <dd>
                  <strong className="metric">{config.estimatedTokens}</strong>
                  <small>Generic character estimate, not measured tokens</small>
                </dd>
              </div>
            </dl>

            {/* Each section folds (the effective config ran to four dense tables
                at once); the panel opens to the summary above and these closed. */}
            <details className="name-group">
              <summary className="group-label">
                <span>Capabilities</span>
                <span className="group-label__count">{config.capabilities.length}</span>
              </summary>
              {config.capabilities.length === 0 ? (
                <p className="empty-state">No capabilities resolved for this pair</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <caption className="visually-hidden">Resolved capabilities</caption>
                    <thead>
                      <tr>
                        <th scope="col">Capability</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Scope</th>
                        <th scope="col">State</th>
                        <th scope="col">Native support</th>
                      </tr>
                    </thead>
                    <tbody>
                      {config.capabilities.map((capability) => {
                        const support = config.nativeCapabilitySupport.find(
                          (entry) => entry.capabilityId === capability.id,
                        );
                        const unsupported = config.unsupportedCapabilities.includes(capability.id);
                        return (
                          <tr key={capability.id}>
                            <td>
                              {capability.name}
                              <small title={capability.id}>{capability.id}</small>
                            </td>
                            <td>{capability.kind}</td>
                            <td>{capability.scope}</td>
                            <td>
                              <StatusChip tone={capability.enabled ? 'success' : 'unknown'}>
                                {capability.enabled ? 'Enabled' : 'Disabled'}
                              </StatusChip>
                            </td>
                            <td>
                              {support === undefined ? (
                                <span className="unavailable">Not reported</span>
                              ) : (
                                <StatusChip
                                  tone={
                                    support.supportLevel === 'full'
                                      ? 'success'
                                      : support.supportLevel === 'unsupported'
                                        ? 'warning'
                                        : 'info'
                                  }
                                >
                                  {support.supportLevel}
                                </StatusChip>
                              )}
                              {unsupported ? <small>Not usable by this agent</small> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </details>

            <details className="name-group">
              <summary className="group-label">
                <span>Profiles</span>
                <span className="group-label__count">{config.profileIds.length}</span>
              </summary>
              {config.profileIds.length === 0 ? (
                <p className="empty-state">No profiles applied</p>
              ) : (
                <ul className="name-list">
                  {config.profileIds.map((profileId) => (
                    <li key={profileId}>{profileId}</li>
                  ))}
                </ul>
              )}
            </details>

            <details className="name-group">
              <summary className="group-label">
                <span>Conflicts</span>
                <span className="group-label__count">{config.conflicts.length}</span>
              </summary>
              {config.conflicts.length === 0 ? (
                <p className="empty-state">No conflicts detected</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <caption className="visually-hidden">Configuration conflicts</caption>
                    <thead>
                      <tr>
                        <th scope="col">Code</th>
                        <th scope="col">Detail</th>
                        <th scope="col">Capability</th>
                      </tr>
                    </thead>
                    <tbody>
                      {config.conflicts.map((conflict, index) => (
                        <tr key={`${conflict.code}-${String(index)}`}>
                          <td>
                            <code>{conflict.code}</code>
                          </td>
                          <td>{conflict.message}</td>
                          <td>
                            {conflict.capabilityId ?? (
                              <span className="unavailable">Not scoped</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>

            <details className="name-group">
              <summary className="group-label">
                <span>Missing dependencies</span>
                <span className="group-label__count">{config.missingDependencies.length}</span>
              </summary>
              {config.missingDependencies.length === 0 ? (
                <p className="empty-state">No missing dependencies</p>
              ) : (
                <ul className="name-list">
                  {config.missingDependencies.map((dependency) => (
                    <li key={dependency}>{dependency}</li>
                  ))}
                </ul>
              )}
            </details>

            <p className="bounded-note">
              An unresolved configuration is reported, not hidden. It means the runtime could not
              produce a configuration this agent can use, and the conflicts and unsupported
              capabilities above are the reason. Nothing here applies, renders, or repairs anything.
            </p>
          </div>
        )}
      </ResourcePanel>

      <ResourcePanel<PairContextSummary>
        title="Context for this pair"
        collapsible
        defaultCollapsed
        resource={resources.contextSummary}
        loading={loading}
        emptyMessage="No context observed for this pair"
        isEmpty={() => false}
      >
        {(summary) => (
          <>
            <dl className="key-values">
              {(
                [
                  ['Contributions', summary.contributionCount],
                  ['Assigned', summary.assignedCount],
                  ['Effective', summary.effectiveCount],
                  ['Loaded', summary.observedLoadedCount],
                  ['Invoked', summary.observedInvokedCount],
                  ['Unknown', summary.unknownLoadedCount],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <strong className="metric">{value}</strong>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="bounded-note">
              Four independent observations, not stages of one pipeline, and an unobserved value
              stays unknown rather than being counted as unused. Measured {summary.measuredAt}.
            </p>
          </>
        )}
      </ResourcePanel>

      <ResourcePanel<ContextFootprint>
        title="Context footprint"
        collapsible
        defaultCollapsed
        resource={resources.contextFootprint}
        loading={loading}
        emptyMessage="No context footprint measured"
        isEmpty={(value) => value.categories.length === 0}
      >
        {(footprint) => (
          <>
            <dl className="key-values">
              <div>
                <dt>Estimated tokens</dt>
                <dd>
                  <strong className="metric">{footprint.estimatedTokens}</strong>
                </dd>
              </div>
              <div>
                <dt>Bytes</dt>
                <dd>
                  <strong className="metric">{footprint.totalBytes}</strong>
                </dd>
              </div>
              <div>
                <dt>Lines</dt>
                <dd>
                  <strong className="metric">{footprint.totalLines}</strong>
                </dd>
              </div>
            </dl>

            <GroupLabel label="By category" count={footprint.categories.length} />
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">Context footprint by category</caption>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Sources</th>
                    <th scope="col">Lines</th>
                    <th scope="col">Estimated tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {footprint.categories.map((category) => (
                    <tr key={category.name}>
                      <td>{category.name}</td>
                      <td>{category.sourceCount}</td>
                      <td>{category.lines}</td>
                      <td>{category.estimatedTokens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <GroupLabel
              label="Exact duplicate groups"
              count={footprint.exactDuplicateGroups.length}
            />
            {footprint.exactDuplicateGroups.length === 0 ? (
              <p className="empty-state">No byte-identical sources</p>
            ) : (
              <ul className="name-list">
                {footprint.exactDuplicateGroups.map((group) => (
                  <li key={group.join('|')}>{group.join(' = ')}</li>
                ))}
              </ul>
            )}

            <p className="bounded-note">
              Token figures are generic character estimates, not measured consumption. Duplicate
              groups are byte-identical content, never a similarity score.
            </p>
          </>
        )}
      </ResourcePanel>
    </>
  );
}

export function ProjectsView({
  snapshot,
  selectedProjectId,
  selectedAgentId,
  resources,
  scopeLoading,
  agentPairResources = {},
  agentPairLoading = false,
  leaseResources = {},
  nowMs,
  onSelectProject,
  onSelectAgent,
  renderDetailInline = true,
  projectMutations,
  capabilityMutations,
  onMutated,
}: {
  snapshot: PulseSnapshot;
  selectedProjectId?: string | undefined;
  selectedAgentId?: string | undefined;
  resources: Partial<ProjectScopeResources>;
  scopeLoading: boolean;
  agentPairResources?: Partial<AgentPairResources>;
  agentPairLoading?: boolean;
  leaseResources?: Partial<LeaseResources>;
  /** Injected so the rendered time left is testable rather than clock-dependent. */
  nowMs?: number;
  onSelectProject: (projectId: string) => void;
  onSelectAgent?: (agentId: string | undefined) => void;
  /** The shell passes false and renders <ProjectDetail/> in the overlay drawer itself. */
  renderDetailInline?: boolean;
  projectMutations?: ProjectMutations | undefined;
  capabilityMutations?: CapabilityMutations | undefined;
  onMutated?: (() => void) | undefined;
}) {
  const projectsAvailable = snapshot.projectCount.state !== 'unavailable';

  return (
    <div
      className={`projects-stack${selectedProjectId === undefined ? ' projects-stack--registry' : ''}`}
    >
      <section className="panel panel--projects" aria-labelledby="projects-registry">
        <header className="panel__header">
          <h2 id="projects-registry">Registered projects</h2>
          <span className="panel__meta">
            {projectsAvailable ? `${snapshot.projects.length} registered` : 'Count unavailable'}
          </span>
        </header>
        {!projectsAvailable ? (
          <p className="empty-state">Project data unavailable</p>
        ) : snapshot.projects.length === 0 ? (
          <p className="empty-state">No registered projects</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  {/*
                   * Agents and HEAD live in the project detail drawer, not here:
                   * the registry is a lean picker — name, size, activity — so it
                   * fits a normal-width drawer. Commits is the true
                   * reachable-commit total (git rev-list --count), a size hint.
                   */}
                  <th scope="col">Commits</th>
                  <th scope="col">Active sessions</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.projects.map((project) => {
                  const facts = snapshot.repositoryFacts.find(
                    (row) => row.projectId === project.id,
                  );
                  return (
                    <tr key={project.id} aria-selected={project.id === selectedProjectId}>
                      <td>
                        <span className="project-cell">
                          <span
                            className={`project-monogram project-monogram--${String(
                              paletteIndex(project.id, 5),
                            )}`}
                            aria-hidden="true"
                          >
                            {monogramInitials(project.name)}
                          </span>
                          <span className="project-cell__body">
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => onSelectProject(project.id)}
                            >
                              {project.name}
                            </button>
                            <small title={project.localPath}>
                              {abbreviatePath(project.localPath)}
                            </small>
                          </span>
                        </span>
                      </td>
                      <td>
                        {facts === undefined || facts.git.state === 'unavailable' ? (
                          <Unavailable />
                        ) : facts.git.state === 'not-observed' ? (
                          <span className="table-dim">not scanned</span>
                        ) : facts.git.data.commitCount === undefined ? (
                          <span className="table-dim">—</span>
                        ) : (
                          facts.git.data.commitCount.toLocaleString()
                        )}
                      </td>
                      <td>
                        <Count value={project.activeSessions} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedProjectId === undefined ? (
        <p className="empty-state">Select a project to load its scoped evidence.</p>
      ) : renderDetailInline ? (
        <ProjectDetail
          snapshot={snapshot}
          selectedProjectId={selectedProjectId}
          {...(selectedAgentId === undefined ? {} : { selectedAgentId })}
          resources={resources}
          scopeLoading={scopeLoading}
          agentPairResources={agentPairResources}
          agentPairLoading={agentPairLoading}
          leaseResources={leaseResources}
          {...(nowMs === undefined ? {} : { nowMs })}
          {...(onSelectAgent === undefined ? {} : { onSelectAgent })}
          {...(projectMutations === undefined ? {} : { projectMutations })}
          {...(capabilityMutations === undefined ? {} : { capabilityMutations })}
          {...(onMutated === undefined ? {} : { onMutated })}
        />
      ) : null}
    </div>
  );
}

/**
 * The scoped evidence for one selected project.
 *
 * Extracted from the registry so the shell can place it in an overlay drawer.
 * The registry keeps rendering it inline by default so its own tests and any
 * embedder without a drawer still get the full view.
 */
export function ProjectDetail({
  snapshot,
  selectedProjectId,
  selectedAgentId,
  resources,
  scopeLoading,
  agentPairResources = {},
  agentPairLoading = false,
  leaseResources = {},
  nowMs,
  onSelectAgent,
  projectMutations,
  capabilityMutations,
  onMutated,
}: {
  snapshot: PulseSnapshot;
  selectedProjectId: string;
  selectedAgentId?: string | undefined;
  resources: Partial<ProjectScopeResources>;
  scopeLoading: boolean;
  agentPairResources?: Partial<AgentPairResources>;
  agentPairLoading?: boolean;
  leaseResources?: Partial<LeaseResources>;
  nowMs?: number;
  onSelectAgent?: (agentId: string | undefined) => void;
  /** Absent keeps the bound agents' flow roles read-only (ADR 0036). */
  projectMutations?: ProjectMutations | undefined;
  /** Absent keeps the Skills panel read-only (ADR 0036). */
  capabilityMutations?: CapabilityMutations | undefined;
  /** Called after a role or capability change so the scope can be re-read. */
  onMutated?: (() => void) | undefined;
}) {
  const selected = snapshot.projects.find((project) => project.id === selectedProjectId);

  // The two write surfaces this drawer carries (F5, ADR 0036). One busy marker
  // and one note serve both: a change here is one gesture at a time, and the
  // daemon's own refusal is what the reader should see.
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<{ tone: 'ok' | 'danger'; message: string }>();
  const settle = (
    result: { state: 'ok' } | { state: 'failed'; reason: string; message?: string },
    done: string,
  ): void => {
    setBusy(undefined);
    if (result.state === 'ok') {
      setNote({ tone: 'ok', message: done });
      onMutated?.();
      return;
    }
    setNote({
      tone: 'danger',
      message:
        result.reason === 'http' && result.message !== undefined
          ? result.message
          : 'The change could not be completed.',
    });
  };
  const toggleFlowRole = async (binding: ProjectBinding, role: FlowRole): Promise<void> => {
    if (projectMutations === undefined) return;
    const held = binding.flowRoles ?? [];
    const next = held.includes(role) ? held.filter((item) => item !== role) : [...held, role];
    setBusy(binding.id);
    setNote(undefined);
    settle(
      await projectMutations.updateAgentBinding(selectedProjectId, binding.id, {
        flowRoles: next,
      }),
      `${binding.agentId}: ${next.length === 0 ? 'no flow role' : next.join(' + ')}.`,
    );
  };
  // A skill is assigned to the project, or to the one agent selected in the
  // bound-agents table; the daemon's assignment shape carries no other target.
  const capabilityTarget =
    selectedAgentId === undefined
      ? { projectId: selectedProjectId }
      : { projectId: selectedProjectId, agentId: selectedAgentId };
  const targetLabel = selectedAgentId ?? 'project';
  const runCapability = async (
    capabilityId: string,
    action: 'enable' | 'disable' | 'assign' | 'unassign' | 'rescan',
  ): Promise<void> => {
    if (capabilityMutations === undefined) return;
    setBusy(action === 'rescan' ? 'rescan' : capabilityId);
    setNote(undefined);
    const result =
      action === 'enable' || action === 'disable'
        ? await capabilityMutations.setEnabled(capabilityId, action === 'enable')
        : action === 'assign'
          ? await capabilityMutations.assign(capabilityId, capabilityTarget)
          : action === 'unassign'
            ? await capabilityMutations.unassign(capabilityId, capabilityTarget)
            : await capabilityMutations.rescan();
    settle(
      result,
      action === 'rescan'
        ? 'Capabilities rescanned.'
        : action === 'assign'
          ? `Assigned to ${targetLabel}.`
          : action === 'unassign'
            ? `Unassigned from ${targetLabel}.`
            : `Capability ${action}d.`,
    );
  };
  const projectFindings = snapshot.findings.filter(
    (finding) => finding.projectId === selectedProjectId,
  );
  const projectSessions = snapshot.sessions.filter(
    (session) => session.projectId === selectedProjectId,
  );

  return selected === undefined ? (
    <p className="empty-state">Project not found in the current snapshot.</p>
  ) : scopeLoading ? (
    <p className="empty-state">Loading project evidence…</p>
  ) : (
    <div className="project-detail">
      {/*
       * Every card folds. The drawer stacks seven evidence cards and, opened on
       * a real project, ran to several screens; only the repository starts
       * open, the rest start folded and say what they hold in their headers.
       */}
      <ResourcePanel<ProjectGit>
        title="Repository"
        collapsible
        resource={resources.git}
        notObservedMessage="Not observed — no Git scan has been recorded for this project."
        emptyMessage="No repository detail"
        isEmpty={() => false}
      >
        {(git) => <RepositoryBody git={git} project={selected} />}
      </ResourcePanel>

      {/* Sessions sit high, right under the repository: they are the project's
          live activity and the first thing a reader looks for. Open by default;
          the evidence cards below start folded. */}
      <Panel title="Sessions" meta={`${String(projectSessions.length)} recorded`} collapsible>
        {projectSessions.length === 0 ? (
          <p className="empty-state">No sessions recorded for this project</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Status</th>
                  <th scope="col">Presence</th>
                </tr>
              </thead>
              <tbody>
                {projectSessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <code>{session.id}</code>
                    </td>
                    <td>{session.statusLabel}</td>
                    <td>
                      <StatusChip tone={session.presence === 'online' ? 'success' : 'unknown'}>
                        {session.presence === 'online' ? 'Online' : 'Offline'}
                      </StatusChip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ResourcePanel<Bounded<ProjectAttribution>>
        title="Commit attribution"
        collapsible
        defaultCollapsed
        resource={resources.attributions}
        emptyMessage="No commit attribution recorded"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Commit</th>
                    <th scope="col">Attributed to</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {value.items.map((record) => (
                    <tr key={record.id}>
                      <td>
                        <code title={record.commitSha}>{abbreviateSha(record.commitSha)}</code>
                      </td>
                      <td>
                        {record.agentId === undefined && record.sessionId === undefined ? (
                          <span className="unavailable">Unattributed</span>
                        ) : (
                          <>
                            {record.agentId ?? <span className="unavailable">Unknown agent</span>}
                            {record.sessionId === undefined ? null : (
                              <small title={record.sessionId}>{record.sessionId}</small>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        <AttributionConfidenceChip confidence={record.confidence} />
                      </td>
                      <td>
                        {record.reasons.length === 0 ? (
                          <span className="unavailable">No reason recorded</span>
                        ) : (
                          <small>{record.reasons.join(', ')}</small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="bounded-note">
              Attribution is observed, not asserted. A commit the runtime could not tie to a session
              stays unattributed rather than being assigned a guess, and the reason column says why
              it could not.
            </p>
            <TruncationNote truncated={value.truncated} noun="attributions" />
          </>
        )}
      </ResourcePanel>

      <LeasePanel
        leases={leaseResources.leases}
        loading={scopeLoading}
        nowMs={nowMs ?? Date.now()}
      />

      {note === undefined ? null : (
        <p
          className={note.tone === 'ok' ? 'outcome outcome--ok' : 'outcome outcome--bad'}
          role={note.tone === 'ok' ? 'status' : 'alert'}
        >
          {note.message}
        </p>
      )}

      <ResourcePanel<ProjectBinding[]>
        title="Bound agents"
        collapsible
        resource={resources.bindings}
        emptyMessage="No agents bound to this project"
        isEmpty={(bindings) => bindings.length === 0}
      >
        {(bindings) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  {/*
                   * The free-text role the owner bound the agent with, and the
                   * flow roles (implementer / verifier) the external flow script
                   * reads (ADR 0036). The coordinator is a session claim and
                   * lives on the sessions route, not here.
                   */}
                  <th scope="col">Role</th>
                  <th scope="col">State</th>
                  <th scope="col">Profiles</th>
                  <th scope="col">Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((binding) => {
                  const held = binding.flowRoles ?? [];
                  return (
                    <tr key={binding.id} aria-selected={binding.agentId === selectedAgentId}>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            onSelectAgent?.(
                              binding.agentId === selectedAgentId ? undefined : binding.agentId,
                            )
                          }
                        >
                          {binding.agentId}
                        </button>
                      </td>
                      <td>
                        {binding.role === undefined ? null : (
                          <small title={binding.role}>{binding.role}</small>
                        )}
                        {held.map((role) => (
                          <StatusChip key={role} tone="info">
                            {role}
                          </StatusChip>
                        ))}
                        {projectMutations === undefined
                          ? null
                          : (['implementer', 'verifier'] as const).map((role) => (
                              <button
                                key={role}
                                type="button"
                                className="link-button"
                                aria-pressed={held.includes(role)}
                                disabled={busy === binding.id}
                                onClick={() => void toggleFlowRole(binding, role)}
                                aria-label={`${held.includes(role) ? 'Unset' : 'Set'} ${role} role for ${binding.agentId}`}
                              >
                                {held.includes(role) ? `Unset ${role}` : `Set ${role}`}
                              </button>
                            ))}
                      </td>
                      <td>
                        <StatusChip tone={binding.enabled ? 'success' : 'unknown'}>
                          {binding.enabled ? 'Enabled' : 'Disabled'}
                        </StatusChip>
                      </td>
                      <td>{binding.profileCount}</td>
                      <td>{binding.capabilityCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ResourcePanel>

      {/*
        The project's own skills, instructions, hooks and MCP definitions, as
        the capability scan registered them (ADR 0032 follow-up, 2026-09-11): the
        owner reads what the agents are given here and edits the files where
        `path` says they live. Nothing here executes or rewrites a file.
      */}
      <ResourcePanel<Bounded<ProjectCapability>>
        title="Skills"
        meta={
          <>
            {resources.capabilities?.state === 'ready'
              ? `${String(resources.capabilities.data.items.filter((item) => item.scope === 'project').length)} project · ${String(resources.capabilities.data.items.filter((item) => item.scope === 'global').length)} global`
              : null}
            {capabilityMutations === undefined ? null : (
              <button
                type="button"
                className="link-button"
                disabled={busy === 'rescan'}
                onClick={() => void runCapability('', 'rescan')}
              >
                Rescan
              </button>
            )}
          </>
        }
        collapsible
        resource={resources.capabilities}
        emptyMessage="No capabilities recorded — a capability scan registers them"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Source</th>
                    <th scope="col">State</th>
                    {capabilityMutations === undefined ? null : <th scope="col">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {value.items.map((record) => (
                    <tr key={record.id}>
                      <td>
                        {record.name}
                        {record.path === undefined ? null : (
                          <small title={record.path}>{abbreviatePath(record.path)}</small>
                        )}
                      </td>
                      <td>{record.kind}</td>
                      <td>{record.scope}</td>
                      <td>{record.observed ? `${record.source} · observed` : record.source}</td>
                      <td>
                        <StatusChip tone={record.enabled ? 'success' : 'unknown'}>
                          {record.enabled ? 'Enabled' : 'Disabled'}
                        </StatusChip>
                      </td>
                      {capabilityMutations === undefined ? null : (
                        <td>
                          {/*
                           * An observed package cannot be enabled or disabled
                           * here: its SKILL.md is the truth and the daemon
                           * refuses the update. Assignment is still the
                           * runtime's own record, so it stays.
                           */}
                          {record.observed ? null : (
                            <button
                              type="button"
                              className="link-button"
                              disabled={busy === record.id}
                              onClick={() =>
                                void runCapability(record.id, record.enabled ? 'disable' : 'enable')
                              }
                              aria-label={`${record.enabled ? 'Disable' : 'Enable'} ${record.name}`}
                            >
                              {record.enabled ? 'Disable' : 'Enable'}
                            </button>
                          )}{' '}
                          <button
                            type="button"
                            className="link-button"
                            disabled={busy === record.id}
                            onClick={() => void runCapability(record.id, 'assign')}
                            aria-label={`Assign ${record.name} to ${targetLabel}`}
                          >
                            Assign to {targetLabel}
                          </button>{' '}
                          <button
                            type="button"
                            className="link-button"
                            disabled={busy === record.id}
                            onClick={() => void runCapability(record.id, 'unassign')}
                            aria-label={`Unassign ${record.name} from ${targetLabel}`}
                          >
                            Unassign
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TruncationNote truncated={value.truncated} noun="capabilities" />
          </>
        )}
      </ResourcePanel>

      {/*
        Findings the intelligence layer recorded against this project, from the
        bounded set the Pulse snapshot already carries — no extra read. Acting on
        one is the config plan chain, which stays behind its own confirmation.
      */}
      <ResourcePanel<PulseFinding[]>
        title="Optimization"
        collapsible
        meta={
          snapshot.findingsState === 'ready'
            ? `${String(projectFindings.length)} for this project`
            : undefined
        }
        resource={
          snapshot.findingsState === 'ready'
            ? { state: 'ready', data: projectFindings }
            : { state: 'unavailable' }
        }
        emptyMessage="No structural findings recorded for this project"
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Finding</th>
                    <th scope="col">Kind</th>
                    <th scope="col">State</th>
                    <th scope="col">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.title}
                        <small>{row.summary}</small>
                      </td>
                      <td>{row.kind}</td>
                      <td>
                        <StatusChip tone={findingStateTones[row.state]}>{row.state}</StatusChip>
                      </td>
                      <td>
                        <ConfidenceChip confidence={row.confidence} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="bounded-note">
              <a href="#/optimization">All findings and proposals ›</a>
              {' · '}
              <a href="#/config">Configuration plans ›</a>
            </p>
          </>
        )}
      </ResourcePanel>

      <ResourcePanel<Bounded<ProjectPackage>>
        title="Packages"
        collapsible
        defaultCollapsed
        resource={resources.packages}
        emptyMessage="No package inventory recorded"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Package</th>
                    <th scope="col">Ecosystem</th>
                    <th scope="col">Version</th>
                    <th scope="col">Dependency</th>
                  </tr>
                </thead>
                <tbody>
                  {value.items.map((record) => (
                    <tr key={record.id}>
                      <td>
                        {record.packageName}
                        <small title={record.workspaceLocation}>
                          {abbreviatePath(record.workspaceLocation)}
                        </small>
                      </td>
                      <td>{record.ecosystem}</td>
                      <td>
                        {record.declaredVersion ?? <span className="unavailable">Undeclared</span>}
                      </td>
                      <td>{record.dependencyType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TruncationNote truncated={value.truncated} noun="packages" />
          </>
        )}
      </ResourcePanel>

      <ResourcePanel<Bounded<ProjectTechnology>>
        title="Technologies"
        collapsible
        defaultCollapsed
        resource={resources.technologies}
        emptyMessage="No technologies detected"
        isEmpty={(value) => value.items.length === 0}
      >
        {(value) => (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Technology</th>
                    <th scope="col">Category</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {value.items.map((record) => (
                    <tr key={record.id}>
                      <td>{record.name}</td>
                      <td>{record.category}</td>
                      <td>
                        <ConfidenceChip confidence={record.confidence} />
                      </td>
                      <td>{record.evidenceCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TruncationNote truncated={value.truncated} noun="technologies" />
          </>
        )}
      </ResourcePanel>

      {selectedAgentId === undefined ? null : (
        <AgentPairPanels
          agentId={selectedAgentId}
          resources={agentPairResources}
          loading={agentPairLoading}
        />
      )}
    </div>
  );
}
