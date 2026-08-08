import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configOperationReceiptSchema,
  contextFootprintSchema,
  type AgentDefinition,
  type ConfigDrift,
  type ConfigOperationReceipt,
  type ConfigPlan,
  type EffectiveAgentConfiguration,
} from '@luwi/protocol';
import type { ControlPlaneRepository } from '@luwi/redis';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanonicalStore } from './canonical-store.js';
import { createConfigControlService } from './config-control-service.js';
import { hashFileContent } from './config-file-engine.js';
import type { ControlPlaneService } from './control-plane-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe('config control service', () => {
  it(
    'plans, approves, applies, detects drift, and safely rolls back native config',
    // Dozens of sequential real-disk round-trips legitimately exceed vitest's 5s default
    // on a saturated machine; the explicit timeout only guards against a hang.
    { timeout: 20_000 },
    async () => {
      const globalRoot = await mkdtemp(join(tmpdir(), 'luwi-config-global-'));
      const projectRoot = await mkdtemp(join(tmpdir(), 'luwi-config-project-'));
      const homeRoot = await mkdtemp(join(tmpdir(), 'luwi-config-home-'));
      roots.push(globalRoot, projectRoot, homeRoot);
      const target = join(projectRoot, '.codex', 'config.toml');
      await mkdir(join(projectRoot, '.codex'), { recursive: true });
      await writeFile(target, 'model = "old"\napproval_policy = "on-request"\n');

      const plans = new Map<string, ConfigPlan>();
      const operations = new Map<string, ConfigOperationReceipt>();
      const drifts = new Map<string, ConfigDrift>();
      const receiptStates: Array<{ planId: string; state: ConfigOperationReceipt['state'] }> = [];
      const reconciliationNotices: string[] = [];
      let failCompletionOnce = false;
      let failApplyingTransitionOnce = false;
      const repository = {
        getConfigPlan: async (id: string) => plans.get(id) ?? null,
        listConfigPlans: async () => [...plans.values()],
        transitionConfigPlan: async (_expected: string, plan: ConfigPlan) => {
          plans.set(plan.id, plan);
          if (failApplyingTransitionOnce && plan.state === 'applying') {
            failApplyingTransitionOnce = false;
            throw new Error('simulated uncertain applying transition');
          }
        },
        completeConfigPlan: async (
          _expected: string,
          plan: ConfigPlan,
          operation: ConfigOperationReceipt,
        ) => {
          if (failCompletionOnce) {
            failCompletionOnce = false;
            throw new Error('simulated Redis projection failure');
          }
          plans.set(plan.id, plan);
          operations.set(operation.id, operation);
        },
        getConfigOperation: async (id: string) => operations.get(id) ?? null,
        appendEvent: async () => undefined,
        putConfigOperation: async (_mode: string, operation: ConfigOperationReceipt) => {
          operations.set(operation.id, operation);
        },
        listConfigDrifts: async () => [...drifts.values()],
        putConfigDrift: async (_mode: string, drift: ConfigDrift) => {
          drifts.set(drift.id, drift);
        },
        deleteConfigDrift: async (drift: ConfigDrift) => {
          drifts.delete(drift.id);
        },
      } as unknown as ControlPlaneRepository;
      const agent: AgentDefinition = {
        id: 'codex-main',
        kind: 'codex',
        displayName: 'Codex',
        enabled: true,
        adapterId: 'codex-native-v1',
        nativeConfigRoots: [join(homeRoot, '.codex'), join(projectRoot, '.codex')],
        createdAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        metadata: {},
      };
      const effective: EffectiveAgentConfiguration = {
        projectId: 'project-1',
        agentId: agent.id,
        agentKind: 'codex',
        valid: true,
        capabilities: [],
        profileIds: [],
        settings: { model: 'new' },
        provenance: [],
        conflicts: [],
        missingDependencies: [],
        unsupportedCapabilities: [],
        nativeCapabilitySupport: [],
        estimatedContextFootprint: contextFootprintSchema.parse({
          projectId: 'project-1',
          agentId: agent.id,
          source: 'estimated',
          method: 'generic-character-estimate',
          totalBytes: 0,
          totalLines: 0,
          estimatedTokens: 0,
          categories: {},
          exactDuplicateGroups: [],
          measuredAt: '2026-07-29T12:00:00.000Z',
        }),
      };
      const controlPlane = {
        getAgent: async () => agent,
        getEffectiveConfiguration: async () => effective,
      } as unknown as ControlPlaneService;
      const baseCanonicalStore = createCanonicalStore({ globalRoot });
      const canonicalStore = {
        ...baseCanonicalStore,
        async writeOperationReceipt(receipt: ConfigOperationReceipt) {
          receiptStates.push({ planId: receipt.planId, state: receipt.state });
          await baseCanonicalStore.writeOperationReceipt(receipt);
        },
      };
      let id = 0;
      const service = createConfigControlService({
        repository,
        canonicalStore,
        controlPlane,
        projects: {
          get: async () => ({
            id: 'project-1',
            name: 'Fixture',
            localPath: projectRoot,
            canonicalPath: projectRoot,
            createdAt: '2026-07-29T12:00:00.000Z',
            updatedAt: '2026-07-29T12:00:00.000Z',
          }),
        },
        workspaceId: 'local',
        homeDirectory: homeRoot,
        createId: () => `id-${String(++id)}`,
        createApprovalToken: () => 'a'.repeat(43),
        onReconciliationRequired: (error) => reconciliationNotices.push(error.code),
        now: () => new Date('2026-07-29T12:00:00.000Z'),
      });

      const optimizationPlan = await service.createOptimizationPlan({
        proposalId: 'proposal-1',
        projectId: 'project-1',
        agentId: agent.id,
        contextSourceId: 'context-source-1',
        loadingMode: 'reference-only',
      });
      expect(optimizationPlan.kind).toBe('optimization');
      await expect(
        readFile(join(projectRoot, '.luwi', 'manifest.json'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const optimizationApproval = await service.approvePlan(optimizationPlan.id);
      await expect(
        service.applyPlan(optimizationPlan.id, optimizationApproval.approvalToken),
      ).resolves.toMatchObject({ state: 'completed' });
      const optimizedManifest = JSON.parse(
        await readFile(join(projectRoot, '.luwi', 'manifest.json'), 'utf8'),
      ) as {
        data: { agentDefaults: Record<string, { contextLoadingModes: Record<string, string> }> };
      };
      expect(
        optimizedManifest.data.agentDefaults[agent.id]?.contextLoadingModes['context-source-1'],
      ).toBe('reference-only');

      await expect(
        service.createRenderPlan({
          agentId: agent.id,
          projectId: 'project-1',
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_CONFIG_UNMANAGED' });

      const tamperedPlan = await service.createRenderPlan({
        agentId: agent.id,
        projectId: 'project-1',
        adoptUnmanaged: true,
      });
      const tamperedApproval = await service.approvePlan(tamperedPlan.id);
      const artifactPath = join(globalRoot, 'operations', `${tamperedPlan.id}.plan.json`);
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
        files: Array<{ content: string }>;
      };
      if (artifact.files[0] !== undefined) artifact.files[0].content = 'model = "tampered"\n';
      await writeFile(artifactPath, `${JSON.stringify(artifact)}\n`);

      await expect(
        service.applyPlan(tamperedPlan.id, tamperedApproval.approvalToken),
      ).rejects.toMatchObject({ code: 'CONFIG_PLAN_PRECONDITION_FAILED' });
      expect(plans.get(tamperedPlan.id)?.state).toBe('approved');
      expect(await readFile(target, 'utf8')).toBe(
        'model = "old"\napproval_policy = "on-request"\n',
      );

      const plan = await service.createRenderPlan({
        agentId: agent.id,
        projectId: 'project-1',
        adoptUnmanaged: true,
      });
      expect(plan.changes[0]?.redactedDiff).not.toContain('model =');
      expect(JSON.parse(plan.changes[0]?.redactedDiff ?? '{}')).toMatchObject({
        operation: 'update',
        after: {
          renderedSettingKeys: ['approval_policy', 'model'],
        },
      });
      const approved = await service.approvePlan(plan.id);
      const operation = await service.applyPlan(plan.id, approved.approvalToken);

      expect(await readFile(target, 'utf8')).toContain('model = "new"');
      expect(await readFile(target, 'utf8')).toContain('approval_policy = "on-request"');
      expect(operation.snapshotId).toBeDefined();
      const appliedStates = receiptStates
        .filter(({ planId }) => planId === plan.id)
        .map(({ state }) => state);
      expect(appliedStates.indexOf('prepared')).toBeLessThan(appliedStates.indexOf('snapshotted'));
      expect(appliedStates.indexOf('snapshotted')).toBeLessThan(appliedStates.indexOf('writing'));
      expect(appliedStates.indexOf('writing')).toBeLessThan(
        appliedStates.indexOf('files_committed'),
      );
      expect(appliedStates.indexOf('files_committed')).toBeLessThan(
        appliedStates.indexOf('completed'),
      );
      await expect(service.applyPlan(plan.id, approved.approvalToken)).rejects.toMatchObject({
        code: 'CONFIG_PLAN_NOT_APPROVED',
      });

      await writeFile(target, 'model = "external"\n');
      const detected = await service.scanDrift();
      expect(detected).toHaveLength(1);
      expect(await readFile(target, 'utf8')).toBe('model = "external"\n');

      const rollback = await service.createRollbackPlan(operation.snapshotId ?? '');
      const rollbackApproval = await service.approvePlan(rollback.id);
      await service.applyPlan(rollback.id, rollbackApproval.approvalToken);

      expect(await readFile(target, 'utf8')).toBe(
        'model = "old"\napproval_policy = "on-request"\n',
      );
      await expect(service.scanDrift()).resolves.toEqual([]);
      expect(drifts.size).toBe(0);
      await writeFile(
        target,
        'model = "old"\napproval_policy = "on-request"\nunknown_native_key = "preserve-me"\n',
      );
      await expect(
        service.createRenderPlan({
          agentId: agent.id,
          projectId: 'project-1',
          adoptUnmanaged: true,
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_CONFIG_UNMANAGED' });
      expect(await readFile(target, 'utf8')).toContain('unknown_native_key');
      await writeFile(target, 'model = "old"\napproval_policy = "on-request"\n');

      const competingPlans = await Promise.all([
        service.createRenderPlan({
          agentId: agent.id,
          projectId: 'project-1',
        }),
        service.createRenderPlan({
          agentId: agent.id,
          projectId: 'project-1',
        }),
      ]);
      const competingApprovals = await Promise.all(
        competingPlans.map((candidate) => service.approvePlan(candidate.id)),
      );
      const competingResults = await Promise.allSettled(
        competingPlans.map((candidate, index) =>
          service.applyPlan(candidate.id, competingApprovals[index]?.approvalToken ?? ''),
        ),
      );
      expect(competingResults.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(competingResults.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      expect(competingResults.find(({ status }) => status === 'rejected')).toMatchObject({
        reason: { code: 'CONFIG_APPLY_FAILED' },
      });
      expect(operations.size).toBe(4);

      const reconciliationPlan = await service.createRenderPlan({
        agentId: agent.id,
        projectId: 'project-1',
      });
      const reconciliationApproval = await service.approvePlan(reconciliationPlan.id);
      failCompletionOnce = true;
      await expect(
        service.applyPlan(reconciliationPlan.id, reconciliationApproval.approvalToken),
      ).rejects.toMatchObject({ code: 'CONFIG_RECONCILIATION_REQUIRED' });
      expect(plans.get(reconciliationPlan.id)?.state).toBe('applying');
      expect(reconciliationNotices).toEqual(['CONFIG_RECONCILIATION_REQUIRED']);

      const reconciled = await service.reconcile();

      expect(reconciled).toHaveLength(1);
      expect(plans.get(reconciliationPlan.id)?.state).toBe('applied');
      expect(operations.get(reconciled[0]?.id ?? '')?.state).toBe('completed');

      const importPlan = await service.createImportPlan({
        agentId: agent.id,
        projectId: 'project-1',
      });
      expect(importPlan.changes[0]?.path).toBe(join(projectRoot, '.luwi', 'manifest.json'));
      const importApproval = await service.approvePlan(importPlan.id);
      const imported = await service.applyPlan(importPlan.id, importApproval.approvalToken);

      expect(imported.snapshotId).toBeDefined();
      expect(
        JSON.parse(await readFile(join(projectRoot, '.luwi', 'manifest.json'), 'utf8')),
      ).toMatchObject({
        data: {
          agentDefaults: {
            [agent.id]: {
              model: 'new',
              approval_policy: 'on-request',
            },
          },
        },
      });

      const uncertainPlan = await service.createRenderPlan({
        agentId: agent.id,
        projectId: 'project-1',
      });
      const uncertainApproval = await service.approvePlan(uncertainPlan.id);
      failApplyingTransitionOnce = true;
      await expect(
        service.applyPlan(uncertainPlan.id, uncertainApproval.approvalToken),
      ).rejects.toThrow('simulated uncertain applying transition');
      expect(plans.get(uncertainPlan.id)?.state).toBe('applying');
      const interrupted = await service.reconcile();
      expect(interrupted).toContainEqual(
        expect.objectContaining({
          planId: uncertainPlan.id,
          state: 'failed',
          failureCode: 'INTERRUPTED_BEFORE_FILE_COMMIT',
        }),
      );
      expect(plans.get(uncertainPlan.id)?.state).toBe('failed');

      const targetHash = hashFileContent(await readFile(target));
      await baseCanonicalStore.writeOperationReceipt(
        configOperationReceiptSchema.parse({
          id: 'orphan-operation',
          planId: 'missing-plan',
          agentId: agent.id,
          projectId: 'project-1',
          state: 'files_committed',
          targetPaths: [target],
          expectedHashes: { [target]: targetHash },
          committedHashes: { [target]: targetHash },
          startedAt: '2026-07-29T12:00:00.000Z',
          updatedAt: '2026-07-29T12:00:00.000Z',
        }),
      );
      await expect(service.reconcile()).rejects.toMatchObject({
        code: 'CONFIG_RECONCILIATION_REQUIRED',
      });
    },
  );
});
