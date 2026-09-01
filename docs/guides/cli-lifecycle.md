# LUWI CLI lifecycle guide

The lifecycle commands are the recommended local entry point. They coordinate the existing
daemon and Compose Redis service; they do not install a background service, add a datastore,
or take ownership of native coding agents.

## Golden path

From the LUWI Runtime installation root:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @luwi/cli dev -- doctor
pnpm --filter @luwi/cli dev -- setup
pnpm --filter @luwi/cli dev -- start
pnpm --filter @luwi/cli dev -- status
```

`doctor --json` and `status --json` provide machine-readable output. Human output labels each
diagnostic as `ok`, `warning`, or `error` and includes bounded remediation hints.

After registering a project and matching AgentDefinitions/project bindings, a native tool can
be launched transparently:

```text
pnpm --filter @luwi/cli dev -- agent run claude -- <native arguments>
pnpm --filter @luwi/cli dev -- agent run codex -- <native arguments>
pnpm --filter @luwi/cli dev -- agent run gemini -- <native arguments>
```

The wrapper preserves native arguments and inherited terminal I/O. If LUWI is unavailable it
reports degraded observation and still starts the native tool. `--executable <absolute-path>`
can be used when PATH discovery is unavailable.

Capability discovery is explicit and passive:

```text
pnpm --filter @luwi/cli dev -- capability scan
```

Known Claude, Codex, and Gemini global/project roots plus absolute paths in
`LUWI_CAPABILITY_ROOTS` are inspected. The observer reads bounded `SKILL.md` metadata only. It
does not execute a skill, hook, plugin, script, MCP server, package manager, or discovered
command, and it never writes native files. Blank configured root segments are rejected. Directory
reads, manifest sizes, entry counts, and the total observation duration are bounded.

## Files and ownership

The default LUWI home is `~/.luwi`; set an absolute `LUWI_HOME` before setup to use another
local root. Lifecycle-owned files are:

```text
~/.luwi/runtime/config.json
~/.luwi/runtime/daemon-owner.json
~/.luwi/runtime/daemon.log
```

`runtime/lifecycle.lock` exists only while a mutating lifecycle operation is active. Its atomic
creation serializes `start` and `stop`; waiting for the lock has a bounded deadline.

`config.json` is secret-free and versioned. `daemon-owner.json` contains a private random
shutdown token and is written with restrictive permissions where the platform supports them.
Do not copy or publish the owner file. The token is not an account credential and grants no
remote access; it authorizes graceful shutdown of the one matching loopback daemon instance.

`setup` prints its target and asks before writing. `setup --yes` approves only this LUWI-owned
configuration write. It does not create a real `.env`, edit native-agent configuration, apply
hooks, or delete existing state. `setup --print-hooks` prints wrapper examples for manual use.

## Start behavior

For the exact default `redis://127.0.0.1:6379`, start runs only:

```text
docker compose -f <installation>/compose.yaml up -d --wait redis
```

It then starts `<installation>/apps/daemon/dist/main.js` with Node, waits for the validated
runtime and Redis readiness response, and writes the owner record last. A generated startup
instance identity must match the identity returned by that daemon before ownership is written.
If Redis was already running, a later daemon startup failure leaves it running. If this invocation
started Redis and daemon startup fails, it stops that container with `docker compose stop redis`;
the named volume is retained.

For another credential-free loopback `REDIS_URL`, Redis is treated as external. LUWI starts
only the daemon and never starts or stops the external server. The daemon remains the only
process that speaks the Redis protocol and validates required Redis Functions.

## Stop behavior

```text
pnpm --filter @luwi/cli dev -- stop
```

The CLI validates the owner file, reads the live versioned runtime response, requires the
same `runtimeInstanceId`, and submits the private token to the loopback graceful-stop route.
It never uses an old PID as proof and never kills an unverified process. Redis stays running
by default so the AOF-backed local state remains warm.

To stop Compose Redis without deleting data:

```text
pnpm --filter @luwi/cli dev -- stop --with-redis
```

This uses `docker compose stop redis`, not `down`, `rm`, volume deletion, image deletion, or
pruning. AOF with `appendfsync everysec` reduces local data loss but is not a backup.

## Runtime-only clean installation

Reset is deliberately narrower than Redis administration. It is available only while the owned
daemon and its loopback endpoint are stopped, and its production namespace is compiled as
`luwi:v1:`. First inspect, then approve:

```powershell
pnpm --filter @luwi/cli dev -- doctor --json
pnpm --filter @luwi/cli dev -- status --json
pnpm --filter @luwi/cli dev -- stop
pnpm --filter @luwi/cli dev -- reset --runtime-state --json
pnpm --filter @luwi/cli dev -- reset --runtime-state --yes --json
pnpm --filter @luwi/cli dev -- start
pnpm --filter @luwi/cli dev -- status --json
```

The preview returns `confirmation_required`, `deleted: 0`, and its bounded match count. The apply
returns `reset` or `empty`. This operation destroys LUWI's Redis-owned event history, sessions,
messages, projections, and derived operational state. It preserves `LUWI_HOME`, agent definitions,
canonical projects, native configuration, project and Git files, the Redis database and volume,
and every key outside `luwi:v1:*`. It never calls a database-wide flush.

After restart, inspect the immediate XAMPP children without writing them:

```powershell
pnpm --filter @luwi/cli dev -- project discover C:\xampp\htdocs `
  --exclude dashboard --exclude img --exclude webalizer --exclude xampp `
  --exclude luwi-clients --exclude luwi-themes-inspect `
  --name "arshahomes=Arsha Homes" --name "corenine=Corenine" `
  --name "flybydeniz=Fly by Deniz" --name "glasshouse=Glasshouse" `
  --name "luwi-dev=LUWI Dev" --name "luwilisting=LUWI Listing" `
  --name "luwipress=LUWI Press" --name "luwiruntime=LUWI Runtime" `
  --name "luwistudio=LUWI Studio" --name "semantic-bridge=Semantic Bridge" --json
```

The plan must contain exactly ten `selected` projects and these six `excluded` directory names:
`dashboard`, `img`, `webalizer`, `xampp`, `luwi-clients`, and `luwi-themes-inspect`. It must contain
no unexpected or invalid candidates. Repeat the command with `--apply` to register only missing
paths and refresh read-only local Git observations. Existing canonical paths remain `unchanged`;
Glasshouse is expected to report `not_git`. Discovery is not recursive and never scans package
scripts, hooks, plugins, MCP servers, or project file contents.

## Safe recovery

- **Daemon port occupied:** `doctor` reports an incompatible listener. Identify it manually;
  LUWI will not kill it.
- **Healthy unmanaged daemon:** `start` reports success without adopting it. Stop it through
  the process manager or terminal that started it.
- **Stale owner file and closed port:** `stop` may remove the generated stale record because
  it has proved there is no listener to terminate.
- **Corrupt or mismatched owner file:** stop refuses. Preserve the file and inspect
  `runtime/daemon.log`; do not replace it with a guessed PID or token.
- **Redis unavailable:** start is bounded and reports a safe failure. For Compose, inspect
  `docker compose ps redis`; for external Redis, start the configured loopback server.
- **Daemon build missing:** run `pnpm build` and retry.
- **Lifecycle busy:** wait for the active `start` or `stop` command and retry. If a CLI
  process was forcibly terminated, first verify that no LUWI lifecycle command is still active;
  only then may the generated `runtime/lifecycle.lock` file be removed before retrying.

All lifecycle endpoints and listeners remain loopback-only. No login, cloud account, remote
binding, autonomous agent manager, prompt injection, or native configuration rewrite is part
of this path.
