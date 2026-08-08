import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    if (entry.name.includes('.test.')) return [];
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('dashboard product independence', () => {
  it('has no protocol, agent-vendor, hosted-service, or direct Redis coupling', () => {
    const source = productionSources(sourceRoot)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    const packageJson = JSON.parse(
      readFileSync(join(sourceRoot, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const dependencies = Object.keys(packageJson.dependencies ?? {}).join('\n');

    expect(source).not.toMatch(/\b(?:goose|acp)\b/i);
    expect(source).not.toMatch(/\b(?:claude|codex|gemini|kimi)\b/i);
    expect(source).not.toMatch(/redis:\/\//i);
    expect(source).not.toMatch(/from\s+['"](?:redis|ioredis)['"]/i);
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    expect(source).not.toMatch(/agent\.(?:name|displayName)\s*===/);
    expect(dependencies).not.toMatch(/(?:goose|acp|redis|claude|codex|gemini|kimi)/i);
  });

  it('issues no mutation request from any production module', () => {
    const source = productionSources(sourceRoot)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    // Phase 5 is read-only. The daemon exposes scan, apply, approve, rollback,
    // accept, reject, and rebuild endpoints; calling any of them from the
    // dashboard would turn a read surface into a mutation surface.
    expect(source).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
    expect(source).not.toMatch(/['"`][^'"`]*\/(?:scan|rebuild|apply|approve|rollback)['"`]/);
    expect(source).not.toMatch(/\/proposals\/[^'"`]*\/(?:accept|reject|evaluate)/);
  });

  it('renders no lifecycle stage or release-readiness claim', () => {
    const source = productionSources(sourceRoot)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    // AGENTS.md section 21 prohibits lifecycle and release scoring. The mockup
    // shows both; neither has a domain behind it, so neither may be rendered.
    expect(source).not.toMatch(/releaseReadiness|release_readiness|lifecycleStage/i);
  });
});
