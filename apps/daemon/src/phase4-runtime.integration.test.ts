import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
  type ManagedRedisConnection,
} from '@luwi/redis';
import { afterAll, describe, expect, it } from 'vitest';

import type { DaemonConfig } from './config.js';
import { startDaemon, type RunningDaemon } from './runtime.js';

const execFileAsync = promisify(execFile);
const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'Phase 4 daemon and Redis intelligence integration',
  () => {
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const namespace = `luwi:test:${runId}:v1`;
    const keys = createRedisKeys(namespace);
    const registry = createFunctionRegistry(runId);
    let runtime: RunningDaemon | undefined;
    let sandboxRoot: string | undefined;

    function connections(): {
      command: ManagedRedisConnection;
      admin: ManagedRedisConnection;
      relay: ManagedRedisConnection;
    } {
      return {
        command: createManagedRedisConnection({ url: testRedisUrl ?? '' }),
        admin: createManagedRedisConnection({ url: testRedisUrl ?? '' }),
        relay: createManagedRedisConnection({ url: testRedisUrl ?? '' }),
      };
    }

    async function git(root: string, ...arguments_: string[]): Promise<void> {
      await execFileAsync('git', ['-C', root, ...arguments_], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
    }

    afterAll(async () => {
      await runtime?.shutdown.shutdown('SIGTERM');
      runtime?.shutdown.dispose();
      const cleanup = createManagedRedisConnection({ url: testRedisUrl ?? '' });
      await cleanup.connect();
      let cursor = '0';
      do {
        const reply = (await cleanup.sendCommand([
          'SCAN',
          cursor,
          'MATCH',
          `${namespace}:*`,
          'COUNT',
          '100',
        ])) as [string, string[]];
        cursor = reply[0];
        if (reply[1].length > 0) await cleanup.sendCommand(['DEL', ...reply[1]]);
      } while (cursor !== '0');
      await cleanup.sendCommand(['FUNCTION', 'DELETE', registry.libraryName]).catch(() => 0);
      await cleanup.quit();
      if (sandboxRoot !== undefined) await rm(sandboxRoot, { recursive: true, force: true });
    });

    it('observes a sandbox project from telemetry through graph and structural proposals', async () => {
      sandboxRoot = await mkdtemp(join(tmpdir(), 'luwi-phase4-integration-'));
      const projectRoot = join(sandboxRoot, 'project');
      const nativeHome = join(sandboxRoot, 'native-home');
      const luwiHome = join(sandboxRoot, 'luwi-home');
      await Promise.all([
        mkdir(projectRoot, { recursive: true }),
        mkdir(join(nativeHome, '.codex'), { recursive: true }),
      ]);
      const instructions = `# Sandboxed instructions\n${'Use local evidence only.\n'.repeat(2000)}`;
      await Promise.all([
        writeFile(join(projectRoot, 'AGENTS.md'), instructions),
        writeFile(
          join(projectRoot, 'package.json'),
          `${JSON.stringify(
            {
              name: 'phase4-sandbox',
              private: true,
              dependencies: { zod: '^4.0.0' },
              devDependencies: { typescript: '^6.0.0', vitest: '^4.0.0' },
            },
            null,
            2,
          )}\n`,
        ),
      ]);
      // Two workspace packages with a real cross-package import, so the ADR
      // 0012 structural layer has something to resolve. Neither declares a
      // dependency: before ADR 0014 that made them invisible as modules and the
      // module dependency below could not be observed at all.
      await mkdir(join(projectRoot, 'packages', 'alpha', 'src'), { recursive: true });
      await mkdir(join(projectRoot, 'packages', 'beta', 'src'), { recursive: true });
      await Promise.all([
        writeFile(
          join(projectRoot, 'packages', 'alpha', 'package.json'),
          `${JSON.stringify({ name: 'alpha', private: true }, null, 2)}\n`,
        ),
        writeFile(
          join(projectRoot, 'packages', 'beta', 'package.json'),
          `${JSON.stringify({ name: 'beta', private: true }, null, 2)}\n`,
        ),
        writeFile(
          join(projectRoot, 'packages', 'alpha', 'src', 'index.ts'),
          'export const alphaValue = 1;\n',
        ),
        writeFile(
          join(projectRoot, 'packages', 'beta', 'src', 'index.ts'),
          "import { alphaValue } from '../../alpha/src/index.js';\n\nexport const betaValue = alphaValue + 1;\n",
        ),
      ]);

      await git(projectRoot, 'init');
      await git(projectRoot, 'config', 'user.name', 'LUWI Fixture');
      await git(projectRoot, 'config', 'user.email', 'fixture@example.invalid');
      await git(projectRoot, 'add', 'AGENTS.md', 'package.json', 'packages');
      await git(projectRoot, 'commit', '-m', 'Initial sandbox state');

      const config: DaemonConfig = {
        host: '127.0.0.1',
        port: 48_784,
        redisUrl: testRedisUrl ?? '',
        logLevel: 'silent',
        workspaceId: 'local',
        luwiHome,
        nativeHome,
        sessionPresenceTtlMs: 5_000,
        presenceSweepIntervalMs: 50,
        heartbeatEventIntervalMs: 100,
        consumerClaimIdleMs: 0,
        relayBlockMs: 25,
        messageTimeoutSweepIntervalMs: 25,
        messageTimeoutBatchSize: 10,
        retentionIntervalMs: 60_000,
        gitScanIntervalMs: 60_000,
        drainTimeoutMs: 1_000,
        optimizationMinimumBaselineSessions: 1,
        optimizationOversizedContextTokens: 100,
        allowedOrigins: ['http://127.0.0.1:48784'],
      };
      runtime = await startDaemon({
        config,
        logger: false,
        runtimeInstanceId: 'runtime-phase4',
        keys,
        functionRegistry: registry,
        connections: connections(),
      });

      const projectResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: { name: 'Phase 4 sandbox', localPath: projectRoot },
      });
      expect(projectResponse.statusCode, projectResponse.body).toBe(201);
      const projectId = projectResponse.json<{ id: string }>().id;
      expect(
        (
          await runtime.app.inject({
            method: 'POST',
            url: '/api/v1/agents',
            payload: {
              id: 'codex-fixture',
              kind: 'codex',
              displayName: 'Codex fixture',
              enabled: true,
              adapterId: 'codex-native-v1',
              nativeConfigRoots: [join(nativeHome, '.codex'), join(projectRoot, '.codex')],
              metadata: {},
            },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await runtime.app.inject({
            method: 'POST',
            url: `/api/v1/projects/${projectId}/agents`,
            payload: {
              agentId: 'codex-fixture',
              enabled: true,
              profileIds: [],
              capabilityBindingIds: [],
              overrides: {},
            },
          })
        ).statusCode,
      ).toBe(201);
      const sessionResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {
          projectId,
          agentId: 'codex-fixture',
          workingDirectory: projectRoot,
          branch: 'master',
          metadata: { source: 'phase4-integration' },
        },
      });
      expect(sessionResponse.statusCode).toBe(201);
      const sessionId = sessionResponse.json<{ id: string }>().id;

      await writeFile(join(projectRoot, 'README.md'), '# Phase 4 sandbox\n');
      await git(projectRoot, 'add', 'README.md');
      await git(
        projectRoot,
        'commit',
        '-m',
        `Observed work\n\nLuwi-Agent: codex-fixture\nLuwi-Session: ${sessionId}\nLuwi-Project: ${projectId}`,
      );
      await writeFile(join(projectRoot, 'dirty.txt'), 'uncommitted fixture\n');

      const usage = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/usage',
        headers: { 'idempotency-key': 'phase4-exact-1' },
        payload: {
          projectId,
          agentId: 'codex-fixture',
          sessionId,
          model: 'fixture-model',
          provider: 'fixture-provider',
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          source: 'agent-exact',
          confidence: 'exact',
          observedAt: new Date().toISOString(),
          metadata: { simulated: true },
        },
      });
      expect(usage.statusCode, usage.body).toBe(201);

      const contextScan = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/context/scan',
        payload: { agentId: 'codex-fixture', projectId },
      });
      expect(contextScan.statusCode, contextScan.body).toBe(200);
      const contextAnalysis = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/context/analyze',
        payload: { projectId, agentId: 'codex-fixture' },
      });
      expect(contextAnalysis.statusCode, contextAnalysis.body).toBe(200);
      expect(contextAnalysis.json().contributions[0]).toMatchObject({
        assigned: true,
        effective: true,
        loaded: 'unknown',
        invoked: 'unknown',
      });

      const gitScan = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/git/scan`,
      });
      expect(gitScan.statusCode, gitScan.body).toBe(200);
      expect(gitScan.json()).toMatchObject({ clean: false });
      expect(gitScan.json().untrackedCount).toBeGreaterThanOrEqual(1);
      const attribution = await runtime.app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/git/attributions`,
      });
      expect(attribution.statusCode).toBe(200);
      expect(attribution.json().attributions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId,
            agentId: 'codex-fixture',
            confidence: 'exact',
          }),
        ]),
      );

      const packageScan = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/packages/scan`,
      });
      expect(packageScan.statusCode, packageScan.body).toBe(200);
      expect(packageScan.json().packages).toEqual(
        expect.arrayContaining([expect.objectContaining({ packageName: 'zod' })]),
      );
      expect(packageScan.json().technologies).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'TypeScript' })]),
      );

      const rebuild = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/graph/rebuild',
      });
      expect(rebuild.statusCode, rebuild.body).toBe(202);
      expect(rebuild.json()).toMatchObject({
        state: 'completed',
        activeGeneration: expect.any(String),
      });
      const graph = await runtime.app.inject({
        method: 'GET',
        url: `/api/v1/graph/subgraph?nodeKind=project&nodeId=${projectId}&maxDepth=2&nodeLimit=250`,
      });
      expect(graph.statusCode, graph.body).toBe(200);
      expect(JSON.stringify(graph.json())).not.toContain('Use local evidence only');

      // ADR 0012: the structural layer reaches the same generation as the
      // event-derived one, and the ADR 0013 summary counts it.
      const graphSummary = await runtime.app.inject({
        method: 'GET',
        url: '/api/v1/graph/summary',
      });
      expect(graphSummary.statusCode, graphSummary.body).toBe(200);
      const edgeKinds = new Map<string, number>(
        graphSummary
          .json<{ edgeCountsByKind: Array<{ kind: string; count: number }> }>()
          .edgeCountsByKind.map(({ kind, count }) => [kind, count]),
      );
      expect(edgeKinds.get('FILE_IMPORTS_FILE')).toBe(1);
      expect(edgeKinds.get('MODULE_DEPENDS_ON_MODULE')).toBe(1);
      // Structural edges never replace the event-derived ones.
      expect(edgeKinds.get('COMMIT_TOUCHES_FILE')).toBeGreaterThan(0);

      const optimization = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/optimization/analyze',
        payload: { projectId, agentId: 'codex-fixture', minimumSessions: 1 },
      });
      expect(optimization.statusCode, optimization.body).toBe(200);
      expect(optimization.json().findings).not.toHaveLength(0);
      expect(optimization.json().proposals).not.toHaveLength(0);
      expect(optimization.json().proposals[0].state).toBe('ready');

      const summary = await runtime.app.inject({
        method: 'GET',
        url: `/api/v1/usage/summary?projectId=${projectId}`,
      });
      expect(summary.json().sources).toEqual([
        expect.objectContaining({ source: 'agent-exact', totalTokens: 120 }),
      ]);
    });
  },
);
