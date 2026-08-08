import { randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { runCli } from '../apps/cli/dist/index.js';
import { startDaemon } from '../apps/daemon/dist/index.js';
import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
} from '../packages/redis/dist/index.js';

const execFileAsync = promisify(execFile);
const redisUrl = process.env.LUWI_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15';
const port = 48_784;
const daemonUrl = `http://127.0.0.1:${port}`;
const runId = `demo_${randomUUID().replaceAll('-', '')}`;
const namespace = `luwi:demo:${runId}:v1`;
const keys = createRedisKeys(namespace);
const registry = createFunctionRegistry(runId);
const originalPath = process.env.PATH ?? '';
const sandbox = await mkdtemp(join(tmpdir(), 'luwi-phase3-demo-'));
const projectRoot = join(sandbox, 'project');
const secondProjectRoot = join(sandbox, 'project-two');
const nativeHome = join(sandbox, 'native-home');
const luwiHome = join(sandbox, 'luwi-home');
const fixtureBin = join(sandbox, 'fixture-bin');
const forbiddenExecutionMarker = join(sandbox, 'forbidden-code-executed');
let runtime;
let failConfigCompletionReplyOnce = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function connections() {
  const command = createManagedRedisConnection({ url: redisUrl });
  const sendCommand = command.sendCommand.bind(command);
  command.sendCommand = async (arguments_) => {
    const result = await sendCommand(arguments_);
    if (
      failConfigCompletionReplyOnce &&
      arguments_[0] === 'FCALL' &&
      arguments_[1] === registry.functions.controlPlanComplete
    ) {
      failConfigCompletionReplyOnce = false;
      throw new Error('Simulated lost Redis completion reply after atomic commit.');
    }
    return result;
  };
  return {
    command,
    admin: createManagedRedisConnection({ url: redisUrl }),
    relay: createManagedRedisConnection({ url: redisUrl }),
  };
}

async function cli(arguments_) {
  let output = '';
  let errors = '';
  await runCli([...arguments_, '--url', daemonUrl], {
    stdout: { write: (text) => (output += text) },
    stderr: { write: (text) => (errors += text) },
    confirm: async () => {
      throw new Error('The reproducible demo uses explicit --yes.');
    },
  });
  if (errors !== '') process.stderr.write(errors);
  const parsed = JSON.parse(output);
  process.stdout.write(`${arguments_.join(' ')}\n${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

async function mcp(toolName, input, sessionId) {
  const harnessPath = resolve('apps/mcp-server/dist/harness.js');
  const { stdout } = await execFileAsync(
    process.execPath,
    [harnessPath, toolName, JSON.stringify(input)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LUWI_DAEMON_URL: daemonUrl,
        LUWI_SESSION_ID: sessionId,
      },
      timeout: 30_000,
    },
  );
  const parsed = JSON.parse(stdout);
  process.stdout.write(`${toolName}\n${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

async function createFixtureExecutables() {
  await mkdir(fixtureBin, { recursive: true });
  const fixtureNode = join(
    fixtureBin,
    process.platform === 'win32' ? 'fixture-node.EXE' : 'fixture-node',
  );
  await copyFile(process.execPath, fixtureNode);
  for (const name of ['codex', 'claude', 'gemini', 'kimi']) {
    const target = join(fixtureBin, process.platform === 'win32' ? `${name}.EXE` : name);
    if (process.platform === 'win32') {
      await link(fixtureNode, target).catch(() => copyFile(fixtureNode, target));
    } else {
      await symlink(fixtureNode, target);
    }
  }
  process.env.PATH = `${fixtureBin}${delimiter}${originalPath}`;
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

try {
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(secondProjectRoot, { recursive: true }),
    mkdir(join(nativeHome, '.codex'), { recursive: true }),
    mkdir(join(nativeHome, '.claude'), { recursive: true }),
    mkdir(join(projectRoot, '.codex'), { recursive: true }),
    mkdir(join(projectRoot, '.claude'), { recursive: true }),
  ]);
  await createFixtureExecutables();
  const duplicateInstructions = '# Fixture instructions\nNever execute discovered code.\n';
  await Promise.all([
    writeFile(join(nativeHome, '.codex', 'AGENTS.md'), duplicateInstructions),
    writeFile(join(nativeHome, '.claude', 'CLAUDE.md'), duplicateInstructions),
    writeFile(join(projectRoot, 'AGENTS.md'), duplicateInstructions),
    writeFile(join(projectRoot, 'CLAUDE.md'), duplicateInstructions),
    writeFile(join(projectRoot, '.codex', 'config.toml'), 'model = "before-luwi"\n'),
  ]);

  runtime = await startDaemon({
    config: {
      host: '127.0.0.1',
      port,
      redisUrl,
      logLevel: 'silent',
      workspaceId: 'phase3-demo',
      luwiHome,
      nativeHome,
      sessionPresenceTtlMs: 3_000,
      presenceSweepIntervalMs: 50,
      heartbeatEventIntervalMs: 100,
      consumerClaimIdleMs: 0,
      relayBlockMs: 50,
      messageTimeoutSweepIntervalMs: 50,
      messageTimeoutBatchSize: 100,
      retentionIntervalMs: 60_000,
      drainTimeoutMs: 2_000,
      allowedOrigins: [daemonUrl],
    },
    logger: false,
    runtimeInstanceId: `runtime-${runId}`,
    keys,
    functionRegistry: registry,
    connections: connections(),
  });

  const project = await cli([
    'project',
    'register',
    '--name',
    'Phase 3 sandbox',
    '--path',
    projectRoot,
  ]);
  const projectTwo = await cli([
    'project',
    'register',
    '--name',
    'Phase 3 second sandbox',
    '--path',
    secondProjectRoot,
  ]);
  const detected = await cli(['agent', 'detect', '--project', project.id]);
  assert(detected.installations.length === 4, 'Expected four fixture installations.');
  assert(
    detected.installations.every(({ executable }) => executable.startsWith(fixtureBin)),
    'Detection escaped the fixture executable directory.',
  );

  const agents = [
    ['codex-demo', 'codex', 'Codex', 'codex-native-v1', '.codex'],
    ['claude-demo', 'claude-code', 'Claude Code', 'claude-code-native-v1', '.claude'],
    ['gemini-demo', 'gemini-cli', 'Gemini CLI', 'gemini-cli-native-v1', '.gemini'],
    ['kimi-demo', 'kimi', 'Kimi', 'kimi-native-v1', '.kimi'],
  ];
  for (const [id, kind, displayName, adapterId, nativeDirectory] of agents) {
    await cli([
      'agent',
      'register',
      '--body',
      JSON.stringify({
        id,
        kind,
        displayName,
        enabled: true,
        adapterId,
        nativeConfigRoots: [join(nativeHome, nativeDirectory), join(projectRoot, nativeDirectory)],
        metadata: kind === 'codex' ? { settings: { model: 'fixture-global' } } : {},
      }),
    ]);
  }

  const capabilityDefinitions = [
    {
      id: 'typescript-development',
      kind: 'skill',
      name: 'TypeScript development',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: [],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { loadingPolicy: 'conditional' },
    },
    {
      id: 'git-safety',
      kind: 'policy',
      name: 'Git safety',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: [],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { shellConfirmation: true },
    },
    {
      id: 'redis-development',
      kind: 'skill',
      name: 'Redis development',
      scope: 'project',
      projectId: project.id,
      source: 'luwi-project',
      compatibleAgentKinds: ['codex', 'claude-code'],
      requiredCapabilityIds: ['typescript-development'],
      requiredMcpIds: [],
      enabled: true,
      manifest: { loadingPolicy: 'automatic' },
    },
    {
      id: 'fixture-plugin',
      kind: 'plugin',
      name: 'Fixture plugin',
      scope: 'global',
      source: 'local-path',
      compatibleAgentKinds: ['codex'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { command: forbiddenExecutionMarker },
    },
    {
      id: 'fixture-hook',
      kind: 'hook',
      name: 'Fixture hook',
      scope: 'global',
      source: 'local-path',
      compatibleAgentKinds: ['claude-code'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { event: 'after-tool', command: forbiddenExecutionMarker },
    },
    {
      id: 'external-status-mcp',
      kind: 'mcp',
      name: 'External status MCP',
      scope: 'global',
      source: 'local-path',
      compatibleAgentKinds: [],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {
        transport: 'stdio',
        command: forbiddenExecutionMarker,
        envReferences: ['STATUS_API_TOKEN'],
      },
    },
    {
      id: 'read-only-policy',
      kind: 'policy',
      name: 'Read-only research policy',
      scope: 'global',
      source: 'bundled',
      compatibleAgentKinds: [],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: { network: 'documented-only' },
    },
    {
      id: 'needs-status-mcp',
      kind: 'skill',
      name: 'Needs status MCP',
      scope: 'project',
      projectId: project.id,
      source: 'luwi-project',
      compatibleAgentKinds: ['gemini-cli'],
      requiredCapabilityIds: [],
      requiredMcpIds: ['external-status-mcp'],
      enabled: true,
      manifest: {},
    },
  ];
  for (const capability of capabilityDefinitions) {
    await cli(['capability', 'register', '--body', JSON.stringify(capability)]);
  }

  await cli([
    'profile',
    'create',
    '--body',
    JSON.stringify({
      id: 'backend-implementation',
      name: 'Backend implementation',
      scope: 'global',
      capabilityIds: ['typescript-development'],
      policyIds: ['git-safety'],
      disabledCapabilityIds: [],
      adapterSettings: { profileMode: 'backend' },
    }),
  ]);

  const globalBindings = [];
  for (const capabilityId of ['typescript-development', 'git-safety']) {
    globalBindings.push(
      await cli([
        'capability',
        'assign',
        capabilityId,
        '--body',
        JSON.stringify({
          scope: 'global',
          enabled: true,
          settings: capabilityId === 'git-safety' ? { safetyLevel: 'global' } : {},
        }),
      ]),
    );
  }
  const projectAssignments = {};
  for (const [agentId, capabilityId, enabled, settings] of [
    ['codex-demo', 'redis-development', true, { safetyLevel: 'project' }],
    ['claude-demo', 'redis-development', true, {}],
    ['gemini-demo', 'needs-status-mcp', true, {}],
    ['kimi-demo', 'typescript-development', false, {}],
  ]) {
    projectAssignments[agentId] = await cli([
      'capability',
      'assign',
      capabilityId,
      '--body',
      JSON.stringify({
        scope: 'project',
        projectId: project.id,
        agentId,
        enabled,
        settings,
      }),
    ]);
  }
  const claudeContextAssignments = [];
  for (const capabilityId of ['fixture-hook', 'external-status-mcp']) {
    claudeContextAssignments.push(
      await cli([
        'capability',
        'assign',
        capabilityId,
        '--body',
        JSON.stringify({
          scope: 'project',
          projectId: project.id,
          agentId: 'claude-demo',
          enabled: true,
          settings: {},
        }),
      ]),
    );
  }

  const projectBindings = {};
  for (const [agentId, role] of [
    ['codex-demo', 'backend implementer'],
    ['claude-demo', 'architect reviewer'],
    ['gemini-demo', 'integration verifier'],
    ['kimi-demo', 'research documentation'],
  ]) {
    projectBindings[agentId] = await cli([
      'project',
      'agent',
      'bind',
      project.id,
      '--body',
      JSON.stringify({
        agentId,
        enabled: true,
        role,
        profileIds: agentId === 'codex-demo' ? ['backend-implementation'] : [],
        capabilityBindingIds: [
          projectAssignments[agentId].id,
          ...(agentId === 'claude-demo' ? claudeContextAssignments.map(({ id }) => id) : []),
        ],
        overrides: agentId === 'codex-demo' ? { model: 'fixture-project' } : {},
      }),
    ]);
  }
  await cli([
    'project',
    'agent',
    'bind',
    projectTwo.id,
    '--body',
    JSON.stringify({
      agentId: 'codex-demo',
      enabled: true,
      profileIds: [],
      capabilityBindingIds: [],
      overrides: {},
    }),
  ]);

  const codexEffective = await cli(['project', 'agent', 'effective', project.id, 'codex-demo']);
  assert(codexEffective.settings.model === 'fixture-project', 'Project override was not applied.');
  assert(
    codexEffective.settings.safetyLevel === 'project',
    'Project setting did not override global.',
  );
  const secondEffective = await cli(['project', 'agent', 'effective', projectTwo.id, 'codex-demo']);
  assert(secondEffective.settings.safetyLevel === 'global', 'Global setting was not inherited.');
  const kimiEffective = await cli(['project', 'agent', 'effective', project.id, 'kimi-demo']);
  assert(
    !kimiEffective.capabilities.some(({ id }) => id === 'typescript-development'),
    'Project disable tombstone did not suppress the global capability.',
  );
  const invalidGemini = await cli(['project', 'agent', 'effective', project.id, 'gemini-demo']);
  assert(!invalidGemini.valid, 'Missing MCP dependency did not invalidate effective config.');
  const geminiMcpAssignment = await cli([
    'capability',
    'assign',
    'external-status-mcp',
    '--body',
    JSON.stringify({
      scope: 'project',
      projectId: project.id,
      agentId: 'gemini-demo',
      enabled: true,
      settings: {},
    }),
  ]);
  await cli([
    'project',
    'agent',
    'update',
    project.id,
    projectBindings['gemini-demo'].id,
    '--body',
    JSON.stringify({
      capabilityBindingIds: [projectAssignments['gemini-demo'].id, geminiMcpAssignment.id],
    }),
  ]);
  const fixedGemini = await cli(['project', 'agent', 'effective', project.id, 'gemini-demo']);
  assert(fixedGemini.valid, 'Dependency fix did not produce valid effective config.');

  await cli([
    'config',
    'inspect',
    '--body',
    JSON.stringify({ agentId: 'codex-demo', projectId: project.id }),
  ]);
  const renderPlan = await cli([
    'config',
    'render-plan',
    '--body',
    JSON.stringify({
      agentId: 'codex-demo',
      projectId: project.id,
      adoptUnmanaged: true,
    }),
  ]);
  assert(!JSON.stringify(renderPlan.changes).includes('before-luwi'), 'Diff leaked file contents.');
  const approval = await cli(['config', 'plan', 'approve', renderPlan.id]);
  const applied = await cli([
    'config',
    'plan',
    'apply',
    renderPlan.id,
    '--approval-token',
    approval.approvalToken,
    '--yes',
  ]);
  assert(applied.snapshotId, 'Apply did not create a snapshot.');
  await cli(['config', 'snapshot', 'list']);

  const nativeTarget = join(projectRoot, '.codex', 'config.toml');
  await writeFile(nativeTarget, 'model = "external-drift"\n');
  const drift = await cli(['config', 'drift', '--scan']);
  assert(drift.drifts.length > 0, 'External edit was not detected as drift.');
  assert(
    (await readFile(nativeTarget, 'utf8')).includes('external-drift'),
    'Drift scan overwrote the external edit.',
  );
  const rollbackPlan = await cli(['config', 'rollback-plan', applied.snapshotId]);
  const rollbackApproval = await cli(['config', 'plan', 'approve', rollbackPlan.id]);
  await cli([
    'config',
    'plan',
    'apply',
    rollbackPlan.id,
    '--approval-token',
    rollbackApproval.approvalToken,
    '--yes',
  ]);
  assert(
    (await readFile(nativeTarget, 'utf8')) === 'model = "before-luwi"\n',
    'Rollback did not restore the snapshot.',
  );

  const recoveryPlan = await cli([
    'config',
    'render-plan',
    '--body',
    JSON.stringify({
      agentId: 'codex-demo',
      projectId: project.id,
      adoptUnmanaged: true,
    }),
  ]);
  const recoveryApproval = await cli(['config', 'plan', 'approve', recoveryPlan.id]);
  failConfigCompletionReplyOnce = true;
  let recoveryError;
  try {
    await cli([
      'config',
      'plan',
      'apply',
      recoveryPlan.id,
      '--approval-token',
      recoveryApproval.approvalToken,
      '--yes',
    ]);
  } catch (error) {
    recoveryError = error;
  }
  assert(recoveryError !== undefined, 'Lost Redis completion reply was not simulated.');
  let recoveredPlan;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [healthResponse, planResponse] = await Promise.all([
      runtime.app.inject({ method: 'GET', url: '/health' }),
      runtime.app.inject({
        method: 'GET',
        url: `/api/v1/config/plans/${recoveryPlan.id}`,
      }),
    ]);
    if (healthResponse.statusCode === 200 && planResponse.statusCode === 200) {
      const health = healthResponse.json();
      const candidate = planResponse.json();
      if (health.runtimeState === 'ready' && candidate.state === 'applied') {
        recoveredPlan = candidate;
        break;
      }
    }
    await delay(25);
  }
  assert(recoveredPlan?.snapshotId, 'Redis completion recovery did not rebuild the applied plan.');
  const recoveryRollbackPlan = await cli(['config', 'rollback-plan', recoveredPlan.snapshotId]);
  const recoveryRollbackApproval = await cli([
    'config',
    'plan',
    'approve',
    recoveryRollbackPlan.id,
  ]);
  await cli([
    'config',
    'plan',
    'apply',
    recoveryRollbackPlan.id,
    '--approval-token',
    recoveryRollbackApproval.approvalToken,
    '--yes',
  ]);
  assert(
    (await readFile(nativeTarget, 'utf8')) === 'model = "before-luwi"\n',
    'Recovery rollback did not restore the original native file.',
  );

  await cli(['context', 'scan', '--agent', 'codex-demo', '--project', project.id]);
  const footprint = await cli(['context', 'footprint', project.id, 'codex-demo']);
  assert(footprint.source === 'estimated', 'Context source was not labeled estimated.');
  assert(
    footprint.method === 'generic-character-estimate',
    'Context method was not labeled generic-character-estimate.',
  );
  assert(footprint.exactDuplicateGroups.length > 0, 'Exact duplicate hashes were not reported.');
  for (const category of ['instruction', 'skill', 'policy']) {
    assert(footprint.categories[category]?.sourceCount > 0, `Missing ${category} context.`);
  }
  await cli(['context', 'scan', '--agent', 'claude-demo', '--project', project.id]);
  const claudeFootprint = await cli(['context', 'footprint', project.id, 'claude-demo']);
  for (const category of ['instruction', 'skill', 'hook-definition', 'mcp-definition']) {
    assert(
      claudeFootprint.categories[category]?.sourceCount > 0,
      `Missing Claude ${category} context.`,
    );
  }

  const sessions = [];
  for (const agentId of ['codex-demo', 'codex-demo', 'claude-demo', 'gemini-demo', 'kimi-demo']) {
    sessions.push(
      await cli([
        'session',
        'register',
        '--project',
        project.id,
        '--agent',
        agentId,
        '--working-directory',
        projectRoot,
      ]),
    );
  }
  assert(sessions[0].id !== sessions[1].id, 'Same-agent sessions were not distinct.');
  const claudeSession = sessions[2];
  const geminiSession = sessions[3];
  const crossProjectSession = await cli([
    'session',
    'register',
    '--project',
    projectTwo.id,
    '--agent',
    'codex-demo',
    '--working-directory',
    secondProjectRoot,
  ]);
  await cli(['session', 'heartbeat', sessions[0].id]);
  await cli(['session', 'status', sessions[0].id, 'tool_running']);
  await cli(['session', 'status', geminiSession.id, 'waiting_for_input']);
  let crossProjectError;
  try {
    await cli([
      'message',
      'ask',
      '--source',
      claudeSession.id,
      '--target-session',
      crossProjectSession.id,
      '--kind',
      'question',
      '--content',
      'This cross-project request must be rejected.',
    ]);
  } catch (error) {
    crossProjectError = error;
  }
  assert(
    crossProjectError?.code === 'TARGET_PROJECT_MISMATCH',
    'Cross-project message routing was not rejected.',
  );
  const idempotencyKey = `phase3-demo-${runId}`;
  const message = await cli([
    'message',
    'ask',
    '--source',
    claudeSession.id,
    '--target-session',
    geminiSession.id,
    '--kind',
    'status_request',
    '--content',
    'Report fixture project status.',
    '--idempotency-key',
    idempotencyKey,
  ]);
  const retry = await cli([
    'message',
    'ask',
    '--source',
    claudeSession.id,
    '--target-session',
    geminiSession.id,
    '--kind',
    'status_request',
    '--content',
    'Report fixture project status.',
    '--idempotency-key',
    idempotencyKey,
  ]);
  assert(retry.idempotent, 'Message retry was not identified as idempotent.');
  assert(
    retry.message.correlationId === message.message.correlationId,
    'Message retry created a different correlation ID.',
  );
  const correlationId = message.message.correlationId;
  await cli([
    'inbox',
    'claim',
    '--session',
    geminiSession.id,
    '--bridge-instance',
    'phase3-demo-gemini',
    '--block-ms',
    '0',
    '--min-idle-ms',
    '0',
  ]);
  await cli(['message', 'acknowledge', correlationId, '--session', geminiSession.id]);
  await cli(['message', 'processing', correlationId, '--session', geminiSession.id]);
  const terminalMessage = await cli([
    'message',
    'respond',
    correlationId,
    '--session',
    geminiSession.id,
    '--answer',
    'Fixture status verified.',
    '--evidence',
    JSON.stringify([
      {
        type: 'session_state',
        summary: 'Sandboxed Phase 2 regression evidence.',
        metadata: { sandboxed: true },
      },
    ]),
  ]);
  assert(terminalMessage.state === 'responded', 'Phase 2 response did not become terminal.');
  const timeoutMessage = await cli([
    'message',
    'ask',
    '--source',
    claudeSession.id,
    '--target-session',
    geminiSession.id,
    '--kind',
    'question',
    '--content',
    'This request intentionally times out.',
    '--timeout-ms',
    '200',
  ]);
  await delay(300);
  const timedOut = await cli(['message', 'get', timeoutMessage.message.correlationId]);
  assert(timedOut.state === 'timed_out', 'Message timeout did not become terminal.');

  await delay(1_800);
  await cli(['session', 'heartbeat', sessions[0].id]);
  await delay(1_500);
  const keptAliveSession = await cli(['session', 'get', sessions[0].id]);
  const expiredSession = await cli(['session', 'get', geminiSession.id]);
  assert(keptAliveSession.presence === 'online', 'Heartbeat did not preserve online presence.');
  assert(
    expiredSession.presence === 'offline' && expiredSession.status === 'disconnected',
    'Expired session was not disconnected by the presence sweeper.',
  );

  const mcpTarget = await cli([
    'session',
    'register',
    '--project',
    project.id,
    '--agent',
    'gemini-demo',
    '--working-directory',
    projectRoot,
  ]);
  const mcpAsk = await mcp(
    'luwi_ask_agent',
    {
      targetSessionId: mcpTarget.id,
      kind: 'question',
      content: 'Run the Phase 2 MCP regression exchange.',
      evidenceRequirements: ['session_state'],
      timeoutMs: 2_000,
      waitMs: 0,
    },
    sessions[0].id,
  );
  const mcpCorrelationId = mcpAsk.structuredContent?.correlationId;
  assert(mcpCorrelationId, 'Phase 2 MCP ask did not return a correlation ID.');
  await cli([
    'inbox',
    'claim',
    '--session',
    mcpTarget.id,
    '--bridge-instance',
    'phase3-demo-mcp-target',
    '--block-ms',
    '0',
    '--min-idle-ms',
    '0',
  ]);
  await cli(['message', 'acknowledge', mcpCorrelationId, '--session', mcpTarget.id]);
  await cli(['message', 'processing', mcpCorrelationId, '--session', mcpTarget.id]);
  await cli([
    'message',
    'respond',
    mcpCorrelationId,
    '--session',
    mcpTarget.id,
    '--answer',
    'MCP regression verified.',
    '--evidence',
    JSON.stringify([
      {
        type: 'session_state',
        summary: 'Sandboxed MCP request/reply evidence.',
        metadata: { sandboxed: true },
      },
    ]),
  ]);
  const mcpTerminal = await mcp(
    'luwi_get_message',
    { correlationId: mcpCorrelationId },
    sessions[0].id,
  );
  assert(
    mcpTerminal.structuredContent?.state === 'responded',
    'Phase 2 MCP message did not become terminal.',
  );

  const mcpResult = await mcp(
    'luwi_get_effective_config',
    { agentId: 'gemini-demo' },
    sessions[0].id,
  );
  assert(mcpResult.structuredContent?.valid === true, 'Phase 3 MCP read tool failed.');
  await cli(['agent', 'disable', 'codex-demo']);
  const historicalSession = await cli(['session', 'get', sessions[0].id]);
  assert(historicalSession.agentId === 'codex-demo', 'Agent disable rewrote session history.');
  await cli(['events', 'list', '--limit', '100']);

  await access(forbiddenExecutionMarker)
    .then(() => {
      throw new Error('A discovered hook, plugin, or MCP command was executed.');
    })
    .catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });

  process.stdout.write(
    `${JSON.stringify(
      {
        phase: 3,
        status: 'passed',
        sandbox,
        detectedAgents: detected.installations.length,
        projectAgents: Object.keys(projectBindings).length,
        sameAgentSessions: 2,
        contextEstimate: {
          source: footprint.source,
          method: footprint.method,
          estimatedTokens: footprint.estimatedTokens,
        },
        claudeContextCategories: Object.keys(claudeFootprint.categories).sort(),
        phase1PresenceExpiry: true,
        phase2IdempotencyAndTimeout: true,
        phase2McpRoundTrip: true,
        redisCompletionRecovery: true,
        nativeCodeExecuted: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  process.env.PATH = originalPath;
  await runtime?.shutdown.shutdown('SIGTERM').catch(() => undefined);
  runtime?.shutdown.dispose();
  await cleanupRedis().catch(() => undefined);
  await rm(sandbox, { recursive: true, force: true });
}
