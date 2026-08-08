import type { ContextSource } from '@luwi/protocol';
import { describe, expect, it } from 'vitest';

import { estimateContextFootprint } from './context-estimation.js';

const timestamp = '2026-07-29T20:00:00.000Z';

function source(id: string, hash: string, bytes: number, type: ContextSource['sourceType']) {
  return {
    id,
    projectId: 'project-1',
    sourceType: type,
    path: `C:/project/${id}.md`,
    byteCount: bytes,
    lineCount: 10,
    hash,
    loadingScope: 'project',
    loadingMode: 'automatic',
    managementMode: 'observed',
    estimatedTokenCount: Math.ceil(bytes / 4),
    estimationSource: 'estimated',
    estimationMethod: 'generic-character-estimate',
    measuredAt: timestamp,
  } satisfies ContextSource;
}

describe('static context footprint estimation', () => {
  it('uses a deterministic character estimate and exact hash duplicate detection only', () => {
    const result = estimateContextFootprint({
      projectId: 'project-1',
      agentId: 'codex-main',
      measuredAt: timestamp,
      sources: [
        source('agents', 'a'.repeat(64), 401, 'instruction'),
        source('agents-copy', 'a'.repeat(64), 401, 'instruction'),
        source('skill', 'b'.repeat(64), 200, 'skill'),
      ],
    });

    expect(result).toMatchObject({
      source: 'estimated',
      method: 'generic-character-estimate',
      totalBytes: 1002,
      totalLines: 30,
      estimatedTokens: 252,
      exactDuplicateGroups: [['agents', 'agents-copy']],
    });
    expect(result.categories.instruction).toMatchObject({ sourceCount: 2, bytes: 802 });
  });
});
