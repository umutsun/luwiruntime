import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { runCli } from '../apps/cli/dist/index.js';
import { startDaemon } from '../apps/daemon/dist/index.js';
import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
} from '../packages/redis/dist/index.js';

const execFileAsync = promisify(execFile);
const redisUrl = process.env.LUWI_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const port = 48_785;
const daemonUrl = `http://127.0.0.1:${port}`;
const runId = `demo_${randomUUID().replaceAll('-', '')}`;
const namespace = `luwi:demo:${runId}:v1`;
const keys = createRedisKeys(namespace);
const registry = createFunctionRegistry(runId);
const sandbox = await mkdtemp(join(tmpdir(), 'luwi-phase4-demo-'));
const bridgeRoot = join(sandbox, 'luwi-bridge');
const listingsRoot = join(sandbox, 'luwi-listings');
const worktreeRoot = join(sandbox, 'luwi-bridge-worktree');
const nativeHome = join(sandbox, 'native-home');
const luwiHome = join(sandbox, 'luwi-home');
const oversizedCapabilityRoot = join(luwiHome, 'capabilities', 'fixtures', 'oversized-context');
const oversizedInstructions = join(oversizedCapabilityRoot, 'instructions.md');
let runtime;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function connections() {
  return {
    command: createManagedRedisConnection({ url: redisUrl }),
    admin: createManagedRedisConnection({ url: redisUrl }),
    relay: createManagedRedisConnection({ url: redisUrl }),
  };
}

async function git(root, ...arguments_) {
  return execFileAsync('git', ['-C', root, ...arguments_], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
}

async function cli(arguments_, { print = false } = {}) {
  let output = '';
  let errors = '';
  await runCli([...arguments_, '--url', daemonUrl], {
    stdout: { write: (text) => (output += text) },
    stderr: { write: (text) => (errors += text) },
    confirm: async () => {
      throw new Error('The reproducible demo requires explicit --yes.');
    },
  });
  if (errors !== '') process.stderr.write(errors);
  const parsed = JSON.parse(output);
  if (print) {
    process.stdout.write(`${arguments_.join(' ')}\n${JSON.stringify(parsed, null, 2)}\n`);
  }
  return parsed;
}

async function mcp(toolName, input, sessionId) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve('apps/mcp-server/dist/harness.js'), toolName, JSON.stringify(input)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LUWI_DAEMON_URL: daemonUrl,
        LUWI_SESSION_ID: sessionId,
      },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

async function cleanupRedis() {
  const cleanup = createManagedRedisConnection({ url: redisUrl });
  await cleanup.connect();
  let cursor = '0';
  do {
    const reply = await cleanup.sendCommand([
      'SCAN',
      cursor,
      'MATCH',
      `${namespace}:*`,
      'COUNT',
      '100',
    ]);
    cursor = reply[0];
    if (reply[1].length > 0) await cleanup.sendCommand(['DEL', ...reply[1]]);
  } while (cursor !== '0');
  await cleanup.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]).catch(() => 0);
  await cleanup.quit();
}

async function registerAgent(id, kind, displayName, adapterId, nativeDirectory) {
  return cli([
    'agent',
    'register',
    '--body',
    JSON.stringify({
      id,
      kind,
      displayName,
      enabled: true,
      adapterId,
      nativeConfigRoots: [
        join(nativeHome, nativeDirectory),
        join(bridgeRoot, nativeDirectory),
        join(listingsRoot, nativeDirectory),
      ],
      metadata: {},
    }),
  ]);
}

async function bindAgent(projectId, agentId, role) {
  return cli([
    'project',
    'agent',
    'bind',
    projectId,
    '--body',
    JSON.stringify({
      agentId,
      enabled: true,
      role,
      profileIds: [],
      capabilityBindingIds: [],
      overrides: {},
    }),
  ]);
}

async function registerSession(projectId, agentId, root, branch, label) {
  return cli([
    'session',
    'register',
    '--project',
    projectId,
    '--agent',
    agentId,
    '--working-directory',
    root,
    '--branch',
    branch,
    '--metadata',
    JSON.stringify({ simulated: true, label }),
  ]);
}

async function observeContext({
  projectId,
  agentId,
  sessionId,
  contextSourceId,
  capabilityId,
  loaded,
  invoked,
  evidenceId,
  toolName,
  loadingMode,
}) {
  return cli([
    'context',
    'observe',
    '--body',
    JSON.stringify({
      projectId,
      agentId,
      sessionId,
      contextSourceId,
      capabilityId,
      loadingMode: loadingMode ?? (capabilityId === 'wide-status-mcp' ? 'conditional' : 'always'),
      loaded,
      invoked,
      source: 'session-reported',
      confidence: 'medium',
      observedAt: new Date().toISOString(),
      evidenceIds: [evidenceId],
      metadata: { simulated: true, ...(toolName === undefined ? {} : { toolName }) },
    }),
  ]);
}

try {
  for (const directory of [
    bridgeRoot,
    listingsRoot,
    join(nativeHome, '.codex'),
    join(nativeHome, '.claude'),
    join(nativeHome, '.gemini'),
    join(nativeHome, '.kimi'),
    join(bridgeRoot, '.codex'),
    join(listingsRoot, '.codex'),
    oversizedCapabilityRoot,
  ]) {
    await mkdir(directory, { recursive: true });
  }

  const duplicateInstructions = '# Shared fixture instructions\nUse bounded local evidence only.\n';
  await Promise.all([
    writeFile(join(nativeHome, '.codex', 'AGENTS.md'), duplicateInstructions),
    writeFile(join(bridgeRoot, 'AGENTS.md'), duplicateInstructions),
    writeFile(join(listingsRoot, 'AGENTS.md'), duplicateInstructions),
    writeFile(
      oversizedInstructions,
      `# Large structural fixture\n${'Inspect evidence before acting.\n'.repeat(2200)}`,
    ),
    writeFile(
      join(bridgeRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: 'luwi-bridge-fixture',
          private: true,
          dependencies: { fastify: '^5.0.0', redis: '^5.0.0', zod: '^4.0.0' },
          devDependencies: { typescript: '^6.0.0', vitest: '^4.0.0' },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(join(bridgeRoot, 'index.ts'), 'export const fixture = true;\n'),
    writeFile(
      join(listingsRoot, 'pubspec.yaml'),
      [
        'name: luwi_listings_fixture',
        'environment:',
        '  sdk: ">=3.0.0 <4.0.0"',
        'dependencies:',
        '  flutter:',
        '    sdk: flutter',
        '  http: ^1.2.0',
        'dev_dependencies:',
        '  flutter_test:',
        '    sdk: flutter',
        '',
      ].join('\n'),
    ),
    writeFile(join(listingsRoot, 'main.dart'), 'void main() {}\n'),
  ]);

  for (const root of [bridgeRoot, listingsRoot]) {
    await git(root, 'init');
    await git(root, 'config', 'user.name', 'LUWI Demo Fixture');
    await git(root, 'config', 'user.email', 'fixture@example.invalid');
    await git(root, 'config', 'remote.origin.url', 'https://demo:secret@example.invalid/repo.git');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'Initial sandbox state');
    await git(root, 'branch', 'fixture-review');
  }
  await git(bridgeRoot, 'worktree', 'add', '-b', 'fixture-worktree', worktreeRoot, 'HEAD');

  runtime = await startDaemon({
    config: {
      host: '127.0.0.1',
      port,
      redisUrl,
      logLevel: 'silent',
      workspaceId: 'phase4-demo',
      luwiHome,
      nativeHome,
      sessionPresenceTtlMs: 300_000,
      presenceSweepIntervalMs: 250,
      heartbeatEventIntervalMs: 100,
      consumerClaimIdleMs: 0,
      relayBlockMs: 25,
      messageTimeoutSweepIntervalMs: 50,
      messageTimeoutBatchSize: 100,
      retentionIntervalMs: 60_000,
      gitScanIntervalMs: 60_000,
      drainTimeoutMs: 2_000,
      optimizationMinimumBaselineSessions: 1,
      optimizationMinimumPostSessions: 1,
      optimizationMinimumObservationHours: 0,
      optimizationOversizedContextTokens: 1_000,
      allowedOrigins: [daemonUrl],
    },
    logger: false,
    runtimeInstanceId: `runtime-${runId}`,
    keys,
    functionRegistry: registry,
    connections: connections(),
  });

  const bridge = await cli(['project', 'register', '--name', 'Luwi Bridge', '--path', bridgeRoot]);
  const listings = await cli([
    'project',
    'register',
    '--name',
    'Luwi Listings',
    '--path',
    listingsRoot,
  ]);

  await Promise.all([
    registerAgent('codex-demo', 'codex', 'Codex', 'codex-native-v1', '.codex'),
    registerAgent('claude-demo', 'claude-code', 'Claude Code', 'claude-code-native-v1', '.claude'),
    registerAgent('gemini-demo', 'gemini-cli', 'Gemini CLI', 'gemini-cli-native-v1', '.gemini'),
    registerAgent('kimi-demo', 'kimi', 'Kimi', 'kimi-native-v1', '.kimi'),
  ]);
  for (const [projectId, assignments] of [
    [
      bridge.id,
      [
        ['codex-demo', 'implementation'],
        ['claude-demo', 'review'],
        ['gemini-demo', 'verification'],
        ['kimi-demo', 'research'],
      ],
    ],
    [
      listings.id,
      [
        ['codex-demo', 'implementation'],
        ['gemini-demo', 'verification'],
      ],
    ],
  ]) {
    for (const [agentId, role] of assignments) await bindAgent(projectId, agentId, role);
  }

  const capabilities = [
    {
      id: 'project-only-global-context',
      kind: 'instruction',
      name: 'Large global instructions',
      scope: 'global',
      source: 'local-path',
      path: oversizedCapabilityRoot,
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { loadingPolicy: 'automatic' },
    },
    {
      id: 'wide-status-mcp',
      kind: 'mcp',
      name: 'Wide status MCP fixture',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {
        loadingPolicy: 'conditional',
        tools: Array.from({ length: 40 }, (_, index) => `fixture_tool_${index + 1}`),
      },
    },
    {
      id: 'reference-guide',
      kind: 'skill',
      name: 'Reference-only guide fixture',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { loadingPolicy: 'manual' },
    },
  ];
  for (const capability of capabilities) {
    await cli(['capability', 'register', '--body', JSON.stringify(capability)]);
    await cli([
      'capability',
      'assign',
      capability.id,
      '--body',
      JSON.stringify({ scope: 'global', enabled: true, settings: {} }),
    ]);
  }

  const bridgeSessions = [
    await registerSession(bridge.id, 'codex-demo', bridgeRoot, 'codex-a', 'codex-a'),
    await registerSession(bridge.id, 'codex-demo', bridgeRoot, 'codex-b', 'codex-b'),
    await registerSession(bridge.id, 'claude-demo', bridgeRoot, 'master', 'claude-main'),
    await registerSession(bridge.id, 'gemini-demo', bridgeRoot, 'gemini-review', 'gemini'),
  ];
  const listingsSessions = [
    await registerSession(listings.id, 'codex-demo', listingsRoot, 'master', 'codex-listings'),
    await registerSession(listings.id, 'gemini-demo', listingsRoot, 'gemini', 'gemini-listings'),
  ];
  assert(
    bridgeSessions[0].id !== bridgeSessions[1].id &&
      bridgeSessions[0].agentId === bridgeSessions[1].agentId,
    'Two sessions sharing one agentId were not preserved as distinct sessions.',
  );

  const usageInputs = [
    {
      projectId: bridge.id,
      agentId: 'codex-demo',
      sessionId: bridgeSessions[0].id,
      model: 'fixture-exact',
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      source: 'agent-exact',
      confidence: 'exact',
    },
    {
      projectId: bridge.id,
      agentId: 'claude-demo',
      sessionId: bridgeSessions[2].id,
      model: 'fixture-reported',
      inputTokens: 900,
      outputTokens: 200,
      totalTokens: 1100,
      source: 'agent-reported',
      confidence: 'reported',
    },
    {
      projectId: listings.id,
      agentId: 'codex-demo',
      sessionId: listingsSessions[0].id,
      contextUsedTokens: 700,
      source: 'luwi-estimated',
      confidence: 'estimated',
    },
    {
      projectId: listings.id,
      agentId: 'gemini-demo',
      sessionId: listingsSessions[1].id,
      source: 'unavailable',
      confidence: 'unknown',
    },
  ];
  for (const [index, input] of usageInputs.entries()) {
    await cli([
      'usage',
      'ingest',
      '--body',
      JSON.stringify({
        ...input,
        observedAt: new Date().toISOString(),
        sourceEventId: `phase4-demo-usage-${index}`,
        metadata: { simulated: true },
      }),
    ]);
  }
  const projectUsage = await cli(['usage', 'summary', '--project', bridge.id]);
  const agentUsage = await cli(['usage', 'summary', '--agent', 'codex-demo']);
  const sessionUsage = await cli(['usage', 'summary', '--session', bridgeSessions[0].id]);
  const unavailableUsage = await cli(['usage', 'list', '--session', listingsSessions[1].id]);
  assert(
    !Object.hasOwn(unavailableUsage.records[0], 'totalTokens'),
    'Unavailable telemetry was incorrectly represented as zero.',
  );

  const bridgeContextSources = await cli([
    'context',
    'scan',
    '--agent',
    'codex-demo',
    '--project',
    bridge.id,
  ]);
  const listingsContextSources = await cli([
    'context',
    'scan',
    '--agent',
    'codex-demo',
    '--project',
    listings.id,
  ]);
  const sourceFor = (collection, capabilityId, predicate = () => true) =>
    collection.sources.find((source) => source.capabilityId === capabilityId && predicate(source));
  const bridgeLargeSource = sourceFor(
    bridgeContextSources,
    'project-only-global-context',
    (source) => source.estimatedTokenCount > 1000,
  );
  const listingsLargeSource = sourceFor(
    listingsContextSources,
    'project-only-global-context',
    (source) => source.estimatedTokenCount > 1000,
  );
  const bridgeMcpSource = sourceFor(bridgeContextSources, 'wide-status-mcp');
  assert(bridgeLargeSource && listingsLargeSource && bridgeMcpSource, 'Context sources missing.');

  await observeContext({
    projectId: bridge.id,
    agentId: 'codex-demo',
    sessionId: bridgeSessions[0].id,
    contextSourceId: bridgeLargeSource.id,
    capabilityId: 'project-only-global-context',
    loaded: true,
    invoked: true,
    evidenceId: 'bridge-large-used',
  });
  await observeContext({
    projectId: listings.id,
    agentId: 'codex-demo',
    sessionId: listingsSessions[0].id,
    contextSourceId: listingsLargeSource.id,
    capabilityId: 'project-only-global-context',
    loaded: false,
    invoked: false,
    evidenceId: 'listings-large-not-loaded',
  });
  await observeContext({
    projectId: bridge.id,
    agentId: 'codex-demo',
    sessionId: bridgeSessions[0].id,
    contextSourceId: bridgeMcpSource.id,
    capabilityId: 'wide-status-mcp',
    loaded: true,
    invoked: true,
    evidenceId: 'mcp-call-1',
    toolName: 'fixture_tool_1',
  });
  await observeContext({
    projectId: bridge.id,
    agentId: 'codex-demo',
    sessionId: bridgeSessions[1].id,
    contextSourceId: bridgeMcpSource.id,
    capabilityId: 'wide-status-mcp',
    loaded: true,
    invoked: false,
    evidenceId: 'mcp-no-call-2',
  });
  const contextIntelligence = await cli([
    'context',
    'analyze',
    '--project',
    bridge.id,
    '--agent',
    'codex-demo',
  ]);
  assert(contextIntelligence.summary.observedLoadedCount > 0, 'Loaded evidence was not counted.');
  assert(
    contextIntelligence.summary.observedInvokedCount > 0,
    'Invocation evidence was not counted.',
  );
  assert(contextIntelligence.summary.unknownLoadedCount > 0, 'Unknown evidence was collapsed.');

  await writeFile(join(bridgeRoot, 'exact.ts'), 'export const exact = true;\n');
  await git(bridgeRoot, 'add', 'exact.ts');
  await git(
    bridgeRoot,
    'commit',
    '-m',
    `Exact fixture\n\nLuwi-Agent: codex-demo\nLuwi-Session: ${bridgeSessions[0].id}\nLuwi-Project: ${bridge.id}`,
  );
  await delay(20);
  await writeFile(join(bridgeRoot, 'correlated.ts'), 'export const correlated = true;\n');
  await git(bridgeRoot, 'add', 'correlated.ts');
  await git(bridgeRoot, 'commit', '-m', 'Correlated fixture without LUWI trailers');
  await writeFile(join(bridgeRoot, 'dirty.ts'), 'export const dirty = true;\n');
  const gitObservation = await cli(['git', 'scan', '--project', bridge.id]);
  const attributions = await cli(['git', 'attributions', '--project', bridge.id]);
  assert(
    attributions.attributions.some(({ confidence }) => confidence === 'exact'),
    'Explicit trailer attribution was not exact.',
  );
  assert(
    attributions.attributions.some(({ confidence }) => confidence === 'correlated'),
    'Time/branch/path attribution was not labeled correlated.',
  );
  assert(gitObservation.clean === false, 'Dirty working tree was not observed.');
  assert(gitObservation.worktrees.length >= 2, 'Linked worktree was not observed.');
  assert(
    !String(gitObservation.remoteUrl).includes('secret'),
    'Credential-bearing remote URL was not redacted.',
  );

  const bridgePackages = await cli(['package', 'scan', '--project', bridge.id]);
  const listingsPackages = await cli(['package', 'scan', '--project', listings.id]);
  assert(
    bridgePackages.packages.some(({ ecosystem }) => ecosystem === 'node'),
    'Node packages were not inventoried.',
  );
  assert(
    listingsPackages.packages.some(({ ecosystem }) => ecosystem === 'dart'),
    'Flutter/Dart packages were not inventoried.',
  );

  const rebuild = await cli(['graph', 'rebuild']);
  assert(
    rebuild.state === 'completed' && rebuild.activeGeneration === rebuild.shadowGeneration,
    'Shadow graph generation was not atomically activated.',
  );
  const projectAgents = await cli([
    'graph',
    'neighbors',
    'project',
    bridge.id,
    '--direction',
    'out',
    '--edge-kind',
    'PROJECT_BOUND_AGENT',
  ]);
  const agentSessions = await cli([
    'graph',
    'neighbors',
    'agent',
    'codex-demo',
    '--direction',
    'out',
    '--edge-kind',
    'AGENT_RAN_SESSION',
  ]);
  const sessionCommits = await cli([
    'graph',
    'neighbors',
    'session',
    bridgeSessions[0].id,
    '--direction',
    'out',
    '--edge-kind',
    'SESSION_ASSOCIATED_WITH_COMMIT',
  ]);
  const exactCommit = attributions.attributions.find(({ confidence }) => confidence === 'exact');
  const exactCommitNode = sessionCommits.nodes.find(
    (node) => node.kind === 'commit' && node.metadata.commitSha === exactCommit.commitSha,
  );
  if (exactCommitNode === undefined) {
    throw new Error('The exact-attribution commit was not reachable from its session.');
  }
  const commitFiles = await cli([
    'graph',
    'neighbors',
    'commit',
    exactCommitNode.entityId,
    '--direction',
    'out',
    '--edge-kind',
    'COMMIT_TOUCHES_FILE',
  ]);
  const projectPackages = await cli([
    'graph',
    'neighbors',
    'project',
    bridge.id,
    '--direction',
    'out',
    '--edge-kind',
    'PROJECT_USES_PACKAGE',
  ]);
  const capabilitySessions = await cli([
    'graph',
    'neighbors',
    'mcp',
    'wide-status-mcp',
    '--direction',
    'in',
  ]);
  const graphPath = await cli([
    'graph',
    'path',
    'project',
    bridge.id,
    'commit',
    exactCommitNode.entityId,
    '--project',
    bridge.id,
    '--max-depth',
    '3',
  ]);
  for (const [name, result] of [
    ['project agents', projectAgents],
    ['agent sessions', agentSessions],
    ['session commits', sessionCommits],
    ['commit files', commitFiles],
    ['project packages', projectPackages],
    ['capability sessions', capabilitySessions],
  ]) {
    assert(result.edges.length > 0, `Graph query returned no ${name}.`);
  }
  assert(graphPath.found, 'Bounded project-to-commit graph path was not found.');
  assert(
    !JSON.stringify(await cli(['graph', 'subgraph', 'project', bridge.id])).includes(
      'Inspect evidence before acting.',
    ),
    'Source content leaked into the operational graph.',
  );

  const optimization = await cli([
    'optimize',
    'analyze',
    '--project',
    bridge.id,
    '--agent',
    'codex-demo',
    '--minimum-sessions',
    '1',
  ]);
  const findingKinds = new Set(optimization.findings.map(({ kind }) => kind));
  for (const expected of [
    'oversized-always-loaded-source',
    'exact-duplicate-content',
    'global-source-single-project',
    'mcp-broad-low-observed-use',
  ]) {
    assert(findingKinds.has(expected), `Missing required structural finding: ${expected}`);
  }
  const proposal = optimization.proposals.find(({ proposedActions }) =>
    proposedActions.some(
      (action) =>
        action.kind === 'convert-source-to-reference-only' &&
        action.contextSourceId === bridgeLargeSource.id,
    ),
  );
  assert(proposal, 'No deterministic proposal targeted the oversized source.');
  const accepted = await cli(['optimize', 'accept', proposal.id]);
  assert(
    accepted.state === 'accepted' && accepted.configurationApplied === false,
    'Proposal acceptance changed configuration.',
  );
  const beforePlan = await cli([
    'context',
    'intelligence',
    '--project',
    bridge.id,
    '--agent',
    'codex-demo',
  ]);
  assert(
    beforePlan.contributions.some(
      ({ contextSourceId, loadingMode }) =>
        contextSourceId === bridgeLargeSource.id && loadingMode === 'always',
    ),
    'Acceptance unexpectedly changed the loading mode.',
  );
  const planned = await cli(['optimize', 'create-plan', proposal.id]);
  const approval = await cli(['config', 'plan', 'approve', planned.plan.id]);
  const receipt = await cli([
    'config',
    'plan',
    'apply',
    planned.plan.id,
    '--approval-token',
    approval.approvalToken,
    '--yes',
  ]);
  assert(receipt.snapshotId, 'Phase 3 ConfigPlan apply did not create a snapshot.');

  const postSession = await registerSession(
    bridge.id,
    'codex-demo',
    bridgeRoot,
    'post-optimization',
    'post-optimization',
  );
  await cli(['context', 'scan', '--agent', 'codex-demo', '--project', bridge.id]);
  const postContext = await cli([
    'context',
    'analyze',
    '--project',
    bridge.id,
    '--agent',
    'codex-demo',
  ]);
  assert(
    postContext.contributions.some(
      ({ contextSourceId, sessionId, loadingMode }) =>
        contextSourceId === bridgeLargeSource.id &&
        sessionId === postSession.id &&
        loadingMode === 'reference-only',
    ),
    'Applied ConfigPlan did not produce a reference-only contribution.',
  );
  await observeContext({
    projectId: bridge.id,
    agentId: 'codex-demo',
    sessionId: postSession.id,
    contextSourceId: bridgeLargeSource.id,
    capabilityId: 'project-only-global-context',
    loadingMode: 'reference-only',
    loaded: false,
    invoked: false,
    evidenceId: 'post-optimization-not-loaded',
  });
  const evaluation = await cli([
    'optimize',
    'evaluate',
    proposal.id,
    '--minimum-post-sessions',
    '1',
    '--minimum-observation-hours',
    '0',
  ]);
  assert(evaluation.causalClaim === false, 'Evaluation made a causal claim.');
  assert(
    evaluation.summary === 'Observed context footprint decreased after the change.',
    'Evaluation did not report the observed footprint reduction.',
  );

  const mcpUsage = await mcp(
    'luwi_get_usage_summary',
    { sessionOnly: false },
    bridgeSessions[0].id,
  );
  assert(
    mcpUsage.structuredContent?.recordCount >= 1,
    'Read-only Phase 4 MCP usage summary failed.',
  );

  const finalSummary = {
    phase: 4,
    status: 'passed',
    fixture: 'simulated telemetry and temporary repositories',
    projects: [bridge.name, listings.name],
    agents: ['codex-demo', 'claude-demo', 'gemini-demo', 'kimi-demo'],
    sharedAgentSessions: 2,
    usage: {
      projectSources: projectUsage.sources.map(({ source }) => source),
      agentRecordCount: agentUsage.recordCount,
      sessionRecordCount: sessionUsage.recordCount,
      unavailableMissingTotalPreserved: true,
    },
    context: {
      assignedCount: contextIntelligence.summary.assignedCount,
      observedLoadedCount: contextIntelligence.summary.observedLoadedCount,
      observedInvokedCount: contextIntelligence.summary.observedInvokedCount,
      unknownLoadedCount: contextIntelligence.summary.unknownLoadedCount,
      postChangeLoadingMode: 'reference-only',
    },
    git: {
      exactAttribution: true,
      correlatedAttribution: true,
      dirty: true,
      branches: gitObservation.branches.length,
      worktrees: gitObservation.worktrees.length,
      remoteCredentialsRedacted: true,
    },
    inventory: {
      nodePackages: bridgePackages.packages.length,
      dartPackages: listingsPackages.packages.length,
      technologies: bridgePackages.technologies.length + listingsPackages.technologies.length,
    },
    graph: {
      generation: rebuild.activeGeneration,
      nodes: rebuild.nodeCount,
      edges: rebuild.edgeCount,
      boundedPathFound: true,
      sourceContentStored: false,
    },
    optimization: {
      findings: [...findingKinds].sort(),
      acceptedDidNotApply: true,
      configPlanId: planned.plan.id,
      snapshotId: receipt.snapshotId,
      evaluation: evaluation.state,
      summary: evaluation.summary,
      causalClaim: evaluation.causalClaim,
    },
    mcpReadOnlyUsageSummary: true,
  };
  process.stdout.write(`${JSON.stringify(finalSummary, null, 2)}\n`);
  assert(
    !(await readFile(join(bridgeRoot, 'AGENTS.md'), 'utf8')).includes('reference-only'),
    'Optimization rewrote instruction prose.',
  );
} finally {
  await runtime?.shutdown.shutdown('SIGTERM').catch(() => undefined);
  runtime?.shutdown.dispose();
  await cleanupRedis().catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true });
}
