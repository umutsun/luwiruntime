import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFunctionRegistry,
  createManagedRedisConnection,
  createRedisKeys,
  type ManagedRedisConnection,
} from '@luwi/redis';
import { afterAll, describe, expect, it } from 'vitest';

import type { DaemonConfig } from './config.js';
import { startDaemon, type RunningDaemon } from './runtime.js';

const testRedisUrl = process.env.LUWI_TEST_REDIS_URL;
const sharedFunctionsAllowed = process.env.LUWI_TEST_ALLOW_SHARED_REDIS_FUNCTIONS === 'true';

describe.skipIf(testRedisUrl === undefined || !sharedFunctionsAllowed)(
  'Phase 3 daemon and Redis integration',
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
      if (sandboxRoot !== undefined) {
        await rm(sandboxRoot, { recursive: true, force: true });
      }
    });

    it('manages a sandboxed agent, capability, config plan, drift, and rollback', async () => {
      sandboxRoot = await mkdtemp(join(tmpdir(), 'luwi-phase3-integration-'));
      const projectRoot = join(sandboxRoot, 'project');
      const nativeHome = join(sandboxRoot, 'native-home');
      const luwiHome = join(sandboxRoot, 'luwi-home');
      await Promise.all([
        mkdir(projectRoot, { recursive: true }),
        mkdir(join(nativeHome, '.codex'), { recursive: true }),
      ]);
      const duplicateInstructions = '# Sandboxed instructions\nNever execute discovered scripts.\n';
      await Promise.all([
        writeFile(join(projectRoot, 'AGENTS.md'), duplicateInstructions),
        writeFile(join(nativeHome, '.codex', 'AGENTS.md'), duplicateInstructions),
      ]);

      const config: DaemonConfig = {
        host: '127.0.0.1',
        port: 48_783,
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
        drainTimeoutMs: 1_000,
        allowedOrigins: ['http://127.0.0.1:48783'],
      };
      runtime = await startDaemon({
        config,
        logger: false,
        runtimeInstanceId: 'runtime-phase3',
        keys,
        functionRegistry: registry,
        connections: connections(),
      });

      const projectResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        payload: { name: 'Phase 3 fixture', localPath: projectRoot },
      });
      expect(projectResponse.statusCode).toBe(201);
      const projectId = projectResponse.json<{ id: string }>().id;

      const agentResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/agents',
        payload: {
          id: 'codex-fixture',
          kind: 'codex',
          displayName: 'Codex fixture',
          enabled: true,
          adapterId: 'codex-native-v1',
          nativeConfigRoots: [join(nativeHome, '.codex'), join(projectRoot, '.codex')],
          metadata: { settings: { model: 'gpt-5-fixture' } },
        },
      });
      expect(agentResponse.statusCode).toBe(201);

      const capabilityResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/capabilities',
        payload: {
          id: 'typescript-development',
          kind: 'skill',
          name: 'TypeScript development',
          scope: 'global',
          source: 'bundled',
          compatibleAgentKinds: ['codex'],
          requiredCapabilityIds: [],
          requiredMcpIds: [],
          enabled: true,
          manifest: { loadingPolicy: 'conditional' },
        },
      });
      expect(capabilityResponse.statusCode).toBe(201);
      const assignmentResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/capabilities/typescript-development/assign',
        payload: {
          scope: 'project',
          projectId,
          agentId: 'codex-fixture',
          enabled: true,
          settings: { reasoningEffort: 'medium' },
        },
      });
      expect(assignmentResponse.statusCode).toBe(200);
      const assignmentId = assignmentResponse.json<{ id: string }>().id;
      for (const [id, kind, manifest] of [
        ['status-mcp', 'mcp', { transport: 'stdio', command: 'never-executed' }],
        ['git-policy', 'policy', { shellConfirmation: true }],
      ] as const) {
        expect(
          (
            await runtime.app.inject({
              method: 'POST',
              url: '/api/v1/capabilities',
              payload: {
                id,
                kind,
                name: id,
                scope: 'global',
                source: 'bundled',
                compatibleAgentKinds: ['codex'],
                requiredCapabilityIds: [],
                requiredMcpIds: [],
                enabled: true,
                manifest,
              },
            })
          ).statusCode,
        ).toBe(201);
      }
      const additionalAssignments: string[] = [];
      for (const capabilityId of ['status-mcp', 'git-policy']) {
        const response = await runtime.app.inject({
          method: 'POST',
          url: `/api/v1/capabilities/${capabilityId}/assign`,
          payload: {
            scope: 'project',
            projectId,
            agentId: 'codex-fixture',
            enabled: true,
            settings: {},
          },
        });
        expect(response.statusCode).toBe(200);
        additionalAssignments.push(response.json<{ id: string }>().id);
      }
      const bindingResponse = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/agents`,
        payload: {
          agentId: 'codex-fixture',
          enabled: true,
          role: 'implementer',
          profileIds: [],
          capabilityBindingIds: [assignmentId, ...additionalAssignments],
          overrides: { model: 'gpt-5-fixture-project' },
        },
      });
      expect(bindingResponse.statusCode).toBe(201);
      const projectBindingId = bindingResponse.json<{ id: string }>().id;

      const effective = await runtime.app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/agents/codex-fixture/effective-config`,
      });
      expect(effective.json()).toMatchObject({
        valid: true,
        settings: { model: 'gpt-5-fixture-project', reasoningEffort: 'medium' },
        capabilities: expect.arrayContaining([
          expect.objectContaining({ id: 'typescript-development' }),
        ]),
        nativeCapabilitySupport: expect.arrayContaining([
          expect.objectContaining({
            capabilityId: 'status-mcp',
            supportLevel: 'read-only',
          }),
          expect.objectContaining({
            capabilityId: 'git-policy',
            policyMode: 'informational-only',
          }),
        ]),
      });

      const nativeTarget = join(projectRoot, '.codex', 'config.toml');
      await mkdir(join(projectRoot, '.codex'), { recursive: true });
      await writeFile(nativeTarget, 'model = "imported-project"\napproval_policy = "on-request"\n');
      const importPlan = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/config/import-plan',
        payload: { agentId: 'codex-fixture', projectId },
      });
      expect(importPlan.statusCode, importPlan.body).toBe(201);
      const importPlanId = importPlan.json<{ id: string }>().id;
      const importApproval = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/config/plans/${importPlanId}/approve`,
        payload: {},
      });
      const importApplied = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/config/plans/${importPlanId}/apply`,
        payload: {
          approvalToken: importApproval.json<{ approvalToken: string }>().approvalToken,
        },
      });
      expect(importApplied.statusCode, importApplied.body).toBe(200);
      expect(importApplied.json<{ snapshotId?: string }>().snapshotId).toBeDefined();
      const effectiveAfterImport = await runtime.app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/agents/codex-fixture/effective-config`,
      });
      expect(effectiveAfterImport.json()).toMatchObject({
        settings: {
          model: 'gpt-5-fixture-project',
          approval_policy: 'on-request',
        },
        provenance: expect.arrayContaining([
          expect.objectContaining({
            key: 'settings.approval_policy',
            sourceScope: 'project-default',
            precedence: 5,
          }),
        ]),
      });

      const planResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/config/render-plan',
        payload: { agentId: 'codex-fixture', projectId, adoptUnmanaged: true },
      });
      expect(planResponse.statusCode).toBe(201);
      const planId = planResponse.json<{ id: string }>().id;
      const approval = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/config/plans/${planId}/approve`,
        payload: {},
      });
      const approvalToken = approval.json<{ approvalToken: string }>().approvalToken;
      const applied = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/config/plans/${planId}/apply`,
        payload: { approvalToken },
      });
      expect(applied.statusCode).toBe(200);
      const receipt = applied.json<{ snapshotId: string }>();
      await expect(readFile(nativeTarget, 'utf8')).resolves.toContain(
        'model = "gpt-5-fixture-project"',
      );
      expect(
        (
          await runtime.app.inject({
            method: 'GET',
            url: `/api/v1/config/snapshots/${receipt.snapshotId}`,
          })
        ).statusCode,
      ).toBe(200);

      await writeFile(nativeTarget, 'model = "external-edit"\n');
      const drift = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/config/drift/scan',
        payload: {},
      });
      expect(drift.json()).toMatchObject({
        drifts: [expect.objectContaining({ agentId: 'codex-fixture', resolution: 'manual' })],
      });
      await expect(readFile(nativeTarget, 'utf8')).resolves.toContain('external-edit');

      const rollbackPlan = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/config/snapshots/${receipt.snapshotId}/rollback-plan`,
        payload: {},
      });
      const rollbackPlanId = rollbackPlan.json<{ id: string }>().id;
      const rollbackApproval = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/config/plans/${rollbackPlanId}/approve`,
        payload: {},
      });
      const rollbackToken = rollbackApproval.json<{ approvalToken: string }>().approvalToken;
      expect(
        (
          await runtime.app.inject({
            method: 'POST',
            url: `/api/v1/config/plans/${rollbackPlanId}/apply`,
            payload: { approvalToken: rollbackToken },
          })
        ).statusCode,
      ).toBe(200);
      await expect(readFile(nativeTarget, 'utf8')).resolves.toContain('model = "imported-project"');

      const contextScan = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/context/scan',
        payload: { agentId: 'codex-fixture', projectId },
      });
      expect(contextScan.statusCode, contextScan.body).toBe(200);
      const initialProjectInstruction = contextScan
        .json<{ sources: Array<{ id: string; path: string; hash: string }> }>()
        .sources.find(({ path }) => path === join(projectRoot, 'AGENTS.md'));
      const footprint = await runtime.app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/agents/codex-fixture/context-footprint`,
      });
      expect(footprint.json()).toMatchObject({
        source: 'estimated',
        method: 'generic-character-estimate',
        categories: {
          instruction: expect.objectContaining({ sourceCount: 2 }),
          skill: expect.objectContaining({ sourceCount: 1 }),
          'mcp-definition': expect.objectContaining({ sourceCount: 1 }),
          policy: expect.objectContaining({ sourceCount: 1 }),
        },
        exactDuplicateGroups: [expect.arrayContaining([expect.any(String), expect.any(String)])],
      });
      await writeFile(join(projectRoot, 'AGENTS.md'), '# Updated sandbox instructions\n');
      const updatedContextScan = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/context/scan',
        payload: { agentId: 'codex-fixture', projectId },
      });
      const updatedProjectInstruction = updatedContextScan
        .json<{ sources: Array<{ id: string; path: string; hash: string }> }>()
        .sources.find(({ path }) => path === join(projectRoot, 'AGENTS.md'));
      expect(updatedProjectInstruction?.id).toBe(initialProjectInstruction?.id);
      expect(updatedProjectInstruction?.hash).not.toBe(initialProjectInstruction?.hash);

      for (const [method, url] of [
        ['GET', '/api/v1/agents'],
        ['GET', `/api/v1/projects/${projectId}/agents`],
        ['GET', `/api/v1/projects/${projectId}/agents/${projectBindingId}`],
        ['GET', '/api/v1/capabilities?kind=skill&limit=10'],
        ['POST', '/api/v1/capabilities/scan'],
        ['GET', '/api/v1/capabilities/typescript-development'],
        ['GET', '/api/v1/config/plans'],
        ['GET', `/api/v1/config/plans/${planId}`],
        ['GET', '/api/v1/config/snapshots'],
        ['GET', '/api/v1/config/drift'],
        ['GET', `/api/v1/context/sources?projectId=${projectId}&agentId=codex-fixture`],
      ] as const) {
        const response = await runtime.app.inject({
          method,
          url,
          ...(method === 'POST' ? { payload: {} } : {}),
        });
        expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(200);
      }
      expect(
        (
          await runtime.app.inject({
            method: 'POST',
            url: '/api/v1/config/inspect',
            payload: { agentId: 'codex-fixture', projectId },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await runtime.app.inject({
            method: 'PATCH',
            url: '/api/v1/capabilities/typescript-development',
            payload: { name: 'TypeScript development fixture' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await runtime.app.inject({
            method: 'PATCH',
            url: `/api/v1/projects/${projectId}/agents/${projectBindingId}`,
            payload: { role: 'verified implementer' },
          })
        ).statusCode,
      ).toBe(200);
      const profileResponse = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/profiles',
        payload: {
          id: 'integration-profile',
          name: 'Integration profile',
          scope: 'global',
          capabilityIds: ['typescript-development'],
          policyIds: ['git-policy'],
          disabledCapabilityIds: [],
          adapterSettings: {},
        },
      });
      expect(profileResponse.statusCode, profileResponse.body).toBe(201);
      for (const url of ['/api/v1/profiles', '/api/v1/profiles/integration-profile']) {
        const response = await runtime.app.inject({ method: 'GET', url });
        expect(response.statusCode, `GET ${url}: ${response.body}`).toBe(200);
      }
      expect(
        (
          await runtime.app.inject({
            method: 'PATCH',
            url: '/api/v1/profiles/integration-profile',
            payload: { name: 'Updated integration profile' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await runtime.app.inject({
            method: 'POST',
            url: '/api/v1/config/reconcile',
            payload: {},
          })
        ).statusCode,
      ).toBe(200);

      const firstSession = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {
          projectId,
          agentId: 'codex-fixture',
          workingDirectory: projectRoot,
        },
      });
      const secondSession = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {
          projectId,
          agentId: 'codex-fixture',
          workingDirectory: projectRoot,
        },
      });
      expect(firstSession.statusCode).toBe(201);
      expect(secondSession.statusCode).toBe(201);
      expect(
        (
          await runtime.app.inject({
            method: 'PATCH',
            url: '/api/v1/agents/codex-fixture',
            payload: { enabled: false },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await runtime.app.inject({
            method: 'GET',
            url: `/api/v1/sessions/${firstSession.json<{ id: string }>().id}`,
          })
        ).statusCode,
      ).toBe(200);

      await runtime.shutdown.shutdown('SIGTERM');
      runtime.shutdown.dispose();
      runtime = undefined;
      const projectionMutation = createManagedRedisConnection({ url: testRedisUrl ?? '' });
      await projectionMutation.connect();
      await projectionMutation.sendCommand(['DEL', keys.agentDefinition('codex-fixture')]);
      await projectionMutation.sendCommand(['SREM', keys.agentDefinitionsIndex, 'codex-fixture']);
      await projectionMutation.quit();

      runtime = await startDaemon({
        config,
        logger: false,
        runtimeInstanceId: 'runtime-phase3-recovered',
        keys,
        functionRegistry: registry,
        connections: connections(),
      });
      const rebuiltAgent = await runtime.app.inject({
        method: 'GET',
        url: '/api/v1/agents/codex-fixture',
      });
      expect(rebuiltAgent.statusCode, rebuiltAgent.body).toBe(200);
      expect(rebuiltAgent.json()).toMatchObject({ id: 'codex-fixture', enabled: false });
      expect(
        (
          await runtime.app.inject({
            method: 'POST',
            url: '/api/v1/capabilities/typescript-development/unassign',
            payload: {
              scope: 'project',
              projectId,
              agentId: 'codex-fixture',
              enabled: true,
              settings: { reasoningEffort: 'medium' },
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await runtime.app.inject({
            method: 'DELETE',
            url: `/api/v1/projects/${projectId}/agents/${projectBindingId}`,
          })
        ).statusCode,
      ).toBe(200);
    });
  },
);
