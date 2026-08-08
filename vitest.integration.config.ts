import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const source = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@luwi/adapters': source('./packages/adapters/src/index.ts'),
      '@luwi/protocol': source('./packages/protocol/src/index.ts'),
      '@luwi/redis': source('./packages/redis/src/index.ts'),
      '@luwi/runtime': source('./packages/runtime/src/index.ts'),
    },
  },
  test: {
    include: ['apps/**/*.integration.test.ts', 'packages/**/*.integration.test.ts'],
    passWithNoTests: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
