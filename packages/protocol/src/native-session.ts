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

/**
 * Closed links one retention call may remove.
 *
 * It lives here because both `@luwi/redis`, which enforces it as a key-count
 * bound inside the Function, and `@luwi/runtime`, which enforces it when
 * selecting candidates, must agree on the number, and neither package depends
 * on the other.
 */
export const NATIVE_LINK_TRIM_MAX_PER_CALL = 32;

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

/**
 * A live session declaring its native identity after registration. The same
 * `native` block session registration takes, and deliberately nothing else:
 * the session is named by the route path, so a body cannot declare for anyone
 * but the caller's own session, and project and agent still come from the
 * session rather than being accepted a second time here.
 */
export const nativeDeclarationRequestSchema = z.strictObject({
  native: nativeSessionRefSchema,
});

/**
 * The outcomes a declaration can return. `conflict`, `inconsistent` and
 * `contended` are refusals carried as error codes, never as a response; a test
 * in `@luwi/runtime` holds this enum against the policy's decision union so
 * the two cannot drift apart.
 */
export const nativeDeclarationOutcomeSchema = z.enum(['created', 'linked', 'unchanged']);

export const nativeDeclarationResponseSchema = z.strictObject({
  outcome: nativeDeclarationOutcomeSchema,
  binding: nativeSessionBindingSchema,
  link: nativeSessionLinkSchema,
  /** Present only when the same declaration closed a stale open link. */
  staleLink: nativeSessionLinkSchema.optional(),
});

/** The native reference a session currently holds, or null when it has none. */
export const sessionNativeRefResponseSchema = z.strictObject({
  native: nativeSessionRefSchema.nullable(),
});

export type NativeSessionRef = z.infer<typeof nativeSessionRefSchema>;
export type SessionNativeRefResponse = z.infer<typeof sessionNativeRefResponseSchema>;
export type NativeSessionKind = z.infer<typeof nativeSessionKindSchema>;
export type NativeSessionBinding = z.infer<typeof nativeSessionBindingSchema>;
export type NativeSessionLink = z.infer<typeof nativeSessionLinkSchema>;
export type NativeDeclarationRequest = z.infer<typeof nativeDeclarationRequestSchema>;
export type NativeDeclarationOutcome = z.infer<typeof nativeDeclarationOutcomeSchema>;
export type NativeDeclarationResponse = z.infer<typeof nativeDeclarationResponseSchema>;
