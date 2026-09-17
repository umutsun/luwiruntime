import { describe, expect, it } from 'vitest';

import {
  agentDefinitionSchema,
  capabilityAssignmentRequestSchema,
  capabilityPackageSchema,
  capabilityScanResponseSchema,
  configPlanSchema,
  configSnapshotSchema,
  contextFootprintSchema,
  contextSourceSchema,
  effectiveAgentConfigurationSchema,
  nativeConfigInspectionSchema,
  projectAgentBindingPatchRequestSchema,
  projectAgentBindingSchema,
} from './index.js';

const timestamp = '2026-07-29T20:00:00.000Z';

describe('Phase 3 control-plane contracts', () => {
  it('allows Phase 4 to reuse ConfigPlan for an approved canonical optimization change', () => {
    expect(
      configPlanSchema.parse({
        id: 'plan-optimization',
        projectId: 'project-1',
        agentId: 'codex',
        state: 'prepared',
        kind: 'optimization',
        changes: [
          {
            path: 'C:/repo/.luwi/manifest.json',
            operation: 'update',
            managementMode: 'managed-file',
            beforeHash: 'a'.repeat(64),
            afterHash: 'b'.repeat(64),
            redactedDiff: '{"action":"change-loading-mode"}',
            warnings: [],
          },
        ],
        preconditionHashes: { 'C:/repo/.luwi/manifest.json': 'a'.repeat(64) },
        createdAt: '2026-07-30T00:00:00.000Z',
        expiresAt: '2026-07-30T01:00:00.000Z',
      }).kind,
    ).toBe('optimization');
  });

  it('validates agent definitions without coupling historical sessions', () => {
    expect(
      agentDefinitionSchema.parse({
        id: 'codex-main',
        kind: 'codex',
        displayName: 'Codex',
        enabled: true,
        adapterId: 'codex',
        nativeConfigRoots: ['C:/fixture-home/.codex'],
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      }),
    ).toMatchObject({ id: 'codex-main', kind: 'codex' });
    expect(
      agentDefinitionSchema.safeParse({
        id: '../codex',
        kind: 'codex',
      }).success,
    ).toBe(false);
  });

  it('validates project bindings and capability packages with explicit scope', () => {
    expect(
      projectAgentBindingSchema.parse({
        id: 'project-1:codex-main',
        projectId: 'project-1',
        agentId: 'codex-main',
        enabled: true,
        profileIds: ['backend-implementation'],
        capabilityBindingIds: ['binding-typescript'],
        overrides: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      }).profileIds,
    ).toEqual(['backend-implementation']);

    // Flow roles (F5): a bounded, unique enum beside the free-text `role`; the
    // coordinator is a session claim and never a binding role. An empty array
    // clears them.
    expect(
      projectAgentBindingPatchRequestSchema.parse({ flowRoles: ['implementer', 'verifier'] })
        .flowRoles,
    ).toEqual(['implementer', 'verifier']);
    expect(projectAgentBindingPatchRequestSchema.safeParse({ flowRoles: [] }).success).toBe(true);
    expect(
      projectAgentBindingPatchRequestSchema.safeParse({ flowRoles: ['verifier', 'verifier'] })
        .success,
    ).toBe(false);
    expect(
      projectAgentBindingPatchRequestSchema.safeParse({ flowRoles: ['coordinator'] }).success,
    ).toBe(false);

    expect(
      capabilityPackageSchema.parse({
        id: 'redis-development',
        kind: 'skill',
        name: 'Redis development',
        scope: 'project',
        projectId: 'project-1',
        source: 'luwi-project',
        path: 'C:/project/.luwi/capabilities/skills/redis-development',
        checksum: 'a'.repeat(64),
        compatibleAgentKinds: ['codex', 'claude-code'],
        requiredCapabilityIds: [],
        requiredMcpIds: [],
        enabled: true,
        manifest: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toMatchObject({ id: 'redis-development', projectId: 'project-1' });
    expect(
      capabilityPackageSchema.safeParse({
        id: 'broken',
        kind: 'skill',
        name: 'Broken',
        scope: 'project',
        source: 'luwi-project',
        checksum: 'not-a-hash',
      }).success,
    ).toBe(false);
    expect(
      capabilityAssignmentRequestSchema.safeParse({
        scope: 'global',
        projectId: 'project-1',
        enabled: true,
        settings: {},
      }).success,
    ).toBe(false);
    expect(
      capabilityAssignmentRequestSchema.safeParse({
        scope: 'project',
        enabled: true,
        settings: {},
      }).success,
    ).toBe(false);
  });

  it('validates bounded capability observation diagnostics separately from the catalogue', () => {
    const observed = capabilityPackageSchema.parse({
      id: 'observed:abc123',
      kind: 'skill',
      name: 'Review',
      scope: 'global',
      source: 'agent-native',
      path: 'C:/fixture/.claude/skills/review',
      checksum: 'a'.repeat(64),
      compatibleAgentKinds: ['claude-code'],
      requiredCapabilityIds: [],
      requiredMcpIds: [],
      enabled: true,
      manifest: {
        managementMode: 'observed',
        observation: {
          adapterId: 'claude-code',
          root: 'C:/fixture/.claude/skills',
          manifestPath: 'C:/fixture/.claude/skills/review/SKILL.md',
          observedAt: timestamp,
        },
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(
      capabilityScanResponseSchema.parse({
        capabilities: [observed],
        diagnostics: {
          rootsScanned: 1,
          rootsUnavailable: 2,
          malformedManifests: 3,
          ignoredEntries: 4,
          conflictsSkipped: 5,
          truncated: false,
        },
      }),
    ).toMatchObject({
      diagnostics: { malformedManifests: 3, conflictsSkipped: 5, truncated: false },
    });
    expect(
      capabilityScanResponseSchema.safeParse({
        capabilities: [],
        diagnostics: {
          rootsScanned: -1,
          rootsUnavailable: 0,
          malformedManifests: 0,
          ignoredEntries: 0,
          conflictsSkipped: 0,
          truncated: false,
        },
      }).success,
    ).toBe(false);
  });

  it('preserves effective-config provenance and explicit conflicts', () => {
    expect(
      effectiveAgentConfigurationSchema.parse({
        projectId: 'project-1',
        agentId: 'codex-main',
        agentKind: 'codex',
        valid: false,
        capabilities: [],
        profileIds: ['backend-implementation'],
        settings: {},
        provenance: [
          {
            key: 'settings.model',
            sourceScope: 'project-agent',
            sourceId: 'project-1:codex-main',
            sourceFile: 'C:/project/.luwi/agent-bindings.json',
            precedence: 8,
            overrideReason: 'Project-agent override',
          },
        ],
        conflicts: [
          {
            code: 'CAPABILITY_DEPENDENCY_MISSING',
            message: 'A required capability is missing.',
            capabilityId: 'redis-development',
            relatedCapabilityId: 'git-safety',
          },
        ],
        missingDependencies: ['git-safety'],
        unsupportedCapabilities: [],
        nativeCapabilitySupport: [],
        estimatedContextFootprint: {
          source: 'estimated',
          method: 'generic-character-estimate',
          totalBytes: 0,
          totalLines: 0,
          estimatedTokens: 0,
          categories: {},
          exactDuplicateGroups: [],
          measuredAt: timestamp,
        },
      }).valid,
    ).toBe(false);
  });

  it('validates inspection, plans, snapshots, and bounded redacted changes', () => {
    expect(
      nativeConfigInspectionSchema.parse({
        agentId: 'codex-main',
        adapterId: 'codex',
        supportLevel: 'full',
        files: [
          {
            path: 'C:/fixture-home/.codex/config.toml',
            canonicalPath: 'C:/fixture-home/.codex/config.toml',
            hash: 'b'.repeat(64),
            sizeBytes: 120,
            parseStatus: 'parsed',
            managementMode: 'observed',
            detectedCapabilityIds: [],
            unsupportedFields: [],
            warnings: [],
            redactedFields: ['mcp_servers.example.env.API_KEY'],
          },
        ],
        contextSources: [],
        warnings: [],
        inspectedAt: timestamp,
      }).files[0]?.managementMode,
    ).toBe('observed');

    const plan = configPlanSchema.parse({
      id: 'plan-1',
      agentId: 'codex-main',
      state: 'prepared',
      kind: 'render',
      changes: [
        {
          path: 'C:/fixture-home/.codex/luwi-managed.toml',
          operation: 'create',
          managementMode: 'managed-file',
          afterHash: 'c'.repeat(64),
          redactedDiff: '+ [mcp_servers.luwi]\\n+ command = "luwi-mcp"',
          warnings: [],
        },
      ],
      preconditionHashes: {
        'C:/fixture-home/.codex/luwi-managed.toml': null,
      },
      createdAt: timestamp,
      expiresAt: '2026-07-29T20:10:00.000Z',
    });
    expect(plan.state).toBe('prepared');

    expect(
      configSnapshotSchema.parse({
        id: 'snapshot-1',
        operationId: 'operation-1',
        planId: plan.id,
        agentId: 'codex-main',
        createdAt: timestamp,
        schemaVersion: 1,
        adapterVersion: '1',
        files: [
          {
            targetPath: 'C:/fixture-home/.codex/luwi-managed.toml',
            existed: false,
            originalHash: null,
            snapshotPath: 'C:/fixture-home/.luwi/snapshots/snapshot-1/file-0.bin',
          },
        ],
        redactedManifest: {},
      }).files[0]?.existed,
    ).toBe(false);
  });

  it('labels every context estimate as generic and estimated', () => {
    const source = contextSourceSchema.parse({
      id: 'source-1',
      projectId: 'project-1',
      agentId: 'codex-main',
      agentKind: 'codex',
      sourceType: 'instruction',
      path: 'C:/project/AGENTS.md',
      byteCount: 400,
      lineCount: 20,
      hash: 'd'.repeat(64),
      loadingScope: 'project',
      loadingMode: 'automatic',
      managementMode: 'observed',
      estimatedTokenCount: 100,
      estimationSource: 'estimated',
      estimationMethod: 'generic-character-estimate',
      measuredAt: timestamp,
    });
    expect(source.estimationSource).toBe('estimated');
    expect(
      contextFootprintSchema.safeParse({
        source: 'exact',
        method: 'model-tokenizer',
      }).success,
    ).toBe(false);
  });
});
