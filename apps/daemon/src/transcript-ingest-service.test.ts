import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '@luwi/runtime';
import {
  createTranscriptIngestTick,
  createTranscriptIngestService,
  type TranscriptIngestDependencies,
} from './transcript-ingest-service.js';

const linkedAt = '2026-08-17T08:13:17.184Z';
const unlinkedAt = '2026-08-17T08:13:32.752Z';
const insideInterval = '2026-08-17T08:13:20.000Z';
const afterInterval = '2026-08-17T09:00:00.000Z';

const bindingId = 'b'.repeat(64);

const link = {
  id: 'c'.repeat(64),
  bindingId,
  sessionId: 'session-1',
  linkedAt,
  unlinkedAt,
};

const session = {
  id: 'session-1',
  projectId: 'project-1',
  agentId: 'claude-code',
};

function observation(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    nativeSessionId: 'fixture-claude-session-0001',
    requestId: 'req_1',
    model: 'claude-opus-5',
    observedAt: insideInterval,
    inputTokens: 2,
    outputTokens: 738,
    cacheCreationInputTokens: 18549,
    cacheReadInputTokens: 22728,
    ...overrides,
  };
}

function createDependencies(
  overrides: Partial<TranscriptIngestDependencies> = {},
): TranscriptIngestDependencies & { ingestUsage: ReturnType<typeof vi.fn> } {
  const ingestUsage = vi.fn(async () => ({ id: 'usage-1' }));
  const base = {
    reader: {
      scan: async () => ({
        observations: [observation()],
        cursors: {},
        filesScanned: 1,
        filesSkippedUnchanged: 0,
        malformedLines: 0,
        filesStoppedMalformedCap: 0,
        truncatedFiles: 0,
        filesSkippedOverCap: 0,
      }),
    },
    repository: {
      getNativeBinding: async () => ({
        id: bindingId,
        adapterId: 'claude-code',
        nativeSessionId: 'fixture-claude-session-0001',
        kind: 'main' as const,
        version: 2,
        linkCount: 1,
        trimmedLinkCount: 0,
        firstLinkedAt: linkedAt,
        lastLinkedAt: linkedAt,
      }),
      findNativeLinkAt: async () => link,
    },
    sessions: { get: async () => session },
    intelligence: { ingestUsage },
    transcriptRoot: '/fake/home/.claude/projects',
    adapterId: 'claude-code',
    ...overrides,
  } as TranscriptIngestDependencies & { ingestUsage: ReturnType<typeof vi.fn> };
  base.ingestUsage = ingestUsage;
  return base;
}

describe('transcript ingest service', () => {
  it('ingests an observation inside the interval with the session project and agent', async () => {
    // The transcript knows neither projectId nor agentId. They come from the
    // session the interval names, which is also what ingestUsage validates.
    const dependencies = createDependencies();
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    expect(summary.ingested).toBe(1);
    expect(dependencies.ingestUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        agentId: 'claude-code',
        sessionId: 'session-1',
        source: 'adapter-extracted',
        confidence: 'reported',
        inputTokens: 2,
        outputTokens: 738,
        cacheCreationInputTokens: 18549,
        cacheReadInputTokens: 22728,
        observedAt: insideInterval,
        sourceEventId: 'claude-code:fixture-claude-session-0001:req_1',
      }),
    );
  });

  it('leaves cachedInputTokens and totalTokens unset', async () => {
    // Both existing invariants only fire when these are present, and Claude's
    // counters are additive rather than a subset. Leaving them unset is what
    // keeps a truthful record from being rejected.
    const dependencies = createDependencies();
    const service = createTranscriptIngestService(dependencies);

    await service.ingestOnce();

    const request = dependencies.ingestUsage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['cachedInputTokens']).toBeUndefined();
    expect(request['totalTokens']).toBeUndefined();
  });

  it('ingests nothing for an observation outside every interval', async () => {
    const dependencies = createDependencies({
      reader: {
        scan: async () => ({
          observations: [observation({ observedAt: afterInterval })],
          cursors: {},
          filesScanned: 1,
          filesSkippedUnchanged: 0,
          malformedLines: 0,
          filesStoppedMalformedCap: 0,
          truncatedFiles: 0,
          filesSkippedOverCap: 0,
        }),
      },
      repository: {
        getNativeBinding: async () => ({
          id: bindingId,
          adapterId: 'claude-code',
          nativeSessionId: 'fixture-claude-session-0001',
          kind: 'main' as const,
          version: 2,
          linkCount: 1,
          trimmedLinkCount: 0,
          firstLinkedAt: linkedAt,
          lastLinkedAt: linkedAt,
        }),
        // No interval contains the instant.
        findNativeLinkAt: async () => null,
      },
    });
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    expect(summary.ingested).toBe(0);
    expect(summary.skippedOutsideInterval).toBe(1);
    expect(summary.skippedNoBinding).toBe(0);
    expect(dependencies.ingestUsage).not.toHaveBeenCalled();
  });

  it('counts a native session that was never declared', async () => {
    const dependencies = createDependencies({
      repository: {
        getNativeBinding: async () => null,
        findNativeLinkAt: async () => null,
      },
    });
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    expect(summary.skippedNoBinding).toBe(1);
    expect(dependencies.ingestUsage).not.toHaveBeenCalled();
  });

  it('counts evidence lost to link retention apart from evidence never covered', async () => {
    // A binding exists but its oldest retained link starts after the
    // observation, so the interval that would have covered it may have been
    // trimmed. Reporting `outside-interval` would claim the runtime looked and
    // found nothing, which is a stronger claim than it can make.
    const dependencies = createDependencies({
      reader: {
        scan: async () => ({
          observations: [observation({ observedAt: '2026-08-17T07:00:00.000Z' })],
          cursors: {},
          filesScanned: 1,
          filesSkippedUnchanged: 0,
          malformedLines: 0,
          filesStoppedMalformedCap: 0,
          truncatedFiles: 0,
          filesSkippedOverCap: 0,
        }),
      },
      repository: {
        getNativeBinding: async () => ({
          id: bindingId,
          adapterId: 'claude-code',
          nativeSessionId: 'fixture-claude-session-0001',
          kind: 'main' as const,
          version: 2,
          linkCount: 1,
          trimmedLinkCount: 4,
          oldestRetainedLinkedAt: linkedAt,
          firstLinkedAt: linkedAt,
          lastLinkedAt: linkedAt,
        }),
        findNativeLinkAt: async () => null,
      },
    });
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    expect(summary.skippedTrimmed).toBe(1);
    expect(summary.skippedOutsideInterval).toBe(0);
    expect(summary.skippedNoBinding).toBe(0);
    expect(dependencies.ingestUsage).not.toHaveBeenCalled();
  });

  it('treats a duplicate as a counted outcome rather than a failure', async () => {
    // Re-reading a transcript is the steady state, so the 409 the service
    // raises for an already-ingested source event must not abort the scan.
    const ingestUsage = vi.fn(async () => {
      throw new ApplicationError('USAGE_RECORD_DUPLICATE', 'already ingested', 409);
    });
    const dependencies = createDependencies({ intelligence: { ingestUsage } });
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    expect(summary.skippedDuplicate).toBe(1);
    expect(summary.ingested).toBe(0);
  });

  it('lets an unexpected ingest failure escape', async () => {
    const ingestUsage = vi.fn(async () => {
      throw new ApplicationError('USAGE_RECORD_INVALID', 'bad record', 400);
    });
    const dependencies = createDependencies({ intelligence: { ingestUsage } });
    const service = createTranscriptIngestService(dependencies);

    await expect(service.ingestOnce()).rejects.toMatchObject({ code: 'USAGE_RECORD_INVALID' });
  });

  it('counts a link whose session can no longer be read', async () => {
    const dependencies = createDependencies({ sessions: { get: async () => null } });
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    expect(summary.skippedSessionMissing).toBe(1);
    expect(dependencies.ingestUsage).not.toHaveBeenCalled();
  });

  it('carries the reader bounds into the summary', async () => {
    const dependencies = createDependencies({
      reader: {
        scan: async () => ({
          observations: [],
          cursors: {},
          filesScanned: 3,
          filesSkippedUnchanged: 4,
          malformedLines: 5,
          filesStoppedMalformedCap: 1,
          truncatedFiles: 1,
          filesSkippedOverCap: 2,
        }),
      },
    });
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    expect(summary).toMatchObject({
      filesScanned: 3,
      filesSkippedUnchanged: 4,
      malformedLines: 5,
      filesStoppedMalformedCap: 1,
      truncatedFiles: 1,
      filesSkippedOverCap: 2,
    });
  });

  it('reuses cursors across scans so unchanged files are skipped', async () => {
    const scan = vi.fn(async () => ({
      observations: [],
      cursors: { '/fake/a.jsonl': { modifiedAtMs: 5, sizeBytes: 6 } },
      filesScanned: 1,
      filesSkippedUnchanged: 0,
      malformedLines: 0,
      filesStoppedMalformedCap: 0,
      truncatedFiles: 0,
      filesSkippedOverCap: 0,
    }));
    const dependencies = createDependencies({ reader: { scan } });
    const service = createTranscriptIngestService(dependencies);

    await service.ingestOnce();
    await service.ingestOnce();

    expect(scan.mock.calls[1]?.[0]).toMatchObject({
      cursors: { '/fake/a.jsonl': { modifiedAtMs: 5, sizeBytes: 6 } },
    });
  });

  it('reports no identifiers in its summary', async () => {
    // The summary is logged, and AGENTS.md section 4 bans identifiers and
    // content from the log. Counters only.
    const dependencies = createDependencies();
    const service = createTranscriptIngestService(dependencies);

    const summary = await service.ingestOnce();

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('session-1');
    expect(serialized).not.toContain('fixture-claude-session-0001');
    expect(serialized).not.toContain('req_1');
  });
});

describe('transcript ingest scheduler tick', () => {
  const emptySummary = {
    filesScanned: 0,
    filesSkippedUnchanged: 0,
    requestsObserved: 0,
    ingested: 0,
    skippedDuplicate: 0,
    skippedNoBinding: 0,
    skippedOutsideInterval: 0,
    skippedTrimmed: 0,
    skippedSessionMissing: 0,
    malformedLines: 0,
    filesStoppedMalformedCap: 0,
    truncatedFiles: 0,
    filesSkippedOverCap: 0,
  };

  it('does not schedule a scan while the runtime is draining', () => {
    const schedule = vi.fn(() => true);
    const tick = createTranscriptIngestTick({
      runtimeState: () => 'draining',
      schedule,
      ingestOnce: vi.fn(async () => emptySummary),
      onComplete: vi.fn(),
      onError: vi.fn(),
    });

    tick();

    expect(schedule).not.toHaveBeenCalled();
  });

  it('reports a failed scan and permits the next timer tick', async () => {
    const failure = new Error('scan failed');
    const ingestOnce = vi
      .fn<() => Promise<typeof emptySummary>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(emptySummary);
    const onComplete = vi.fn();
    const onError = vi.fn();
    const pending: Array<() => Promise<void>> = [];
    const schedule = vi.fn((work: () => Promise<void>, report: (error: unknown) => void) => {
      pending.push(async () => {
        try {
          await work();
        } catch (error) {
          report(error);
        }
      });
      return true;
    });
    const tick = createTranscriptIngestTick({
      runtimeState: () => 'ready',
      schedule,
      ingestOnce,
      onComplete,
      onError,
    });

    tick();
    await pending.shift()?.();
    tick();
    await pending.shift()?.();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(ingestOnce).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledWith(emptySummary);
  });
});
