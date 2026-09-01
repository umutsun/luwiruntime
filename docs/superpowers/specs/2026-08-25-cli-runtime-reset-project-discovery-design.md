# CLI Runtime Reset and Project Discovery Design

**Date:** 2026-08-25

**Status:** Approved design, awaiting written-spec review

## Context

LUWI Runtime needs a repeatable clean-install path without treating a shared Redis database as
disposable. Other local applications may use the same Redis listener, so database-wide commands,
container-volume deletion, and broad key patterns are unacceptable.

The developer's projects are immediate children of `C:\xampp\htdocs`. The intended project set is:

| Directory         | Display name    |
| ----------------- | --------------- |
| `arshahomes`      | Arsha Homes     |
| `corenine`        | Corenine        |
| `flybydeniz`      | Fly by Deniz    |
| `glasshouse`      | Glasshouse      |
| `luwi-dev`        | LUWI Dev        |
| `luwilisting`     | LUWI Listing    |
| `luwipress`       | LUWI Press      |
| `luwiruntime`     | LUWI Runtime    |
| `luwistudio`      | LUWI Studio     |
| `semantic-bridge` | Semantic Bridge |

These directories are deliberately excluded:

- XAMPP-owned or utility directories: `dashboard`, `img`, `webalizer`, and `xampp`;
- LUWI Press spillover directories: `luwi-clients` and `luwi-themes-inspect`.

The current filesystem-canonical global LUWI manifest already contains the ten intended projects,
including their stable IDs and registered repository metadata. A runtime-state reset must preserve
that manifest and all native project repositories. The current startup reconciliation restores
agent and capability projections but does not yet restore missing project projections; this design
adds that prerequisite before any project-scoped control-plane reconciliation runs.

## Goals

- Reset only LUWI Runtime operational state stored under the exact `luwi:v1:` Redis namespace.
- Preserve every non-LUWI Redis key, the Redis database, persistence files, container, and volume.
- Preserve `LUWI_HOME` configuration, AgentDefinitions, project manifests, project IDs, and native
  agent configuration.
- Discover immediate project directories under an explicitly supplied root without executing code.
- Preview every reset and discovery mutation before it can be applied.
- Register or reconcile the exact ten intended projects with correct display names.
- Rebuild Redis projections from filesystem-canonical manifests after reset.
- Keep the implementation CLI-first, loopback-only, dependency-free, and repeatable.

## Non-goals

- This is not a factory reset of `LUWI_HOME`.
- This does not run `FLUSHDB`, `FLUSHALL`, `docker compose down`, volume deletion, or Redis pruning.
- This does not delete sessions or events belonging to another Redis namespace.
- This does not recursively scan `C:\xampp\htdocs`.
- This does not execute package managers, project scripts, hooks, plugins, MCP servers, or native
  agent configuration.
- This does not automatically scan project roots on daemon startup.
- This does not write to any project directory or Git repository.
- This does not add a datastore, Redis module, background service, or production dependency.

## Chosen approach

Add two explicit CLI surfaces:

```text
luwi reset --runtime-state [--yes] [--json]
luwi project discover <absolute-root> [--exclude <directory>]... [--name <directory=display-name>]... [--apply] [--json]
```

The reset is an explicit maintenance operation. Project discovery is a dry run unless `--apply` is
present. Neither behavior runs automatically during normal daemon startup.

This is preferred over a one-off shell script because the safety boundary becomes testable and
repeatable. It is preferred over automatic startup discovery because registration remains visible,
reviewable, and user-controlled.

## Runtime reset architecture

### Package boundary

The CLI must not become a Redis client. The maintenance implementation lives in `@luwi/daemon`, the
existing composition boundary allowed to depend on `@luwi/redis`. The CLI launches a bounded daemon
maintenance entry point only after validating lifecycle state and receiving explicit confirmation.
The maintenance process uses the existing official Redis client integration.

No browser, native coding agent, Session Bridge, or MCP process receives Redis access.

### Preconditions

`luwi reset --runtime-state`:

1. loads the same loopback-only lifecycle configuration as `start`, `stop`, and `doctor`;
2. refuses credential-bearing or non-loopback Redis URLs under the existing lifecycle rules;
3. refuses while a compatible daemon is running;
4. refuses while the daemon port is occupied by an incompatible listener;
5. refuses when a live lifecycle lock exists;
6. verifies that the daemon maintenance build entry exists;
7. scans and reports the candidate LUWI key count before asking for confirmation.

The user runs `luwi stop` first. Reset does not silently stop or kill a process.

### Namespace enumeration

The maintenance process uses cursor-based `SCAN` with the exact match pattern `luwi:v1:*`. Every
returned key is treated as untrusted Redis data and is validated again with
`key.startsWith("luwi:v1:")` before it can enter a deletion batch.

The command never uses `KEYS`, a database-wide command, an unresolved glob, or a user-controlled
namespace. The namespace is a code constant for version 1.

### Confirmation and output

Interactive output shows:

- Redis endpoint without credentials;
- exact namespace;
- number of matching keys;
- preserved `LUWI_HOME` path;
- a warning that LUWI sessions, messages, events, projections, and derived views will be erased.

Without `--yes`, the human-readable CLI requires an exact affirmative confirmation. Refusal exits
without writing. `--yes` is intended for reviewed automation and authorizes only the fixed namespace
deletion. `--json` never prompts: without `--yes` it returns a versioned `confirmation_required`
result and performs no deletion. JSON results include `matched`, `deleted`, `namespace`, and `status`
fields.

### Deletion and failure behavior

After confirmation, validated keys are deleted in bounded batches using standard Redis `UNLINK`
when available through the existing Redis client. The daemon remains stopped, so LUWI cannot create
new namespace keys during the operation.

Reset is idempotent. A Redis loss after some batches may produce a partial reset; the command reports
the exact deleted count, exits non-zero, and does not start the daemon. Rerunning the same command
deletes the remaining matching keys. It never attempts to compensate by restoring or touching other
keys.

An empty namespace is a successful no-op after confirmation.

### Canonical rebuild

The reset preserves:

- `LUWI_HOME/runtime/config.json`;
- the global LUWI manifest containing the project catalog;
- `LUWI_HOME/agents/*.json` AgentDefinitions;
- project-local `.luwi` manifests;
- native Claude, Codex, and Gemini configuration.

After `luwi start`, the existing owned-startup reconciliation validates canonical manifests and
first restores every canonical project projection with its existing ID, name, paths, timestamps, and
registered repository metadata. It canonicalizes each path again and fails readiness with
`CONFIG_RECONCILIATION_REQUIRED` if a directory is missing, escapes its recorded path, or conflicts
with another projected identity. Only after projects exist does startup rebuild project-scoped
agent, capability, profile, binding, configuration, Git, package, and graph projections. The ten
existing project IDs remain stable because reset never regenerates the filesystem-canonical project
catalog.

## Project discovery architecture

### Read boundary

`luwi project discover <absolute-root>` validates and canonicalizes the supplied root, then reads
only its immediate directory entries. It does not recurse or follow a child whose resolved path
escapes the canonical root. Directory names, resolved paths, and filesystem errors are bounded and
reported as data.

Discovery never reads file contents merely to decide whether a directory is a project. This allows
an intentional non-Git project such as `glasshouse` to be included while keeping the command passive.

### Selection rules

Every immediate child is a candidate unless its directory basename exactly matches a repeated
`--exclude` value. Matching is case-insensitive on Windows and case-sensitive on case-sensitive
platforms. Exclusions do not accept globs or path separators.

The clean-install invocation supplies these six exclusions explicitly:

```text
dashboard
img
webalizer
xampp
luwi-clients
luwi-themes-inspect
```

The dry-run output groups entries as selected, excluded, invalid, or unreadable and prints the ten
selected canonical paths before any HTTP mutation.

### Display names

For a path already present in the filesystem-canonical project catalog, discovery preserves the
existing display name and stable project ID. A new path defaults to its directory basename.

A repeated exact `--name <directory=display-name>` option overrides the proposed name for a selected
directory. Both sides must be non-empty; the directory side must be an immediate child basename and
must not contain a path separator. Duplicate or conflicting overrides fail before mutation.

The clean-install verification requires the ten display names listed in this document. This avoids
guessing word boundaries in names such as `arshahomes` and `flybydeniz`.

### Apply behavior

Without `--apply`, discovery is read-only. With `--apply`, the CLI submits selected projects through
the existing versioned daemon HTTP API; it never writes Redis directly.

Canonical-path reconciliation is idempotent:

- a path already registered with the same intended facts is reported as `unchanged`;
- a path already registered with conflicting facts is reported as `conflict` and is not silently
  overwritten;
- a new path is registered and persisted through the existing filesystem-canonical project path;
- one failure does not hide already applied results, and rerunning the same plan is safe.

The result lists `registered`, `unchanged`, `conflict`, and `failed` entries. Discovery does not
silently adopt excluded or unreadable directories.

### Repository observation

Project registration and Git observation remain separate evidence steps. After registration, the
existing daemon Git scan is invoked for each selected project through HTTP. It uses the existing
read-only Git allowlist, exact safe-directory setting, disabled repository `core.fsmonitor`, bounded
timeouts, output limits, and credential redaction.

`glasshouse` is reported as `not a Git repository`, not as a failed project registration. Registered
repository metadata and observed Git metadata remain separately labelled in the dashboard.

## Clean-install sequence

The approved operational sequence is:

1. run `luwi doctor` and record the pre-reset status;
2. run `luwi stop` without `--with-redis`;
3. run `luwi reset --runtime-state` and review the fixed namespace/count prompt;
4. run `luwi setup` to validate the preserved lifecycle configuration;
5. run `luwi start` and wait for validated daemon and Redis readiness;
6. run project discovery against `C:\xampp\htdocs` with the six explicit exclusions;
7. review the ten-entry dry run and then repeat it with `--apply`;
8. verify the ten exact names, canonical paths, and stable IDs through CLI and HTTP;
9. verify Codex, Claude, and Gemini definitions were rebuilt from canonical files;
10. run bounded Git/package/technology observations for the ten projects;
11. run the three-agent request/reply smoke test;
12. run `luwi doctor`, `luwi status --json`, dashboard checks, and the full repository quality gate.

Redis remains running during the reset. Docker Compose is used only when it owns the configured
default Redis service; an existing external loopback Redis service is never stopped or reconfigured.

## Security and safety invariants

- The only deletable keys begin with the compile-time constant `luwi:v1:`.
- `FLUSHDB`, `FLUSHALL`, database selection changes, volume deletion, and container removal are
  forbidden and covered by tests.
- A non-LUWI sentinel key in the same Redis database must survive every integration test.
- Reset requires the daemon to be stopped and uses the existing lifecycle lock.
- Project discovery is dry-run by default and non-recursive.
- Project paths are canonicalized; escaping links and non-directory entries are rejected.
- No project, Git, native-agent, or `.luwi` file is written by discovery itself.
- API errors contain safe codes and identifiers, not Redis credentials or stack traces.
- Logs contain counts and structured IDs, not prompts, environment dumps, or secret-bearing URLs.

## Testing strategy

### Unit tests

- reset refuses a running, unmanaged, mismatched, or incompatible daemon state;
- reset confirmation refusal performs no maintenance spawn;
- `--yes` still fixes the namespace and cannot accept a caller-provided pattern;
- namespace validation rejects every non-`luwi:v1:` key returned by an injected reader;
- empty, complete, and partial reset results are rendered safely in human and JSON modes;
- startup restores missing project projections from canonical projects before rebuilding dependent
  bindings and rejects path or ID conflicts;
- normal startup treats an already matching project projection as unchanged and emits no duplicate
  registration event;
- discovery is non-recursive and applies exact Windows basename matching;
- exclusions reject globs, separators, blanks, duplicates, and missing children;
- name overrides preserve exact display names and reject conflicts;
- dry-run performs no HTTP mutation;
- apply classifies registered, unchanged, conflict, and failed results;
- Git-not-present remains a successful project with unavailable repository observation.

### Redis integration tests

Using an explicit `LUWI_TEST_REDIS_URL`, a unique per-run prefix, and only test-owned keys:

- seed LUWI-like keys plus a non-LUWI sentinel in the same test database;
- reset all matching test-namespace keys and prove the sentinel survives;
- simulate a bounded batch failure and prove rerun removes only the remainder;
- prove an empty namespace is idempotent;
- never flush or clean unrelated keys.

The production namespace constant and the test prefix are injected at the daemon maintenance
boundary so integration tests cannot touch developer data.

### End-to-end acceptance

- lifecycle stop/reset/setup/start completes without writing outside LUWI-owned state;
- startup restores the same ten project UUIDs from the preserved canonical manifest;
- the API returns exactly ten projects with the approved names and paths;
- the two LUWI Press spillover directories and four XAMPP directories are absent;
- nine Git repositories have observations and `glasshouse` has an explicit non-Git result;
- Codex, Claude, and Gemini are registered and available for the existing smoke flow;
- a non-LUWI Redis sentinel remains byte-for-byte unchanged;
- format, lint, typecheck, unit tests, relevant Redis integration tests, and production build pass.

## Documentation

Update the lifecycle guide and README with:

- the difference between runtime-state reset and factory reset;
- the exact Redis namespace guarantee;
- the requirement to stop the daemon first;
- dry-run-first project discovery examples for PowerShell;
- the explicit XAMPP exclusions used in this installation;
- recovery steps for partial reset, discovery conflicts, and unavailable Git observations.

## Known limits

- Runtime reset intentionally destroys LUWI operational history; it is not a backup or rollback
  feature.
- Discovery handles one directory level only.
- Display-name word boundaries are never guessed; new ambiguous names require `--name`.
- Project removal is not part of discovery or this clean-install scope.
- Redis credentials and remote Redis endpoints remain unsupported in local lifecycle mode.
