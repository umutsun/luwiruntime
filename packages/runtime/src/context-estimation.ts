import { contextFootprintSchema, type ContextFootprint, type ContextSource } from '@luwi/protocol';

export function estimateContextFootprint(input: {
  projectId?: string;
  agentId?: string;
  measuredAt: string;
  sources: ContextSource[];
}): ContextFootprint {
  const categories: ContextFootprint['categories'] = {};
  const duplicateIds = new Map<string, string[]>();
  let totalBytes = 0;
  let totalLines = 0;
  let estimatedTokens = 0;

  for (const source of [...input.sources].sort((left, right) => left.id.localeCompare(right.id))) {
    totalBytes += source.byteCount;
    totalLines += source.lineCount;
    const tokens = Math.ceil(source.byteCount / 4);
    estimatedTokens += tokens;
    const category = categories[source.sourceType] ?? {
      bytes: 0,
      lines: 0,
      estimatedTokens: 0,
      sourceCount: 0,
    };
    category.bytes += source.byteCount;
    category.lines += source.lineCount;
    category.estimatedTokens += tokens;
    category.sourceCount += 1;
    categories[source.sourceType] = category;
    const ids = duplicateIds.get(source.hash) ?? [];
    ids.push(source.id);
    duplicateIds.set(source.hash, ids);
  }

  return contextFootprintSchema.parse({
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    source: 'estimated',
    method: 'generic-character-estimate',
    totalBytes,
    totalLines,
    estimatedTokens,
    categories,
    exactDuplicateGroups: [...duplicateIds.values()]
      .filter((ids) => ids.length > 1)
      .map((ids) => ids.toSorted())
      .toSorted((left, right) => (left[0] ?? '').localeCompare(right[0] ?? '')),
    measuredAt: input.measuredAt,
  });
}
