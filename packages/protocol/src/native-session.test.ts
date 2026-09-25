import { describe, expect, it } from 'vitest';

import {
  nativeDeclarationRequestSchema,
  nativeDeclarationResponseSchema,
  nativeSessionBindingSchema,
  nativeSessionLinkSchema,
  nativeSessionRefSchema,
  projectSubagentsResponseSchema,
  sessionSubagentsResponseSchema,
} from './native-session.js';

const timestamp = '2026-08-11T00:00:00.000Z';

describe('native session ref', () => {
  it('accepts a main session reference and a subagent reference', () => {
    expect(
      nativeSessionRefSchema.parse({
        adapterId: 'claude-code-native-v1',
        nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
      }).nativeSubagentId,
    ).toBeUndefined();
    expect(
      nativeSessionRefSchema.parse({
        adapterId: 'claude-code-native-v1',
        nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
        nativeSubagentId: 'agent-a06de43343c462b9b',
      }).nativeSubagentId,
    ).toBe('agent-a06de43343c462b9b');
  });

  it('rejects identifiers that could not be carried safely', () => {
    for (const nativeSessionId of [
      '',
      ' ',
      '-leading',
      'has space',
      'has/slash',
      'a'.repeat(201),
    ]) {
      expect(
        nativeSessionRefSchema.safeParse({ adapterId: 'claude-code-native-v1', nativeSessionId })
          .success,
        nativeSessionId,
      ).toBe(false);
    }
  });
});

describe('native session binding', () => {
  const binding = {
    id: 'b'.repeat(64),
    adapterId: 'claude-code-native-v1',
    nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
    kind: 'main' as const,
    version: 1,
    linkCount: 1,
    trimmedLinkCount: 0,
    firstLinkedAt: timestamp,
    lastLinkedAt: timestamp,
  };

  it('accepts a binding with no open link', () => {
    expect(nativeSessionBindingSchema.parse(binding).openLinkId).toBeUndefined();
  });

  /**
   * The binding is identity, not liveness and not scope. A presence, project,
   * agent or confidence field here would be a claim the record cannot support.
   */
  it('rejects presence, project, agent and confidence fields', () => {
    for (const extra of [
      { presence: 'online' },
      { projectId: 'project-1' },
      { agentId: 'codex-main' },
      { agentDefinitionId: 'codex-main' },
      { confidence: 'exact' },
      { latestSessionId: 'session-1' },
    ]) {
      expect(nativeSessionBindingSchema.safeParse({ ...binding, ...extra }).success).toBe(false);
    }
  });

  it('rejects a negative version or a fractional link count', () => {
    expect(nativeSessionBindingSchema.safeParse({ ...binding, version: -1 }).success).toBe(false);
    expect(nativeSessionBindingSchema.safeParse({ ...binding, linkCount: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('native declaration request', () => {
  it('takes the same native block session registration takes, and nothing else', () => {
    expect(
      nativeDeclarationRequestSchema.parse({
        native: {
          adapterId: 'claude-code-native-v1',
          nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
        },
      }).native.adapterId,
    ).toBe('claude-code-native-v1');
  });

  /**
   * The declaration applies to the session named by the route path and to no
   * other. A body that names a session is the request this surface must not
   * accept, so the strict object refuses it rather than ignoring it.
   */
  it('rejects a request naming a session of its own', () => {
    expect(
      nativeDeclarationRequestSchema.safeParse({
        native: {
          adapterId: 'claude-code-native-v1',
          nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
        },
        sessionId: 'someone-elses-session',
      }).success,
    ).toBe(false);
  });

  it('rejects an absent native block and an unknown key', () => {
    expect(nativeDeclarationRequestSchema.safeParse({}).success).toBe(false);
    expect(
      nativeDeclarationRequestSchema.safeParse({
        native: {
          adapterId: 'claude-code-native-v1',
          nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
        },
        force: true,
      }).success,
    ).toBe(false);
  });
});

describe('native declaration response', () => {
  const timestamped = '2026-08-17T00:00:00.000Z';
  const binding = {
    id: 'b'.repeat(64),
    adapterId: 'claude-code-native-v1',
    nativeSessionId: 'fcc53779-5974-4794-8b47-f5515ea3a34c',
    kind: 'main' as const,
    openLinkId: 'l'.repeat(64),
    version: 1,
    linkCount: 1,
    trimmedLinkCount: 0,
    firstLinkedAt: timestamped,
    lastLinkedAt: timestamped,
  };
  const link = {
    id: 'l'.repeat(64),
    bindingId: 'b'.repeat(64),
    sessionId: 'session-1',
    linkedAt: timestamped,
  };

  it('carries each declarable outcome with the binding and the link', () => {
    for (const outcome of ['created', 'linked', 'unchanged'] as const) {
      expect(nativeDeclarationResponseSchema.parse({ outcome, binding, link }).outcome).toBe(
        outcome,
      );
    }
  });

  it('carries the stale link the same declaration closed', () => {
    expect(
      nativeDeclarationResponseSchema.parse({
        outcome: 'linked',
        binding,
        link,
        staleLink: { ...link, id: 's'.repeat(64), unlinkedAt: timestamped },
      }).staleLink?.unlinkedAt,
    ).toBe(timestamped);
  });

  it('rejects the outcomes this surface refuses instead of returning', () => {
    for (const outcome of ['conflict', 'inconsistent', 'contended']) {
      expect(nativeDeclarationResponseSchema.safeParse({ outcome, binding, link }).success).toBe(
        false,
      );
    }
  });
});

describe('native session link', () => {
  const link = {
    id: 'l'.repeat(64),
    bindingId: 'b'.repeat(64),
    sessionId: 'session-1',
    linkedAt: timestamp,
  };

  it('accepts an open link and a closed link', () => {
    expect(nativeSessionLinkSchema.parse(link).unlinkedAt).toBeUndefined();
    expect(
      nativeSessionLinkSchema.parse({ ...link, unlinkedAt: '2026-08-11T00:05:00.000Z' }).unlinkedAt,
    ).toBe('2026-08-11T00:05:00.000Z');
  });

  it('rejects an unknown field, so a link cannot smuggle evidence', () => {
    expect(nativeSessionLinkSchema.safeParse({ ...link, transcriptPath: 'C:/x' }).success).toBe(
      false,
    );
  });
});

describe('session subagents response', () => {
  const subagent = {
    agentId: 'a0b1c2',
    workflowId: 'wf-1',
    agentType: 'general-purpose',
    description: 'A0 admin prep refactor',
    state: 'running',
    lastActivityAt: timestamp,
    lastToolName: 'Bash',
    workingDirectory: 'C:/wt/a0',
    gitBranch: 'lane/a0',
  };
  const listing = {
    sessionId: 'session-1',
    status: 'observed',
    subagents: [subagent],
    truncated: false,
    observedAt: timestamp,
  };

  it('carries an observed listing and an honest unbound or unsupported answer', () => {
    expect(sessionSubagentsResponseSchema.parse(listing).subagents).toHaveLength(1);
    for (const status of ['unbound', 'unsupported']) {
      expect(
        sessionSubagentsResponseSchema.safeParse({ ...listing, status, subagents: [] }).success,
      ).toBe(true);
    }
    expect(
      projectSubagentsResponseSchema.parse({
        projectId: 'project-1',
        sessions: [listing],
        truncated: false,
        observedAt: timestamp,
      }).sessions,
    ).toHaveLength(1);
  });

  it('rejects an unknown state or field, and a listing past its bound', () => {
    expect(
      sessionSubagentsResponseSchema.safeParse({
        ...listing,
        subagents: [{ ...subagent, state: 'stopped' }],
      }).success,
    ).toBe(false);
    expect(
      sessionSubagentsResponseSchema.safeParse({
        ...listing,
        subagents: [{ ...subagent, prompt: 'text' }],
      }).success,
    ).toBe(false);
    expect(
      sessionSubagentsResponseSchema.safeParse({
        ...listing,
        subagents: Array.from({ length: 51 }, () => subagent),
      }).success,
    ).toBe(false);
    expect(
      projectSubagentsResponseSchema.safeParse({
        projectId: 'project-1',
        sessions: Array.from({ length: 21 }, () => listing),
        truncated: true,
        observedAt: timestamp,
      }).success,
    ).toBe(false);
  });
});
