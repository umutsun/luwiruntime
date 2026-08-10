import type {
  AgentPairResources,
  ContextFootprint,
  EffectiveConfig,
  PairContextSummary,
} from '../api/agent-pair-scope.js';
import type {
  Bounded,
  ProjectAttribution,
  ProjectBinding,
  ProjectGit,
  ProjectPackage,
  ProjectScopeResources,
  ProjectTechnology,
  ProjectWorktree,
} from '../api/project-scope.js';
import { abbreviatePath, abbreviateSha } from '../components/format.js';
import {
  AttributionConfidenceChip,
  ConfidenceChip,
  Count,
  Panel,
  ResourcePanel,
} from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';

/**
 * How many branch or tag names one panel shows.
 *
 * This is a display bound, not a read bound. The observation delivers both
 * arrays complete, so the sentence below says "showing the first N of M"
 * rather than borrowing `TruncationNote`, which asserts the different and
 * stronger fact that records exist which were never read.
 */
const NAME_LIST_LIMIT = 25;

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

function NameList({ names, label, noun }: { names: string[]; label: string; noun: string }) {
  return (
    <>
      <GroupLabel label={label} count={names.length} />
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
    </>
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

function RepositoryBody({ git }: { git: ProjectGit }) {
  return (
    <div className="project-detail__body">
      <dl className="key-values">
        <div>
          <dt>Branch</dt>
          <dd>{git.branch ?? <span className="unavailable">Unknown</span>}</dd>
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
          <dt>Root</dt>
          <dd>
            <small title={git.repositoryRoot}>{abbreviatePath(git.repositoryRoot)}</small>
          </dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>{git.observedAt}</dd>
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
      <GroupLabel label="Worktrees" count={git.worktrees.length} />
      {git.worktrees.length === 0 ? (
        <p className="empty-state">No worktrees recorded</p>
      ) : (
        <WorktreeTable worktrees={git.worktrees} />
      )}
      <GroupLabel label="Recent commits" count={git.recentCommits.length} />
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
              {git.recentCommits.slice(0, 10).map((commit) => (
                <tr key={commit.sha}>
                  <td>
                    <code title={commit.sha}>{abbreviateSha(commit.sha)}</code>
                  </td>
                  <td>{commit.subject ?? <span className="unavailable">No subject</span>}</td>
                  <td>{commit.changedPathCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

            <GroupLabel label="Capabilities" count={config.capabilities.length} />
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

            <GroupLabel label="Profiles" count={config.profileIds.length} />
            {config.profileIds.length === 0 ? (
              <p className="empty-state">No profiles applied</p>
            ) : (
              <ul className="name-list">
                {config.profileIds.map((profileId) => (
                  <li key={profileId}>{profileId}</li>
                ))}
              </ul>
            )}

            <GroupLabel label="Conflicts" count={config.conflicts.length} />
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
                          {conflict.capabilityId ?? <span className="unavailable">Not scoped</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <GroupLabel label="Missing dependencies" count={config.missingDependencies.length} />
            {config.missingDependencies.length === 0 ? (
              <p className="empty-state">No missing dependencies</p>
            ) : (
              <ul className="name-list">
                {config.missingDependencies.map((dependency) => (
                  <li key={dependency}>{dependency}</li>
                ))}
              </ul>
            )}

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
  onSelectProject,
  onSelectAgent,
}: {
  snapshot: PulseSnapshot;
  selectedProjectId?: string | undefined;
  selectedAgentId?: string | undefined;
  resources: Partial<ProjectScopeResources>;
  scopeLoading: boolean;
  agentPairResources?: Partial<AgentPairResources>;
  agentPairLoading?: boolean;
  onSelectProject: (projectId: string) => void;
  onSelectAgent?: (agentId: string | undefined) => void;
}) {
  const projectsAvailable = snapshot.projectCount.state !== 'unavailable';
  const selected = snapshot.projects.find((project) => project.id === selectedProjectId);
  const projectSessions = snapshot.sessions.filter(
    (session) => session.projectId === selectedProjectId,
  );

  return (
    <div className="projects-stack">
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
                  <th scope="col">Active sessions</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.projects.map((project) => (
                  <tr key={project.id} aria-selected={project.id === selectedProjectId}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => onSelectProject(project.id)}
                      >
                        {project.name}
                      </button>
                      <small title={project.localPath}>{abbreviatePath(project.localPath)}</small>
                    </td>
                    <td>
                      <Count value={project.activeSessions} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedProjectId === undefined ? (
        <p className="empty-state">Select a project to load its scoped evidence.</p>
      ) : selected === undefined ? (
        <p className="empty-state">Project not found in the current snapshot.</p>
      ) : scopeLoading ? (
        <p className="empty-state">Loading project evidence…</p>
      ) : (
        <div className="project-detail">
          <ResourcePanel<ProjectGit>
            title="Repository"
            resource={resources.git}
            notObservedMessage="Not observed — no Git scan has been recorded for this project."
            emptyMessage="No repository detail"
            isEmpty={() => false}
          >
            {(git) => <RepositoryBody git={git} />}
          </ResourcePanel>

          <ResourcePanel<Bounded<ProjectAttribution>>
            title="Commit attribution"
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
                                {record.agentId ?? (
                                  <span className="unavailable">Unknown agent</span>
                                )}
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
                  Attribution is observed, not asserted. A commit the runtime could not tie to a
                  session stays unattributed rather than being assigned a guess, and the reason
                  column says why it could not.
                </p>
                <TruncationNote truncated={value.truncated} noun="attributions" />
              </>
            )}
          </ResourcePanel>

          <ResourcePanel<ProjectBinding[]>
            title="Bound agents"
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
                      <th scope="col">State</th>
                      <th scope="col">Profiles</th>
                      <th scope="col">Capabilities</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bindings.map((binding) => (
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
                          <StatusChip tone={binding.enabled ? 'success' : 'unknown'}>
                            {binding.enabled ? 'Enabled' : 'Disabled'}
                          </StatusChip>
                        </td>
                        <td>{binding.profileCount}</td>
                        <td>{binding.capabilityCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ResourcePanel>

          <ResourcePanel<Bounded<ProjectPackage>>
            title="Packages"
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
                            {record.declaredVersion ?? (
                              <span className="unavailable">Undeclared</span>
                            )}
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

          <Panel title="Sessions">
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
        </div>
      )}
    </div>
  );
}
