/**
 * Seeds a LUWI runtime with representative data over the daemon's own HTTP API.
 *
 * Why this exists: the 2026-08-09 UI audit's item 10 listed five read-only
 * domains the dashboard did not consume, and ADR 0017 deferred four of them
 * because the developer runtime held zero records for each. A dashboard route
 * over an empty domain cannot be verified by looking at it, and this repository
 * has already shipped defects that passed their tests and were wrong on screen.
 * This script removes that excuse.
 *
 * It is verification tooling, not product surface. It talks HTTP only — no
 * Redis client, no direct key writes — so what it produces has passed the same
 * validation a real agent's traffic would.
 *
 * ## Isolating it takes more than a Redis database
 *
 * Pointing the daemon at `redis://…/15` is not enough, and finding that out
 * cost a real cleanup. ADR 0007 makes the **filesystem** canonical for agent
 * definitions, capability packages, and profiles: those are written to
 * `LUWI_HOME` and rebuilt into Redis on startup, so they survive a `FLUSHDB`
 * and land in the developer's own `~/.luwi` unless `LUWI_HOME` is redirected.
 * The config plan chain goes further and writes native agent configuration on
 * apply, which is why `LUWI_NATIVE_HOME` matters too.
 *
 * A fixture therefore needs all four of these, and this script refuses to run
 * until it can prove the daemon has them:
 *
 *   REDIS_URL=redis://127.0.0.1:6379/15   disposable database
 *   LUWI_HOME=<fixture>/home              canonical manifests
 *   LUWI_NATIVE_HOME=<fixture>/native     native agent configuration
 *   WORKSPACE_ID=fixture-<anything>       the handshake this script checks
 *
 * `WORKSPACE_ID` is the enforcement point because it is the only one of the
 * four the daemon reports back over HTTP (`GET /api/v1/runtime`). Setting it
 * cannot make a run safe on its own — it is a declaration that the operator
 * configured the other three. That is the honest limit of what this script can
 * verify from outside the daemon.
 *
 * Every path the script hands the daemon lives under a temporary directory it
 * creates itself, so project-scoped records stay in the fixture too.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const daemonUrl = process.env.LUWI_SEED_DAEMON_URL ?? 'http://127.0.0.1:4782';
const FIXTURE_WORKSPACE_PREFIX = 'fixture';
const PROJECT_NAME = 'Seeded Workspace';
/** The one seeded capability whose record names the project that owns it. */
const PROJECT_SCOPED_CAPABILITY_ID = 'seed-cap-migrate';

function refuse(reason: string): never {
  console.error(
    [
      `Refusing to seed: ${reason}`,
      '',
      'This writes into whatever runtime the daemon is attached to — Redis, the',
      'canonical LUWI home, and native agent configuration. There is no undo.',
      'Start a fixture daemon first:',
      '',
      '  REDIS_URL=redis://127.0.0.1:6379/15 \\',
      '  LUWI_HOME=/tmp/luwi-fixture/home \\',
      '  LUWI_NATIVE_HOME=/tmp/luwi-fixture/native \\',
      '  WORKSPACE_ID=fixture-local \\',
      '  pnpm dev',
      '',
      '  LUWI_SEED_CONFIRM=1 pnpm seed',
      '',
      `Target: ${daemonUrl}`,
    ].join('\n'),
  );
  process.exit(1);
}

if (process.env.LUWI_SEED_CONFIRM !== '1') refuse('LUWI_SEED_CONFIRM=1 is not set.');

/**
 * Stops on a condition the operator has to clear, without the "start a fixture
 * daemon" advice `refuse` gives — by the time this fires the daemon is already
 * the right one and the remedy is something else entirely.
 */
function halt(lines: string[]): never {
  console.error(['Stopping:', ...lines].join('\n'));
  process.exit(1);
}

type Json = Record<string, unknown>;

let stepCount = 0;

async function call<T = Json>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  options: { tolerateConflict?: boolean } = {},
): Promise<T> {
  const response = await fetch(`${daemonUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (response.status === 409 && options.tolerateConflict === true) {
    // Records created with a deterministic id already exist. Treated as success
    // so a partial run can be resumed rather than restarted from an empty
    // database, which matters because the earlier steps are the slow ones.
    return {} as T;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${String(response.status)} ${text}`);
  }
  return (text === '' ? {} : JSON.parse(text)) as T;
}

function step(message: string): void {
  stepCount += 1;
  console.log(`${String(stepCount).padStart(2, ' ')}. ${message}`);
}

/**
 * Timestamps are spread across a window rather than all set to now, so the
 * dashboard's ordering, duration, and "observed at" columns show something
 * other than one repeated value.
 */
const now = Date.now();
const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();

async function main(): Promise<void> {
  const health = await call<{ runtimeState: string }>('GET', '/health');
  if (health.runtimeState !== 'ready') {
    throw new Error(`Daemon is not ready: ${health.runtimeState}`);
  }

  const runtime = await call<{ workspaceId: string }>('GET', '/api/v1/runtime');
  if (!runtime.workspaceId.startsWith(FIXTURE_WORKSPACE_PREFIX)) {
    refuse(
      `the daemon reports workspaceId "${runtime.workspaceId}", which is not a fixture. ` +
        'A default workspace means the daemon is almost certainly writing to the real ' +
        '~/.luwi and the working Redis database.',
    );
  }
  step(`fixture daemon confirmed: workspaceId "${runtime.workspaceId}"`);

  /**
   * Deterministic, not a fresh temp directory per run.
   *
   * The project record is reused across runs and stores its `localPath`. A new
   * `mkdtemp` each time leaves that path pointing at the previous run's
   * workspace, and the config apply then refuses with CONFIG_PLAN_PATH_ESCAPE
   * because the plan targets a directory outside the project it belongs to.
   */
  const workspace = join(tmpdir(), 'luwi-seed-workspace');
  await mkdir(workspace, { recursive: true });
  const nativeDir = join(workspace, 'agent-config');
  const projectDir = join(workspace, 'project');
  await mkdir(nativeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  // Something real for the adapter to inspect. It is read, never executed.
  await writeFile(
    join(nativeDir, 'AGENTS.md'),
    '# Seeded instructions\n\nThis file exists so the context scan has a real source to read.\n',
    'utf8',
  );
  await writeFile(
    join(projectDir, 'package.json'),
    `${JSON.stringify({ name: 'seeded-workspace', version: '1.0.0', dependencies: { zod: '^4.0.0' } }, undefined, 2)}\n`,
    'utf8',
  );
  const nativeRoot = nativeDir.replaceAll('\\', '/');
  const projectRoot = projectDir.replaceAll('\\', '/');

  // A real repository, because the Git observation, commit list and attribution
  // reads all refuse a directory that is not one — and attribution is the whole
  // reason the Projects route has a panel for it.
  const git = (...args: string[]): void => {
    const result = spawnSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
  };
  if (!existsSync(join(projectDir, '.git'))) {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Seed Script');
    git('config', 'user.email', 'seed@luwi.invalid');
    git('add', '.');
    git('commit', '-m', 'chore: seed the fixture workspace');
    await writeFile(join(projectDir, 'README.md'), '# Seeded Workspace\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'docs: add a second commit so the history is not a single point');
    git('tag', 'v0.1.0');
    git('branch', 'feature/seeded-branch');
  }

  step(`fixture workspace at ${workspace}`);

  // --- Phase 1: project and agents -----------------------------------------

  /**
   * Reuses the project a previous run registered.
   *
   * The fixture's `LUWI_HOME` outlives any one run, and project-scoped
   * capabilities record the id of the project that owned them. Registering a
   * fresh project on every run therefore orphans them, and the next assignment
   * fails with CAPABILITY_CONFLICT rather than anything that names the real
   * cause. Reusing the project makes the whole script idempotent.
   */
  const registry = await call<{ projects: Array<{ id: string; name: string }> }>(
    'GET',
    '/api/v1/projects',
  );
  const reused = registry.projects.find(({ name }) => name === PROJECT_NAME);
  const project =
    reused ??
    (await call<{ id: string }>('POST', '/api/v1/projects', {
      name: PROJECT_NAME,
      localPath: projectRoot,
      defaultBranch: 'main',
    }));
  step(`project ${project.id}${reused === undefined ? '' : ' (reused)'}`);

  /**
   * Reuse only works while the previous project is still in the registry.
   *
   * The two halves of the fixture can be cleared independently: `FLUSHDB` drops
   * the project while `LUWI_HOME` keeps the project-scoped capability that
   * names it, because ADR 0007 makes that one filesystem-canonical. The next
   * run then registers a fresh project and the assignment fails with a bare
   * CAPABILITY_CONFLICT that names neither the cause nor the fix. Detecting it
   * here costs one read and turns it into an instruction.
   */
  const registered = await call<{ capabilities: Array<{ id: string; projectId?: string }> }>(
    'GET',
    '/api/v1/capabilities?limit=1000',
  );
  const orphan = registered.capabilities.find(
    (capability) =>
      capability.id === PROJECT_SCOPED_CAPABILITY_ID &&
      capability.projectId !== undefined &&
      capability.projectId !== project.id,
  );
  if (orphan !== undefined) {
    halt([
      `  capability ${PROJECT_SCOPED_CAPABILITY_ID} belongs to project ${String(orphan.projectId)},`,
      `  but this run registered ${project.id}.`,
      '',
      "The fixture's Redis database and its LUWI_HOME have drifted apart: one was",
      'cleared and the other was not. No API reassigns a capability, so reset both',
      'halves together and seed again — stop the daemon, remove the fixture LUWI_HOME',
      'and the seed workspace, and FLUSHDB the fixture Redis database.',
    ]);
  }

  const agents = [
    {
      id: 'seed-codex',
      kind: 'codex',
      displayName: 'Codex (seeded)',
      adapterId: 'codex-native-v1',
    },
    {
      id: 'seed-claude',
      kind: 'claude-code',
      displayName: 'Claude Code (seeded)',
      adapterId: 'claude-code-native-v1',
    },
  ] as const;

  for (const agent of agents) {
    await call(
      'POST',
      '/api/v1/agents',
      {
        id: agent.id,
        kind: agent.kind,
        displayName: agent.displayName,
        enabled: true,
        adapterId: agent.adapterId,
        // The project root is a config root too, because a render plan targets
        // `<project>/.claude/settings.json` and the apply refuses any path that
        // is not inside a declared root — CONFIG_PLAN_PATH_ESCAPE.
        nativeConfigRoots: [nativeRoot, projectRoot],
        metadata: {},
      },
      { tolerateConflict: true },
    );
  }
  step(`${String(agents.length)} agent definitions`);

  // --- Phase 3: capabilities, profiles, bindings ----------------------------

  const capabilities = [
    {
      id: 'seed-cap-review',
      kind: 'skill',
      name: 'Code review',
      scope: 'global',
      source: 'luwi-global',
      compatibleAgentKinds: ['codex', 'claude-code'],
    },
    {
      id: 'seed-cap-search',
      kind: 'mcp',
      name: 'Repository search',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: ['codex', 'claude-code'],
    },
    {
      id: PROJECT_SCOPED_CAPABILITY_ID,
      kind: 'plugin',
      name: 'Schema migration',
      scope: 'project',
      projectId: project.id,
      source: 'luwi-project',
      compatibleAgentKinds: ['codex'],
    },
  ] as const;

  for (const capability of capabilities) {
    await call(
      'POST',
      '/api/v1/capabilities',
      {
        ...capability,
        version: '1.0.0',
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
        manifest: { seeded: true },
      },
      { tolerateConflict: true },
    );
  }
  step(`${String(capabilities.length)} capability packages`);

  await call(
    'POST',
    '/api/v1/profiles',
    {
      id: 'seed-profile-reviewer',
      name: 'Reviewer',
      scope: 'global',
      capabilityIds: ['seed-cap-review', 'seed-cap-search'],
      policyIds: [],
      disabledCapabilityIds: [],
      adapterSettings: {},
    },
    { tolerateConflict: true },
  );
  step('capability profile');

  const bindings: string[] = [];
  for (const capabilityId of ['seed-cap-review', 'seed-cap-migrate'] as const) {
    const binding = await call<{ id: string }>(
      'POST',
      `/api/v1/capabilities/${capabilityId}/assign`,
      {
        scope: 'project',
        projectId: project.id,
        agentId: 'seed-codex',
        enabled: true,
        settings: {},
      },
    );
    bindings.push(binding.id);
  }
  step(`${String(bindings.length)} capability bindings`);

  await call(
    'POST',
    `/api/v1/projects/${project.id}/agents`,
    {
      agentId: 'seed-codex',
      enabled: true,
      role: 'primary',
      profileIds: ['seed-profile-reviewer'],
      capabilityBindingIds: bindings,
      overrides: {},
    },
    { tolerateConflict: true },
  );
  await call(
    'POST',
    `/api/v1/projects/${project.id}/agents`,
    {
      agentId: 'seed-claude',
      enabled: true,
      role: 'reviewer',
      profileIds: ['seed-profile-reviewer'],
      capabilityBindingIds: [],
      overrides: {},
    },
    { tolerateConflict: true },
  );
  step('2 project-agent bindings');

  // --- Phase 1: sessions ----------------------------------------------------

  const sessions: Record<string, string> = {};
  for (const agent of agents) {
    const session = await call<{ id: string }>('POST', '/api/v1/sessions', {
      projectId: project.id,
      agentId: agent.id,
      workingDirectory: projectRoot,
      taskSummary: `Seeded session for ${agent.displayName}`,
      branch: 'main',
      metadata: {},
    });
    sessions[agent.id] = session.id;
  }
  step(`${String(Object.keys(sessions).length)} sessions`);

  // --- Phase 2: messages ----------------------------------------------------

  const codexSession = sessions['seed-codex'] ?? '';
  const claudeSession = sessions['seed-claude'] ?? '';

  /**
   * Drives one message from requested to a terminal state.
   *
   * A message is not acknowledgeable until it has been delivered, and delivery
   * is the target session claiming it from its own inbox — the same path the
   * Session Bridge takes. Skipping the claim is what makes `acknowledge` answer
   * MESSAGE_TRANSITION_INVALID.
   */
  const claim = async (sessionId: string): Promise<void> => {
    await call('POST', `/api/v1/sessions/${sessionId}/inbox/claim`, {
      bridgeInstanceId: 'seed-bridge',
      limit: 10,
      blockMs: 1_000,
      minIdleMs: 0,
    });
  };

  const answered = await call<{ message: { correlationId: string } }>('POST', '/api/v1/messages', {
    sourceSessionId: codexSession,
    targetSessionId: claudeSession,
    kind: 'question',
    subject: 'Which module owns the retention sweep?',
    content:
      'I am about to change the stream trimming interval and want to know which module owns retention so I do not duplicate it.',
    evidenceRequirements: ['session_state'],
  });
  await claim(claudeSession);
  await call('POST', `/api/v1/messages/${answered.message.correlationId}/acknowledge`, {
    responderSessionId: claudeSession,
  });
  await call('POST', `/api/v1/messages/${answered.message.correlationId}/respond`, {
    responderSessionId: claudeSession,
    response: {
      status: 'answered',
      answer:
        'Retention lives in the background worker, not in the append path. Change the interval there and leave the appender alone.',
      confidence: 0.9,
      evidence: [],
      verifiedAt: at(4),
    },
  });

  const rejected = await call<{ message: { correlationId: string } }>('POST', '/api/v1/messages', {
    sourceSessionId: claudeSession,
    targetSessionId: codexSession,
    kind: 'instruction',
    subject: 'Rebuild the operational graph',
    content: 'Please trigger a graph rebuild before the next projection comparison.',
  });
  await claim(codexSession);
  await call('POST', `/api/v1/messages/${rejected.message.correlationId}/acknowledge`, {
    responderSessionId: codexSession,
  });
  await call('POST', `/api/v1/messages/${rejected.message.correlationId}/reject`, {
    responderSessionId: codexSession,
    response: {
      status: 'rejected',
      answer: 'A rebuild is a mutation and this session is read-only for the current task.',
      evidence: [],
      verifiedAt: at(3),
    },
  });

  // Left in flight on purpose: the dashboard has to show a live request as a
  // live request, not as a completed one with a missing answer.
  await call('POST', '/api/v1/messages', {
    sourceSessionId: codexSession,
    targetSessionId: claudeSession,
    kind: 'status_request',
    subject: 'Are you still holding the dashboard files?',
    content: 'Checking whether I can start editing the dashboard without colliding with you.',
    timeoutMs: 600_000,
  });
  step('3 messages: answered, rejected, in flight');

  // --- Phase 4: usage -------------------------------------------------------

  const usage = [
    {
      agentId: 'seed-codex',
      sessionId: codexSession,
      model: 'gpt-5-codex',
      provider: 'openai',
      inputTokens: 41_200,
      outputTokens: 6_140,
      cachedInputTokens: 28_000,
      totalTokens: 47_340,
      contextWindowTokens: 200_000,
      contextUsedTokens: 52_300,
      source: 'agent-exact',
      confidence: 'exact',
      observedAt: at(30),
    },
    {
      agentId: 'seed-claude',
      sessionId: claudeSession,
      model: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 18_900,
      outputTokens: 3_050,
      reasoningTokens: 1_200,
      totalTokens: 21_950,
      source: 'agent-reported',
      confidence: 'reported',
      observedAt: at(20),
    },
    {
      agentId: 'seed-claude',
      sessionId: claudeSession,
      source: 'unavailable',
      confidence: 'unknown',
      observedAt: at(10),
    },
  ] as const;

  for (const record of usage) {
    await call('POST', '/api/v1/usage', { projectId: project.id, ...record, metadata: {} });
  }
  step(`${String(usage.length)} usage records, one with no token figures at all`);

  // --- Phase 4: context sources and contributions ---------------------------

  const scanned = await call<{ sources: Array<{ id: string }> }>('POST', '/api/v1/context/scan', {
    agentId: 'seed-codex',
    projectId: project.id,
  }).catch((error: unknown) => {
    console.warn(`   context scan produced nothing: ${String(error)}`);
    return { sources: [] };
  });
  step(`${String(scanned.sources.length)} context sources from a real scan`);

  let contributions = 0;
  for (const [index, source] of scanned.sources.slice(0, 6).entries()) {
    await call('POST', '/api/v1/context/contributions', {
      projectId: project.id,
      agentId: 'seed-codex',
      sessionId: codexSession,
      contextSourceId: source.id,
      // Contributions grade loading on their own scale, which is not the one
      // context sources use: always | session-start | conditional | on-demand |
      // reference-only | unknown.
      loadingMode: index % 2 === 0 ? 'always' : 'on-demand',
      // Deliberately mixed: an unknown observation must stay unknown rather
      // than being counted as unused, which is the ADR 0010 rule the context
      // route renders.
      loaded: index % 3 === 0 ? true : index % 3 === 1 ? false : 'unknown',
      invoked: index % 3 === 0 ? true : 'unknown',
      reportedTokens: 1_200 + index * 340,
      source: 'session-reported',
      confidence: index % 2 === 0 ? 'high' : 'medium',
      observedAt: at(25 - index),
      evidenceIds: [`seed-evidence-${String(index)}`],
      metadata: {},
    });
    contributions += 1;
  }
  step(`${String(contributions)} context contributions`);

  // --- Phase 3: config plans, snapshots, drift ------------------------------

  /**
   * The plan chain needs a valid effective configuration, and only one of the
   * seeded agents has one — `seed-codex` deliberately binds a plugin its
   * adapter does not support, so its effective config is invalid on purpose.
   * That invalid state is the interesting one for the dashboard; this loop just
   * finds an agent that can still produce a plan.
   */
  let planId: string | undefined;
  let planAgentId: string | undefined;
  for (const agentId of ['seed-claude', 'seed-codex'] as const) {
    try {
      const plan = await call<{ id: string }>('POST', '/api/v1/config/render-plan', {
        agentId,
        projectId: project.id,
        adoptUnmanaged: true,
      });
      planId = plan.id;
      planAgentId = agentId;
      break;
    } catch (error) {
      console.warn(`   render plan for ${agentId} unavailable: ${String(error)}`);
    }
  }
  if (planId !== undefined) step(`config render plan ${planId} for ${String(planAgentId)}`);

  if (planId !== undefined) {
    try {
      // Approval takes no body and mints a one-time token that apply must carry.
      const approval = await call<{ approvalToken: string }>(
        'POST',
        `/api/v1/config/plans/${planId}/approve`,
        {},
      );
      await call('POST', `/api/v1/config/plans/${planId}/apply`, {
        approvalToken: approval.approvalToken,
      });
      step('plan approved and applied into the fixture workspace');

      /**
       * Drift needs a managed file to have changed behind LUWI's back, which is
       * the situation the domain exists to detect. Immediately after an apply
       * there is none, so the scan would report zero and the dashboard panel
       * would have nothing to render. Editing the applied file by hand is
       * exactly the event a developer would cause.
       */
      const managed = join(projectDir, '.claude', 'settings.json');
      if (existsSync(managed)) {
        const current = readFileSync(managed, 'utf8');
        await writeFile(
          managed,
          current.replace(/\}\s*$/u, ',\n  "seededOutOfBandEdit": true\n}\n'),
          'utf8',
        );
        step('edited the applied file out of band so drift has something to find');
      }

      const drift = await call<{ drifts: unknown[] }>('POST', '/api/v1/config/drift/scan', {});
      step(`drift scan: ${String(drift.drifts.length)} record(s)`);
    } catch (error) {
      console.warn(`   apply/drift chain stopped: ${String(error)}`);
    }
  }

  // --- Phase 4: git, packages, graph ---------------------------------------

  for (const [label, path] of [
    ['git', `/api/v1/projects/${project.id}/git/scan`],
    ['packages', `/api/v1/projects/${project.id}/packages/scan`],
  ] as const) {
    await call('POST', path, {}).catch((error: unknown) => {
      console.warn(`   ${label} scan skipped: ${String(error)}`);
      return {};
    });
  }
  await call('POST', '/api/v1/graph/rebuild', {}).catch(() => ({}));
  step('git, package and graph projections requested');

  console.log('');
  console.log(`Seeded ${daemonUrl}. Fixture workspace: ${workspace}`);
  console.log(`Project id: ${project.id}`);
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
