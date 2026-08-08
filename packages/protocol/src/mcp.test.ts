import { describe, expect, it } from 'vitest';

import {
  mcpAcknowledgeMessageInputSchema,
  mcpAskAgentInputSchema,
  mcpAwaitResponseInputSchema,
  mcpGetProjectStateInputSchema,
  mcpGetSessionInputSchema,
  mcpInboxNextInputSchema,
  mcpListProjectsInputSchema,
  mcpListProjectsOutputSchema,
  mcpListSessionsInputSchema,
  mcpListSessionsOutputSchema,
  mcpMessageOutputSchema,
  mcpRespondToMessageInputSchema,
} from './index.js';

describe('MCP tool contracts', () => {
  it('defines bounded discovery inputs without exposing storage details', () => {
    expect(mcpListProjectsInputSchema.parse({})).toEqual({});
    expect(mcpListSessionsInputSchema.parse({ online: true })).toEqual({ online: true });
    expect(mcpGetSessionInputSchema.parse({ sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    });
    expect(mcpGetProjectStateInputSchema.parse({})).toEqual({});
    expect(() => mcpListProjectsInputSchema.parse({ redisUrl: 'redis://secret' })).toThrow();
  });

  it('does not allow callers to override the bound source session', () => {
    expect(
      mcpAskAgentInputSchema.parse({
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Project status?',
      }),
    ).toEqual({
      targetAgentId: 'gemini-sim',
      kind: 'question',
      content: 'Project status?',
      evidenceRequirements: [],
      timeoutMs: 120_000,
      waitMs: 0,
    });
    expect(
      mcpAskAgentInputSchema.safeParse({
        sourceSessionId: 'forged-source',
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Project status?',
      }).success,
    ).toBe(false);
  });

  it('bounds waits and inbox claims', () => {
    expect(
      mcpAwaitResponseInputSchema.parse({
        correlationId: 'correlation-1',
        waitMs: 30_000,
      }),
    ).toEqual({
      correlationId: 'correlation-1',
      waitMs: 30_000,
    });
    expect(
      mcpAwaitResponseInputSchema.safeParse({
        correlationId: 'correlation-1',
        waitMs: 30_001,
      }).success,
    ).toBe(false);
    expect(
      mcpInboxNextInputSchema.parse({
        bridgeInstanceId: 'mcp_1',
      }),
    ).toEqual({
      bridgeInstanceId: 'mcp_1',
      limit: 10,
      blockMs: 5000,
      minIdleMs: 15_000,
    });
  });

  it('derives responder identity instead of accepting it from tools', () => {
    expect(
      mcpAcknowledgeMessageInputSchema.parse({
        correlationId: 'correlation-1',
      }),
    ).toEqual({ correlationId: 'correlation-1' });
    expect(
      mcpAcknowledgeMessageInputSchema.safeParse({
        correlationId: 'correlation-1',
        responderSessionId: 'forged-responder',
      }).success,
    ).toBe(false);

    expect(
      mcpRespondToMessageInputSchema.parse({
        correlationId: 'correlation-1',
        response: {
          status: 'answered',
          answer: 'Simulated answer.',
          evidence: [],
          verifiedAt: '2026-07-29T12:00:00.000Z',
        },
      }).response.status,
    ).toBe('answered');
  });

  it('defines bounded validated output contracts', () => {
    expect(
      mcpListProjectsOutputSchema.parse({
        projects: [],
        truncated: false,
      }),
    ).toEqual({ projects: [], truncated: false });
    expect(
      mcpListSessionsOutputSchema.safeParse({
        sessions: Array.from({ length: 101 }, () => ({})),
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      mcpMessageOutputSchema.safeParse({
        id: 'message-1',
      }).success,
    ).toBe(false);
  });
});
