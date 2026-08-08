import { describe, expect, it } from 'vitest';

import {
  agentEvidenceSchema,
  agentMessageResponseSchema,
  agentMessageSchema,
  inboxClaimRequestSchema,
  inboxClaimResponseSchema,
  messageCreateRequestSchema,
  messageListQuerySchema,
  messageStateSchema,
  messageTransitionRequestSchema,
  messageWaitQuerySchema,
} from './index.js';

const timestamp = '2026-07-29T12:00:00.000Z';

const baseMessage = {
  id: 'message-1',
  correlationId: 'correlation-1',
  projectId: 'project-1',
  sourceSessionId: 'session-source',
  sourceAgentId: 'claude-sim',
  targetSessionId: 'session-target',
  targetAgentId: 'gemini-sim',
  selectionReason: 'selected idle session with newest heartbeat',
  kind: 'question',
  content: 'Have you completed the requested project work?',
  state: 'queued',
  createdAt: timestamp,
  updatedAt: timestamp,
  deadlineAt: '2026-07-29T12:02:00.000Z',
};

describe('message protocol', () => {
  it('defines the complete message state set', () => {
    for (const state of [
      'queued',
      'delivered',
      'acknowledged',
      'processing',
      'responded',
      'rejected',
      'timed_out',
      'failed',
    ]) {
      expect(messageStateSchema.parse(state)).toBe(state);
    }
  });

  it('requires exactly one target selector and applies request defaults', () => {
    expect(
      messageCreateRequestSchema.parse({
        sourceSessionId: 'session-source',
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Project status?',
      }),
    ).toEqual({
      sourceSessionId: 'session-source',
      targetAgentId: 'gemini-sim',
      kind: 'question',
      content: 'Project status?',
      evidenceRequirements: [],
      timeoutMs: 120_000,
    });

    expect(
      messageCreateRequestSchema.safeParse({
        sourceSessionId: 'session-source',
        kind: 'question',
        content: 'Project status?',
      }).success,
    ).toBe(false);
    expect(
      messageCreateRequestSchema.safeParse({
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        targetAgentId: 'gemini-sim',
        kind: 'question',
        content: 'Project status?',
      }).success,
    ).toBe(false);
  });

  it('enforces UTF-8 byte limits rather than JavaScript character counts', () => {
    expect(
      messageCreateRequestSchema.safeParse({
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        kind: 'question',
        content: '🙂'.repeat(8192),
      }).success,
    ).toBe(true);
    expect(
      messageCreateRequestSchema.safeParse({
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        kind: 'question',
        content: '🙂'.repeat(8193),
      }).success,
    ).toBe(false);
    expect(
      messageCreateRequestSchema.safeParse({
        sourceSessionId: 'session-source',
        targetSessionId: 'session-target',
        kind: 'question',
        subject: 'é'.repeat(257),
        content: 'ok',
      }).success,
    ).toBe(false);
  });

  it('keeps evidence, freshness, and confidence separate and bounded', () => {
    const evidence = agentEvidenceSchema.parse({
      type: 'session_state',
      reference: 'session-target',
      summary: 'Simulated session projection observed through LUWI.',
      observedAt: timestamp,
      metadata: { simulated: true },
    });
    const response = agentMessageResponseSchema.parse({
      status: 'answered',
      answer: 'Simulated answer.',
      confidence: 0.7,
      evidence: [evidence],
      verifiedAt: timestamp,
    });

    expect(response.confidence).toBe(0.7);
    expect(response.verifiedAt).toBe(timestamp);
    expect(response.evidence).toHaveLength(1);
    expect(
      agentMessageResponseSchema.safeParse({
        ...response,
        confidence: 1.01,
      }).success,
    ).toBe(false);
    expect(
      agentMessageResponseSchema.safeParse({
        ...response,
        evidence: Array.from({ length: 33 }, () => evidence),
      }).success,
    ).toBe(false);
  });

  it('validates public projections without internal Redis fields', () => {
    expect(agentMessageSchema.parse(baseMessage)).toEqual(baseMessage);
    expect(
      agentMessageSchema.safeParse({
        ...baseMessage,
        targetInboxStreamId: '1-0',
      }).success,
    ).toBe(false);
  });

  it('validates bounded list, wait, and transition inputs', () => {
    expect(messageListQuerySchema.parse({ limit: '25', state: 'processing' })).toEqual({
      limit: 25,
      state: 'processing',
    });
    expect(messageListQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
    expect(messageWaitQuerySchema.parse({})).toEqual({ waitMs: 0 });
    expect(messageWaitQuerySchema.safeParse({ waitMs: 30_001 }).success).toBe(false);
    expect(messageTransitionRequestSchema.parse({ responderSessionId: 'session-target' })).toEqual({
      responderSessionId: 'session-target',
    });
  });

  it('validates request and response inbox envelopes', () => {
    const request = {
      streamId: '1785337000000-0',
      messageId: 'message-1',
      correlationId: 'correlation-1',
      itemKind: 'request',
      sourceSessionId: 'session-source',
      targetSessionId: 'session-target',
      createdAt: timestamp,
      payload: {
        kind: 'question',
        content: 'Project status?',
        evidenceRequirements: ['session_state'],
        deadlineAt: '2026-07-29T12:02:00.000Z',
      },
    };
    const response = {
      streamId: '1785337001000-0',
      messageId: 'message-1',
      correlationId: 'correlation-1',
      itemKind: 'response',
      sourceSessionId: 'session-target',
      targetSessionId: 'session-source',
      createdAt: timestamp,
      payload: {
        state: 'responded',
        response: {
          status: 'answered',
          answer: 'Simulated answer.',
          evidence: [],
          verifiedAt: timestamp,
        },
      },
    };

    expect(
      inboxClaimResponseSchema.parse({
        items: [request, response],
      }).items,
    ).toHaveLength(2);
  });

  it('bounds claim parameters and validates bridge identities', () => {
    expect(inboxClaimRequestSchema.parse({ bridgeInstanceId: 'bridge_1' })).toEqual({
      bridgeInstanceId: 'bridge_1',
      limit: 10,
      blockMs: 5000,
      minIdleMs: 15_000,
    });
    expect(
      inboxClaimRequestSchema.safeParse({
        bridgeInstanceId: '../other',
      }).success,
    ).toBe(false);
    expect(
      inboxClaimRequestSchema.safeParse({
        bridgeInstanceId: 'bridge_1',
        limit: 101,
      }).success,
    ).toBe(false);
  });
});
