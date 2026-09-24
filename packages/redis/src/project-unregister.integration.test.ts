import { randomUUID } from 'node:crypto';

import {
  createRuntimeEvent,
  normalizeLeasePath,
  type GitObservation,
  type OptimizationFinding,
  type PackageRecord,
  type TechnologyRecord,
  type UsageRecord,
  type WorkLease,
} from '@luwi/protocol';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildFunctionLibrary,
  createCoordinatorRepository,
  createFunctionRegistry,
  createIntelligenceRepository,
  createLeaseRepository,
  createProjectPurge,
  createRedisKeys,
  createRuntimeRepository,
  type CoordinatorRepository,
  type IntelligenceRepository,
  type LeaseRepository,
  type ProjectPurge,
  type RedisCommandClient,
  type RuntimeRepository,
} from './index.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';
const timestamp = '2026-09-17T00:00:00.000Z';

/**
 * Project unregister (F3) against a real server.
 *
 * The claims only a real Redis can check: the Function refuses while a session
 * is still in the project's set, the purge takes every key and index member the
 * project owned and nothing of another project's, the path identity is freed so
 * the same folder can be registered again, and the one event lands on the
 * global stream.
 */
describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)('project unregister', () => {
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const namespace = `luwi:test:${runId}:v1`;
  const keys = createRedisKeys(namespace);
  const registry = createFunctionRegistry(runId);
  const library = buildFunctionLibrary(registry);
  let client: RedisClientType;
  let commandClient: RedisCommandClient;
  let runtime: RuntimeRepository;
  let leases: LeaseRepository;
  let coordinator: CoordinatorRepository;
  let intelligence: IntelligenceRepository;
  let purge: ProjectPurge;

  const projectId = 'project-1';
  const otherProjectId = 'project-2';
  const pathIdentityHash = 'f'.repeat(64);

  const event = (type: Parameters<typeof createRuntimeEvent>[0]['type'], id = randomUUID()) =>
    createRuntimeEvent(
      { type, workspaceId: 'local', projectId, payload: {} },
      { createId: () => id, now: () => new Date(timestamp) },
    );

  const registerProject = (id: string, hash: string) =>
    runtime.registerProject({
      project: {
        id,
        name: id,
        localPath: `C:/workspace/${id}`,
        canonicalPath: `C:/workspace/${id}`,
        identityPath: `c:/workspace/${id}`,
        pathIdentityHash: hash,
      },
      workspaceId: 'local',
      eventId: randomUUID(),
    });

  const registerSession = (sessionId: string, project = projectId) =>
    runtime.registerSession({
      session: {
        id: sessionId,
        agentId: 'codex',
        projectId: project,
        status: 'starting',
        workingDirectory: `C:/workspace/${project}`,
        metadataJson: '{}',
      },
      workspaceId: 'local',
      eventId: randomUUID(),
      presenceTtlMs: 60_000,
    });

  const closeSession = (sessionId: string, project = projectId) =>
    runtime.closeSession({
      sessionId,
      projectId: project,
      workspaceId: 'local',
      eventId: randomUUID(),
    });

  const scanKeys = async (): Promise<string[]> => {
    const found: string[] = [];
    let cursor = '0';
    do {
      const reply = (await commandClient.sendCommand([
        'SCAN',
        cursor,
        'MATCH',
        `${namespace}:*`,
        'COUNT',
        '200',
      ])) as [string, string[]];
      cursor = reply[0];
      found.push(...reply[1]);
    } while (cursor !== '0');
    return found;
  };

  beforeAll(async () => {
    client = createClient({ url: testRedisUrl });
    client.on('error', () => undefined);
    await client.connect();
    commandClient = { sendCommand: (arguments_) => client.sendCommand([...arguments_]) };
    await commandClient.sendCommand(['FUNCTION', 'LOAD', library.source]);
    const options = { client: commandClient, keys, functions: registry };
    runtime = createRuntimeRepository(options);
    leases = createLeaseRepository(options);
    coordinator = createCoordinatorRepository(options);
    intelligence = createIntelligenceRepository(options);
    purge = createProjectPurge({ client: commandClient, keys });
    await registerProject(projectId, pathIdentityHash);
    await registerProject(otherProjectId, 'e'.repeat(64));
  });

  afterAll(async () => {
    if (client?.isOpen) {
      const stale = await scanKeys();
      if (stale.length > 0) await commandClient.sendCommand(['DEL', ...stale]);
      await commandClient.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]);
      await client.quit();
    }
  });

  it('answers not_found for a project that does not exist', async () => {
    await expect(
      runtime.unregisterProject({ projectId: 'nope', event: event('project.unregistered') }),
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('refuses while a session is registered, then removes everything the project owned and nothing else', async () => {
    // --- seed: two sessions (one ends), a lease acquired and released, usage,
    // a git observation, a package inventory, a finding, the coordinator role.
    await registerSession('s-a');
    await registerSession('s-b');
    await registerSession('s-other', otherProjectId);
    await closeSession('s-a');

    const normalized = normalizeLeasePath('src/a.ts');
    const lease: WorkLease = {
      id: 'lease-1',
      projectId,
      sessionId: 's-a',
      agentId: 'codex',
      path: normalized.path,
      matchPath: normalized.matchPath,
      reason: 'editing',
      state: 'held',
      acquiredAt: timestamp,
      expiresAt: '2026-09-17T00:05:00.000Z',
    };
    const nowMs = Date.parse(timestamp);
    await expect(
      leases.acquireLease({
        lease,
        grantedEvent: event('lease.acquired'),
        deniedEvent: event('lease.denied'),
        nowMs,
        expiresMs: nowMs + 300_000,
      }),
    ).resolves.toMatchObject({ status: 'granted' });
    await leases.releaseLease({
      lease,
      event: event('lease.released'),
      holderSessionId: 's-a',
    });

    const usage: UsageRecord = {
      id: 'usage-1',
      projectId,
      agentId: 'codex',
      sessionId: 's-a',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      source: 'agent-exact',
      confidence: 'exact',
      observedAt: timestamp,
      sourceEventId: 'provider-event-1',
      createdAt: timestamp,
      metadata: {},
    };
    await intelligence.ingestUsage(usage, event('usage.reported'));

    const observation: GitObservation = {
      id: 'git-1',
      projectId,
      repositoryRoot: `C:/workspace/${projectId}`,
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      branches: [],
      tags: [],
      worktrees: [],
      recentCommits: [],
      observedAt: timestamp,
      repositoryStateHash: 'a'.repeat(64),
    };
    await intelligence.putGitObservation(observation, event('git.observed'));

    const packageRecord: PackageRecord = {
      id: 'pkg-zod',
      projectId,
      ecosystem: 'node',
      packageName: 'zod',
      declaredVersion: '^4',
      dependencyType: 'production',
      direct: true,
      workspaceLocation: '.',
      manifestPath: 'package.json',
      detectedAt: timestamp,
      manifestHash: 'c'.repeat(64),
    };
    const technology: TechnologyRecord = {
      id: 'tech-typescript',
      projectId,
      name: 'TypeScript',
      category: 'language',
      confidence: 'high',
      evidence: [{ kind: 'file-pattern', value: '*.ts' }],
      detectedAt: timestamp,
    };
    await intelligence.replacePackageInventory(
      projectId,
      [packageRecord],
      [technology],
      ['.'],
      event('package.inventory.updated'),
    );

    const finding: OptimizationFinding = {
      id: 'finding-1',
      projectId,
      kind: 'oversized-always-loaded-source',
      contextSourceId: 'source-1',
      title: 'Oversized source',
      summary: 'Structural estimate exceeds the configured threshold.',
      state: 'open',
      evidenceWindow: {
        startedAt: timestamp,
        endedAt: timestamp,
        sessionCount: 1,
        observationCount: 1,
      },
      confidence: 'high',
      evidenceIds: ['source-1'],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await intelligence.putOptimizationFinding(finding, event('optimization.finding.detected'));

    // Messages are written field by field by `message_request` and read back
    // the same way; the purge's contract is that hash and these indexes, so
    // they are seeded directly rather than through the request Function's
    // liveness preconditions. One in flight, one terminal.
    const seedMessage = async (id: string, correlationId: string, state: string) => {
      await commandClient.sendCommand([
        'HSET',
        keys.message(id),
        'id',
        id,
        'correlationId',
        correlationId,
        'projectId',
        projectId,
        'sourceSessionId',
        's-a',
        'targetSessionId',
        's-b',
        'state',
        state,
      ]);
      await commandClient.sendCommand(['SET', keys.messageCorrelation(correlationId), id]);
      await commandClient.sendCommand(['SET', keys.messageIdempotency('s-a', id), id]);
      for (const index of [
        keys.projectMessages(projectId),
        keys.messagesIndex,
        keys.sourceSessionMessages('s-a'),
        keys.targetSessionMessages('s-b'),
      ]) {
        await commandClient.sendCommand(['ZADD', index, '1', id]);
      }
    };
    await seedMessage('m-done', 'c-done', 'responded');
    await commandClient.sendCommand(['ZADD', keys.terminalMessages, '1', 'm-done']);
    await seedMessage('m-live', 'c-live', 'delivered');

    await expect(
      coordinator.claimCoordinator({
        record: {
          projectId,
          sessionId: 's-b',
          agentId: 'codex',
          claimId: 'claim-1',
          claimedAt: timestamp,
          version: 1,
        },
        expectedVersion: 0,
        expectedClaimId: '',
        event: event('coordinator.claimed'),
      }),
    ).resolves.toMatchObject({ status: 'claimed' });

    // --- the Function refuses while the session set has members, and the
    // purge refuses a session that is not terminal.
    await expect(
      runtime.unregisterProject({ projectId, event: event('project.unregistered') }),
    ).resolves.toEqual({ status: 'raced', sessions: 2 });
    await expect(purge.purgeProjectLeaves(projectId)).rejects.toMatchObject({
      code: 'PROJECT_HAS_ACTIVE_SESSIONS',
    });
    expect(await runtime.getProject(projectId)).not.toBeNull();

    // --- end the last session; the message in flight still blocks, and the
    // refusal has written nothing (the terminal session is still there).
    await closeSession('s-b');
    await expect(purge.purgeProjectLeaves(projectId)).rejects.toMatchObject({
      code: 'PROJECT_HAS_INFLIGHT_MESSAGES',
    });
    expect(await runtime.getSession('s-a')).not.toBeNull();
    await commandClient.sendCommand(['HSET', keys.message('m-live'), 'state', 'failed']);

    // --- now the leaves go, then the atomic end.
    const summary = await purge.purgeProjectLeaves(projectId);
    expect(summary).toMatchObject({
      sessions: 2,
      messages: 2,
      usage: 1,
      gitObservations: 1,
      packages: 1,
      technologies: 1,
      findings: 1,
    });
    expect(await commandClient.sendCommand(['EXISTS', keys.messageCorrelation('c-done')])).toBe(0);
    expect(await commandClient.sendCommand(['EXISTS', keys.messageCorrelation('c-live')])).toBe(0);
    expect(
      await commandClient.sendCommand(['EXISTS', keys.messageIdempotency('s-a', 'm-done')]),
    ).toBe(0);
    expect(await commandClient.sendCommand(['ZSCORE', keys.messagesIndex, 'm-done'])).toBeNull();
    expect(await commandClient.sendCommand(['ZSCORE', keys.terminalMessages, 'm-done'])).toBeNull();
    await expect(
      runtime.unregisterProject({ projectId, event: event('project.unregistered', 'evt-gone') }),
    ).resolves.toMatchObject({ status: 'unregistered' });

    // --- zero residue: no key names the project or anything it owned, and
    // the global indexes no longer list its records.
    const remaining = await scanKeys();
    // A released lease record was never indexed by project and is not part of
    // the unregister (it is reachable by id only); everything else the project
    // owned — including its project- and session-scoped usage counters — is gone.
    const owned = [
      projectId,
      's-a',
      's-b',
      'usage-1',
      'git-1',
      'finding-1',
      'pkg-zod',
      'm-done',
      'm-live',
      'c-done',
      'c-live',
    ];
    const residue = remaining.filter((key) => owned.some((id) => key.includes(id)));
    expect(residue).toEqual([]);
    expect(remaining.filter((key) => key.includes('lease-1'))).toEqual([keys.lease('lease-1')]);
    expect(await commandClient.sendCommand(['SISMEMBER', keys.projectsIndex, projectId])).toBe(0);
    expect(await commandClient.sendCommand(['SISMEMBER', keys.usageIndex, 'usage-1'])).toBe(0);
    expect(await commandClient.sendCommand(['SISMEMBER', keys.gitObservationsIndex, 'git-1'])).toBe(
      0,
    );
    expect(
      await commandClient.sendCommand(['SISMEMBER', keys.optimizationFindingsIndex, 'finding-1']),
    ).toBe(0);
    expect(await commandClient.sendCommand(['SISMEMBER', keys.agentSessions('codex'), 's-a'])).toBe(
      0,
    );
    expect(await commandClient.sendCommand(['ZSCORE', keys.heartbeatDeadlines, 's-b'])).toBeNull();
    expect(
      await commandClient.sendCommand(['EXISTS', keys.projectPathIndex(pathIdentityHash)]),
    ).toBe(0);
    expect(await runtime.getProject(projectId)).toBeNull();

    // --- the other project and its session are untouched.
    expect(await runtime.getProject(otherProjectId)).not.toBeNull();
    expect(await runtime.getSession('s-other')).not.toBeNull();
    expect(
      await commandClient.sendCommand(['SISMEMBER', keys.agentSessions('codex'), 's-other']),
    ).toBe(1);

    // --- the one event, on the global stream only (the project stream is gone).
    const latest = (await commandClient.sendCommand([
      'XREVRANGE',
      keys.globalEvents,
      '+',
      '-',
      'COUNT',
      '1',
    ])) as Array<[string, string[]]>;
    const encoded = latest[0]?.[1]?.[1];
    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded as string)).toMatchObject({
      id: 'evt-gone',
      type: 'project.unregistered',
      projectId,
    });
    expect(await commandClient.sendCommand(['EXISTS', keys.projectEvents(projectId)])).toBe(0);

    // --- the folder can be registered again: the path identity was freed.
    await expect(registerProject(projectId, pathIdentityHash)).resolves.toMatchObject({
      status: 'created',
    });
  });
});
