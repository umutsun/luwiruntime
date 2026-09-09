import { z } from 'zod';

const idSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

export const bridgeProviderSchema = z.enum(['codex', 'claude-code', 'gemini-cli', 'antigravity']);
export const bridgeExecutionProfileSchema = z.enum(['read-only', 'workspace-write']);
export const bridgeSlotStateSchema = z.enum(['active', 'standby', 'degraded', 'expired']);
export const nativeBridgeExecutionProfileSchema = z.strictObject({
  enabled: z.literal(true),
  provider: bridgeProviderSchema,
  executionProfile: bridgeExecutionProfileSchema,
});

/**
 * A redacted slot projection. The owner token exists only in mutation requests
 * and storage; it is never included in a list response or browser bundle.
 */
export const bridgeSlotViewSchema = z.strictObject({
  id: idSchema,
  workspaceId: idSchema,
  projectId: idSchema,
  agentId: idSchema,
  provider: bridgeProviderSchema,
  executionProfile: bridgeExecutionProfileSchema,
  state: bridgeSlotStateSchema,
  revision: z.number().int().nonnegative(),
  sessionId: idSchema.optional(),
  expiresAt: timestampSchema,
});

export const bridgeSlotCollectionSchema = z.strictObject({
  slots: z.array(bridgeSlotViewSchema).max(1000),
});

/** Private daemon/supervisor declaration used to fence session registration. */
export const bridgeOwnerDeclarationSchema = z.strictObject({
  slotId: idSchema,
  ownerToken: z.string().trim().min(1).max(256),
  provider: bridgeProviderSchema,
  executionProfile: bridgeExecutionProfileSchema,
});

export const bridgeSlotAcquireRequestSchema = z.strictObject({
  workspaceId: idSchema,
  projectId: idSchema,
  agentId: idSchema,
  ownerToken: z.string().trim().min(1).max(256),
  provider: bridgeProviderSchema,
  executionProfile: bridgeExecutionProfileSchema,
});

export const bridgeSlotRenewRequestSchema = z.strictObject({
  ownerToken: z.string().trim().min(1).max(256),
});

export const bridgeSlotAttachRequestSchema = z.strictObject({
  ownerToken: z.string().trim().min(1).max(256),
  sessionId: idSchema,
});

export const bridgeSlotReleaseRequestSchema = z.strictObject({
  ownerToken: z.string().trim().min(1).max(256),
});

export function parseBridgeSlotView(input: unknown): BridgeSlotView {
  return bridgeSlotViewSchema.parse(input);
}

export type BridgeProvider = z.infer<typeof bridgeProviderSchema>;
export type BridgeExecutionProfile = z.infer<typeof bridgeExecutionProfileSchema>;
export type BridgeSlotState = z.infer<typeof bridgeSlotStateSchema>;
export type BridgeSlotView = z.infer<typeof bridgeSlotViewSchema>;
export type BridgeSlotCollection = z.infer<typeof bridgeSlotCollectionSchema>;
export type BridgeOwnerDeclaration = z.infer<typeof bridgeOwnerDeclarationSchema>;
export type BridgeSlotAcquireRequest = z.infer<typeof bridgeSlotAcquireRequestSchema>;
export type BridgeSlotRenewRequest = z.infer<typeof bridgeSlotRenewRequestSchema>;
export type BridgeSlotAttachRequest = z.infer<typeof bridgeSlotAttachRequestSchema>;
export type BridgeSlotReleaseRequest = z.infer<typeof bridgeSlotReleaseRequestSchema>;
export type NativeBridgeExecutionProfile = z.infer<typeof nativeBridgeExecutionProfileSchema>;
