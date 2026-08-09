import type {
  Bounded,
  ProjectBinding,
  ProjectGit,
  ProjectPackage,
  ProjectScopeResources,
  ProjectTechnology,
} from '../api/project-scope.js';
import { abbreviatePath, abbreviateSha } from '../components/format.js';
import { ConfidenceChip, Count, Panel, ResourcePanel } from '../components/panel.js';
import { StatusChip } from '../components/status-chip.js';
import type { PulseSnapshot } from '../pulse/model.js';

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

export function ProjectsView({
  snapshot,
  selectedProjectId,
  resources,
  scopeLoading,
  onSelectProject,
}: {
  snapshot: PulseSnapshot;
  selectedProjectId?: string | undefined;
  resources: Partial<ProjectScopeResources>;
  scopeLoading: boolean;
  onSelectProject: (projectId: string) => void;
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
                      <tr key={binding.id}>
                        <td>
                          <code>{binding.agentId}</code>
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
