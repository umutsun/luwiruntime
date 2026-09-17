import { z } from 'zod';

import { agentIdSchema } from './session.js';

export const CONTROL_PLANE_COLLECTION_LIMIT = 100;
export const CONTROL_PLANE_MAX_COLLECTION_LIMIT = 1000;

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestampSchema = z.iso.datetime({ offset: false });
const pathSchema = z.string().trim().min(1).max(4096);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObjectSchema = z.record(z.string(), z.json());
const boundedStringArraySchema = z.array(z.string().trim().min(1).max(4096)).max(1000);

export const agentKindSchema = z.enum(['codex', 'claude-code', 'gemini-cli', 'kimi', 'other']);
export const capabilityKindSchema = z.enum([
  'skill',
  'plugin',
  'hook',
  'mcp',
  'policy',
  'profile',
  'instruction',
]);
export const capabilitySourceSchema = z.enum([
  'luwi-global',
  'luwi-project',
  'agent-native',
  'local-path',
  'bundled',
]);
export const capabilityScopeSchema = z.enum(['global', 'project']);
export const adapterSupportLevelSchema = z.enum(['full', 'partial', 'read-only', 'unsupported']);
export const managementModeSchema = z.enum(['observed', 'managed-fragment', 'managed-file']);

export const canonicalManifestHeaderSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifierSchema,
  scope: capabilityScopeSchema,
  contentHash: sha256Schema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const agentDefinitionSchema = z.strictObject({
  id: agentIdSchema,
  kind: agentKindSchema,
  displayName: z.string().trim().min(1).max(200),
  executable: pathSchema.optional(),
  detectedVersion: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean(),
  adapterId: identifierSchema,
  nativeConfigRoots: z.array(pathSchema).max(32),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  metadata: jsonObjectSchema,
});
export const agentDefinitionCreateRequestSchema = agentDefinitionSchema.omit({
  createdAt: true,
  updatedAt: true,
  detectedVersion: true,
});
export const agentDefinitionPatchRequestSchema = agentDefinitionSchema
  .pick({
    displayName: true,
    executable: true,
    enabled: true,
    adapterId: true,
    nativeConfigRoots: true,
    metadata: true,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one agent field is required.');
export const agentDefinitionCollectionSchema = z.strictObject({
  agents: z.array(agentDefinitionSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
});

export const detectedAgentInstallationSchema = z.strictObject({
  kind: agentKindSchema,
  adapterId: identifierSchema,
  executable: pathSchema.optional(),
  detectedVersion: z.string().trim().min(1).max(200).optional(),
  configRoots: z.array(pathSchema).max(32),
  supportLevel: adapterSupportLevelSchema,
  warnings: z.array(z.string().max(2000)).max(100),
});
export const agentDetectionResponseSchema = z.strictObject({
  installations: z.array(detectedAgentInstallationSchema).max(100),
});

/**
 * The flow roles a bound agent may hold in a project (F5, ADR 0036). The
 * coordinator is deliberately not one of them: it is a session-level claim
 * (ADR 0035), not agent configuration. The daemon records these; the external
 * flow script decides what an ambiguous or missing role means (ADR 0031/0035).
 */
export const flowRoleSchema = z.enum(['implementer', 'verifier']);
const flowRolesSchema = z
  .array(flowRoleSchema)
  .max(2)
  .refine((roles) => new Set(roles).size === roles.length, 'Flow roles must be unique.');
export const projectAgentBindingSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema,
  agentId: agentIdSchema,
  enabled: z.boolean(),
  role: z.string().trim().min(1).max(500).optional(),
  flowRoles: flowRolesSchema.optional(),
  profileIds: z.array(identifierSchema).max(100),
  capabilityBindingIds: z.array(identifierSchema).max(1000),
  overrides: jsonObjectSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export const projectAgentBindingCreateRequestSchema = projectAgentBindingSchema.omit({
  id: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
});
export const projectAgentBindingPatchRequestSchema = projectAgentBindingSchema
  .pick({
    enabled: true,
    role: true,
    flowRoles: true,
    profileIds: true,
    capabilityBindingIds: true,
    overrides: true,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one binding field is required.');
export const projectAgentBindingCollectionSchema = z.strictObject({
  bindings: z.array(projectAgentBindingSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
});

export const capabilityPackageSchema = z
  .strictObject({
    id: identifierSchema,
    kind: capabilityKindSchema,
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(200).optional(),
    scope: capabilityScopeSchema,
    projectId: identifierSchema.optional(),
    source: capabilitySourceSchema,
    path: pathSchema.optional(),
    checksum: sha256Schema,
    compatibleAgentKinds: z.array(agentKindSchema).max(16),
    requiredCapabilityIds: z.array(identifierSchema).max(100),
    requiredMcpIds: z.array(identifierSchema).max(100),
    enabled: z.boolean(),
    manifest: jsonObjectSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((value, context) => {
    if (value.scope === 'project' && value.projectId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Project-scoped capabilities require projectId.',
        path: ['projectId'],
      });
    }
    if (value.scope === 'global' && value.projectId !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Global capabilities cannot include projectId.',
        path: ['projectId'],
      });
    }
  });
export const capabilityPackageCreateRequestSchema = z
  .strictObject({
    id: identifierSchema,
    kind: capabilityKindSchema,
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(200).optional(),
    scope: capabilityScopeSchema,
    projectId: identifierSchema.optional(),
    source: capabilitySourceSchema,
    path: pathSchema.optional(),
    compatibleAgentKinds: z.array(agentKindSchema).max(16),
    requiredCapabilityIds: z.array(identifierSchema).max(100),
    requiredMcpIds: z.array(identifierSchema).max(100),
    enabled: z.boolean(),
    manifest: jsonObjectSchema,
  })
  .superRefine((value, context) => {
    if (value.scope === 'project' && value.projectId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Project-scoped capabilities require projectId.',
        path: ['projectId'],
      });
    }
    if (value.scope === 'global' && value.projectId !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Global capabilities cannot include projectId.',
        path: ['projectId'],
      });
    }
  });
export const capabilityPackagePatchRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    version: z.string().trim().min(1).max(200).optional(),
    path: pathSchema.optional(),
    compatibleAgentKinds: z.array(agentKindSchema).max(16).optional(),
    requiredCapabilityIds: z.array(identifierSchema).max(100).optional(),
    requiredMcpIds: z.array(identifierSchema).max(100).optional(),
    enabled: z.boolean().optional(),
    manifest: jsonObjectSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one capability field is required.');
export const capabilityCollectionSchema = z.strictObject({
  capabilities: z.array(capabilityPackageSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
  truncated: z.boolean().default(false),
});
const capabilityScanCountSchema = z.number().int().nonnegative().max(1_000_000);
export const capabilityScanResponseSchema = z.strictObject({
  capabilities: z.array(capabilityPackageSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
  diagnostics: z.strictObject({
    rootsScanned: capabilityScanCountSchema,
    rootsUnavailable: capabilityScanCountSchema,
    malformedManifests: capabilityScanCountSchema,
    ignoredEntries: capabilityScanCountSchema,
    conflictsSkipped: capabilityScanCountSchema,
    truncated: z.boolean(),
  }),
});
export const capabilityListQuerySchema = z.strictObject({
  kind: capabilityKindSchema.optional(),
  scope: capabilityScopeSchema.optional(),
  projectId: identifierSchema.optional(),
  agentId: agentIdSchema.optional(),
  enabled: z.coerce.boolean().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONTROL_PLANE_MAX_COLLECTION_LIMIT)
    .default(CONTROL_PLANE_COLLECTION_LIMIT),
});

const capabilityBindingObjectSchema = z.strictObject({
  id: identifierSchema,
  capabilityId: identifierSchema,
  scope: capabilityScopeSchema,
  projectId: identifierSchema.optional(),
  agentId: agentIdSchema.optional(),
  enabled: z.boolean(),
  settings: jsonObjectSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
function validateCapabilityBindingScope(
  value: { scope: 'global' | 'project'; projectId?: string | undefined },
  context: {
    addIssue(issue: { code: 'custom'; message: string; path: Array<string | number> }): void;
  },
): void {
  if (value.scope === 'project' && value.projectId === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Project-scoped capability assignments require projectId.',
      path: ['projectId'],
    });
  }
  if (value.scope === 'global' && value.projectId !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Global capability assignments cannot include projectId.',
      path: ['projectId'],
    });
  }
}
export const capabilityBindingSchema = capabilityBindingObjectSchema.superRefine(
  validateCapabilityBindingScope,
);
export const capabilityAssignmentRequestSchema = capabilityBindingObjectSchema
  .omit({
    id: true,
    capabilityId: true,
    createdAt: true,
    updatedAt: true,
  })
  .superRefine(validateCapabilityBindingScope);

const capabilityProfileObjectSchema = z.strictObject({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  scope: capabilityScopeSchema,
  projectId: identifierSchema.optional(),
  capabilityIds: z.array(identifierSchema).max(1000),
  policyIds: z.array(identifierSchema).max(1000),
  disabledCapabilityIds: z.array(identifierSchema).max(1000),
  adapterSettings: jsonObjectSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
function validateProfileScope(
  value: { scope: 'global' | 'project'; projectId?: string | undefined },
  context: {
    addIssue(issue: { code: 'custom'; message: string; path: Array<string | number> }): void;
  },
): void {
  if (value.scope === 'project' && value.projectId === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Project-scoped profiles require projectId.',
      path: ['projectId'],
    });
  }
  if (value.scope === 'global' && value.projectId !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Global profiles cannot include projectId.',
      path: ['projectId'],
    });
  }
}
export const capabilityProfileSchema =
  capabilityProfileObjectSchema.superRefine(validateProfileScope);
export const capabilityProfileCreateRequestSchema = capabilityProfileObjectSchema
  .omit({
    createdAt: true,
    updatedAt: true,
  })
  .superRefine(validateProfileScope);
export const capabilityProfilePatchRequestSchema = capabilityProfileObjectSchema
  .pick({
    name: true,
    capabilityIds: true,
    policyIds: true,
    disabledCapabilityIds: true,
    adapterSettings: true,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one profile field is required.');
export const capabilityProfileCollectionSchema = z.strictObject({
  profiles: z.array(capabilityProfileSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
});

export const configProvenanceSchema = z.strictObject({
  key: z.string().trim().min(1).max(1000),
  sourceScope: z.enum([
    'runtime-default',
    'agent-default',
    'global-profile',
    'global-capability',
    'project-default',
    'project-profile',
    'project-capability',
    'project-agent',
    'preview',
  ]),
  sourceId: identifierSchema.optional(),
  sourceFile: pathSchema.optional(),
  precedence: z.number().int().min(1).max(9),
  overrideReason: z.string().trim().min(1).max(2000),
});
export const effectiveConfigConflictSchema = z.strictObject({
  code: z.enum([
    'CAPABILITY_CONFLICT',
    'CAPABILITY_INCOMPATIBLE',
    'CAPABILITY_DEPENDENCY_MISSING',
    'PROFILE_CONFLICT',
  ]),
  message: z.string().trim().min(1).max(2000),
  capabilityId: identifierSchema.optional(),
  relatedCapabilityId: identifierSchema.optional(),
});
export const nativeCapabilitySupportSchema = z.strictObject({
  capabilityId: identifierSchema,
  capabilityKind: capabilityKindSchema,
  supportLevel: adapterSupportLevelSchema,
  policyMode: z
    .enum(['enforced-native', 'rendered-instruction', 'informational-only', 'unsupported'])
    .optional(),
});

export const contextFootprintCategorySchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
});
export const contextFootprintSchema = z.strictObject({
  projectId: identifierSchema.optional(),
  agentId: agentIdSchema.optional(),
  source: z.literal('estimated'),
  method: z.literal('generic-character-estimate'),
  totalBytes: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  categories: z.record(z.string(), contextFootprintCategorySchema),
  exactDuplicateGroups: z.array(z.array(identifierSchema).min(2).max(100)).max(100),
  measuredAt: timestampSchema,
});

export const effectiveAgentConfigurationSchema = z.strictObject({
  projectId: identifierSchema,
  agentId: agentIdSchema,
  agentKind: agentKindSchema,
  valid: z.boolean(),
  capabilities: z.array(capabilityPackageSchema).max(1000),
  profileIds: z.array(identifierSchema).max(100),
  settings: jsonObjectSchema,
  provenance: z.array(configProvenanceSchema).max(5000),
  conflicts: z.array(effectiveConfigConflictSchema).max(1000),
  missingDependencies: z.array(identifierSchema).max(1000),
  unsupportedCapabilities: z.array(identifierSchema).max(1000),
  nativeCapabilitySupport: z.array(nativeCapabilitySupportSchema).max(1000),
  estimatedContextFootprint: contextFootprintSchema,
});

export const nativeConfigFileInspectionSchema = z.strictObject({
  path: pathSchema,
  canonicalPath: pathSchema,
  hash: sha256Schema,
  sizeBytes: z.number().int().nonnegative(),
  parseStatus: z.enum(['parsed', 'malformed', 'unsupported', 'missing']),
  managementMode: managementModeSchema,
  detectedCapabilityIds: z.array(identifierSchema).max(1000),
  unsupportedFields: boundedStringArraySchema,
  warnings: z.array(z.string().max(2000)).max(100),
  redactedFields: boundedStringArraySchema,
});

export const contextSourceSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema.optional(),
  agentId: agentIdSchema.optional(),
  capabilityId: identifierSchema.optional(),
  agentKind: agentKindSchema.optional(),
  sourceType: z.enum([
    'instruction',
    'skill',
    'plugin-manifest',
    'hook-definition',
    'mcp-definition',
    'policy',
    'native-config',
  ]),
  path: pathSchema,
  byteCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  hash: sha256Schema,
  loadingScope: z.enum(['global', 'project', 'agent']),
  loadingMode: z.enum(['automatic', 'conditional', 'manual', 'unknown']),
  managementMode: managementModeSchema,
  estimatedTokenCount: z.number().int().nonnegative(),
  estimationSource: z.literal('estimated'),
  estimationMethod: z.literal('generic-character-estimate'),
  measuredAt: timestampSchema,
});
export const contextSourceCollectionSchema = z.strictObject({
  sources: z.array(contextSourceSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
  truncated: z.boolean().default(false),
});

export const nativeConfigInspectionSchema = z.strictObject({
  agentId: agentIdSchema,
  projectId: identifierSchema.optional(),
  adapterId: identifierSchema,
  supportLevel: adapterSupportLevelSchema,
  files: z.array(nativeConfigFileInspectionSchema).max(1000),
  contextSources: z.array(contextSourceSchema).max(1000),
  warnings: z.array(z.string().max(2000)).max(100),
  inspectedAt: timestampSchema,
});
export const nativeConfigInspectRequestSchema = z.strictObject({
  agentId: agentIdSchema,
  projectId: identifierSchema.optional(),
});
export const agentDetectionRequestSchema = z.strictObject({
  projectId: identifierSchema.optional(),
});
export const controlPlaneAgentParamsSchema = z.strictObject({
  agentId: agentIdSchema,
});
export const controlPlaneProjectParamsSchema = z.strictObject({
  projectId: identifierSchema,
});
export const controlPlaneProjectAgentParamsSchema = z.strictObject({
  projectId: identifierSchema,
  agentId: agentIdSchema,
});
export const controlPlaneProjectBindingParamsSchema = z.strictObject({
  projectId: identifierSchema,
  bindingId: identifierSchema,
});
export const controlPlaneCapabilityParamsSchema = z.strictObject({
  capabilityId: identifierSchema,
});
export const controlPlaneProfileParamsSchema = z.strictObject({
  profileId: identifierSchema,
});
export const controlPlanePlanParamsSchema = z.strictObject({
  planId: identifierSchema,
});
export const controlPlaneSnapshotParamsSchema = z.strictObject({
  snapshotId: identifierSchema,
});
export const contextSourceListQuerySchema = z.strictObject({
  projectId: identifierSchema.optional(),
  agentId: agentIdSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONTROL_PLANE_MAX_COLLECTION_LIMIT)
    .default(CONTROL_PLANE_COLLECTION_LIMIT),
});
export const controlPlaneEmptyRequestSchema = z.strictObject({});

export const configPlanStateSchema = z.enum([
  'prepared',
  'approved',
  'applying',
  'applied',
  'failed',
  'expired',
  'superseded',
]);
export const configChangeSchema = z.strictObject({
  path: pathSchema,
  operation: z.enum(['create', 'update', 'delete']),
  managementMode: z.enum(['managed-fragment', 'managed-file']),
  beforeHash: sha256Schema.optional(),
  afterHash: sha256Schema.optional(),
  redactedDiff: z.string().max(65_536),
  warnings: z.array(z.string().max(2000)).max(100),
});
export const configPlanSchema = z.strictObject({
  id: identifierSchema,
  projectId: identifierSchema.optional(),
  agentId: agentIdSchema,
  state: configPlanStateSchema,
  kind: z.enum(['import', 'render', 'rollback', 'optimization']),
  changes: z.array(configChangeSchema).min(1).max(100),
  preconditionHashes: z.record(pathSchema, sha256Schema.nullable()),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  approvalTokenHash: sha256Schema.optional(),
  snapshotId: identifierSchema.optional(),
  operationId: identifierSchema.optional(),
});
export const configPlanCollectionSchema = z.strictObject({
  plans: z.array(configPlanSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
});
export const configPlanCreateRequestSchema = z.strictObject({
  agentId: agentIdSchema,
  projectId: identifierSchema.optional(),
  previewOverrides: jsonObjectSchema.optional(),
  adoptUnmanaged: z.boolean().default(false),
});
export const configPlanApprovalResponseSchema = z.strictObject({
  plan: configPlanSchema,
  approvalToken: z.string().min(32).max(512),
});
export const configPlanApplyRequestSchema = z.strictObject({
  approvalToken: z.string().min(32).max(512),
});

export const configSnapshotFileSchema = z.strictObject({
  targetPath: pathSchema,
  existed: z.boolean(),
  originalHash: sha256Schema.nullable(),
  snapshotPath: pathSchema.optional(),
  permissions: z.number().int().nonnegative().optional(),
});
export const configSnapshotSchema = z.strictObject({
  id: identifierSchema,
  operationId: identifierSchema,
  planId: identifierSchema,
  agentId: agentIdSchema,
  projectId: identifierSchema.optional(),
  createdAt: timestampSchema,
  schemaVersion: z.literal(1),
  adapterVersion: z.string().trim().min(1).max(200),
  files: z.array(configSnapshotFileSchema).min(1).max(100),
  redactedManifest: jsonObjectSchema,
});
export const configSnapshotCollectionSchema = z.strictObject({
  snapshots: z.array(configSnapshotSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
});

export const configOperationStateSchema = z.enum([
  'prepared',
  'snapshotted',
  'writing',
  'files_committed',
  'redis_pending',
  'completed',
  'failed',
  'reconciliation_required',
  'rolled_back',
]);
export const configOperationReceiptSchema = z.strictObject({
  id: identifierSchema,
  planId: identifierSchema,
  snapshotId: identifierSchema.optional(),
  agentId: agentIdSchema,
  projectId: identifierSchema.optional(),
  state: configOperationStateSchema,
  targetPaths: z.array(pathSchema).max(100),
  expectedHashes: z.record(pathSchema, sha256Schema.nullable()),
  committedHashes: z.record(pathSchema, sha256Schema.nullable()),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  failureCode: z.string().max(200).optional(),
});
export const configReconcileResponseSchema = z.strictObject({
  operations: z.array(configOperationReceiptSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
});

export const configDriftSchema = z.strictObject({
  id: identifierSchema,
  agentId: agentIdSchema,
  projectId: identifierSchema.optional(),
  path: pathSchema,
  expectedHash: sha256Schema.nullable(),
  observedHash: sha256Schema.nullable(),
  severity: z.enum(['info', 'warning', 'error']),
  resolution: z.enum(['import', 'reapply', 'manual', 'none']),
  detectedAt: timestampSchema,
});
export const configDriftCollectionSchema = z.strictObject({
  drifts: z.array(configDriftSchema).max(CONTROL_PLANE_MAX_COLLECTION_LIMIT),
});

export const controlPlaneErrorCodeSchema = z.enum([
  'AGENT_DEFINITION_NOT_FOUND',
  'AGENT_DEFINITION_CONFLICT',
  'AGENT_ADAPTER_UNSUPPORTED',
  'AGENT_INSTALLATION_NOT_FOUND',
  'PROJECT_AGENT_BINDING_NOT_FOUND',
  'PROJECT_AGENT_BINDING_CONFLICT',
  'CAPABILITY_NOT_FOUND',
  'CAPABILITY_CONFLICT',
  'CAPABILITY_INCOMPATIBLE',
  'CAPABILITY_DEPENDENCY_MISSING',
  'CAPABILITY_PATH_INVALID',
  'PROFILE_NOT_FOUND',
  'PROFILE_CONFLICT',
  'EFFECTIVE_CONFIG_INVALID',
  'NATIVE_CONFIG_PARSE_FAILED',
  'NATIVE_CONFIG_UNMANAGED',
  'NATIVE_CONFIG_DRIFTED',
  'CONFIG_PLAN_NOT_FOUND',
  'CONFIG_PLAN_EXPIRED',
  'CONFIG_PLAN_SUPERSEDED',
  'CONFIG_PLAN_NOT_APPROVED',
  'CONFIG_PLAN_PRECONDITION_FAILED',
  'CONFIG_PLAN_PATH_ESCAPE',
  'CONFIG_APPLY_FAILED',
  'CONFIG_RECONCILIATION_REQUIRED',
  'SNAPSHOT_NOT_FOUND',
  'ROLLBACK_PRECONDITION_FAILED',
  'CONTEXT_SOURCE_INVALID',
  'CONTEXT_SCAN_FAILED',
  'SECRET_VALUE_FORBIDDEN',
]);

export type AgentKind = z.infer<typeof agentKindSchema>;
export type AdapterSupportLevel = z.infer<typeof adapterSupportLevelSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDefinitionCreateRequest = z.infer<typeof agentDefinitionCreateRequestSchema>;
export type AgentDefinitionPatchRequest = z.infer<typeof agentDefinitionPatchRequestSchema>;
export type DetectedAgentInstallation = z.infer<typeof detectedAgentInstallationSchema>;
export type FlowRole = z.infer<typeof flowRoleSchema>;
export type ProjectAgentBinding = z.infer<typeof projectAgentBindingSchema>;
export type ProjectAgentBindingCreateRequest = z.infer<
  typeof projectAgentBindingCreateRequestSchema
>;
export type ProjectAgentBindingPatchRequest = z.infer<typeof projectAgentBindingPatchRequestSchema>;
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;
export type CapabilityPackage = z.infer<typeof capabilityPackageSchema>;
export type CapabilityPackageCreateRequest = z.infer<typeof capabilityPackageCreateRequestSchema>;
export type CapabilityPackagePatchRequest = z.infer<typeof capabilityPackagePatchRequestSchema>;
export type CapabilityScanResponse = z.infer<typeof capabilityScanResponseSchema>;
export type CapabilityListQuery = z.infer<typeof capabilityListQuerySchema>;
export type CapabilityBinding = z.infer<typeof capabilityBindingSchema>;
export type CapabilityAssignmentRequest = z.infer<typeof capabilityAssignmentRequestSchema>;
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;
export type CapabilityProfileCreateRequest = z.infer<typeof capabilityProfileCreateRequestSchema>;
export type CapabilityProfilePatchRequest = z.infer<typeof capabilityProfilePatchRequestSchema>;
export type EffectiveAgentConfiguration = z.infer<typeof effectiveAgentConfigurationSchema>;
export type ConfigProvenance = z.infer<typeof configProvenanceSchema>;
export type NativeConfigInspection = z.infer<typeof nativeConfigInspectionSchema>;
export type ConfigPlan = z.infer<typeof configPlanSchema>;
export type ConfigPlanState = z.infer<typeof configPlanStateSchema>;
export type ConfigChange = z.infer<typeof configChangeSchema>;
export type ConfigSnapshot = z.infer<typeof configSnapshotSchema>;
export type ConfigOperationReceipt = z.infer<typeof configOperationReceiptSchema>;
export type ConfigOperationState = z.infer<typeof configOperationStateSchema>;
export type ConfigDrift = z.infer<typeof configDriftSchema>;
export type ManagementMode = z.infer<typeof managementModeSchema>;
export type ContextSource = z.infer<typeof contextSourceSchema>;
export type ContextFootprint = z.infer<typeof contextFootprintSchema>;
export type ControlPlaneErrorCode = z.infer<typeof controlPlaneErrorCodeSchema>;
