import { z } from 'zod';

/**
 * Vendor-native session identity, namespaced by adapter.
 *
 * The charset is deliberately narrow: both Claude Code forms — a UUID stem and
 * an `agent-<hex>` stem — fit it. A vendor that needs more is a reason to widen
 * this with that vendor's layout in hand, rather than to speculate now.
 *
 * Deliberately absent from the binding: presence, project, agent,
 * AgentDefinition and confidence. The binding is identity. Liveness comes from
 * the session's own heartbeat and TTL; scope comes from the linked session.
 */

const identifierSchema = z.string().trim().min(1).max(128);
const timestampSchema = z.iso.datetime({ offset: false });

const nativeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

export const nativeSessionRefSchema = z.strictObject({
  adapterId: identifierSchema,
  nativeSessionId: nativeIdSchema,
  nativeSubagentId: nativeIdSchema.optional(),
});

export const nativeSessionKindSchema = z.enum(['main', 'subagent']);

export const nativeSessionBindingSchema = z.strictObject({
  id: identifierSchema,
  adapterId: identifierSchema,
  nativeSessionId: nativeIdSchema,
  nativeSubagentId: nativeIdSchema.optional(),
  kind: nativeSessionKindSchema,
  parentRef: nativeSessionRefSchema.optional(),
  openLinkId: identifierSchema.optional(),
  version: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  /** Always 0 in A1; retention is A2. The field exists so A2 needs no migration. */
  trimmedLinkCount: z.number().int().nonnegative(),
  oldestRetainedLinkedAt: timestampSchema.optional(),
  /** Link creations, not declaration attempts: an `unchanged` outcome writes nothing. */
  firstLinkedAt: timestampSchema,
  lastLinkedAt: timestampSchema,
});

export const nativeSessionLinkSchema = z.strictObject({
  id: identifierSchema,
  bindingId: identifierSchema,
  sessionId: identifierSchema,
  linkedAt: timestampSchema,
  unlinkedAt: timestampSchema.optional(),
});

export type NativeSessionRef = z.infer<typeof nativeSessionRefSchema>;
export type NativeSessionKind = z.infer<typeof nativeSessionKindSchema>;
export type NativeSessionBinding = z.infer<typeof nativeSessionBindingSchema>;
export type NativeSessionLink = z.infer<typeof nativeSessionLinkSchema>;
