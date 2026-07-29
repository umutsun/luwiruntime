import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const source = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@luwi/protocol': source('./packages/protocol/src/index.ts'),
      '@luwi/redis': source('./packages/redis/src/index.ts'),
      '@luwi/runtime': source('./packages/runtime/src/index.ts'),
    },
  },
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/dist/**', '**/node_modules/**'],
    passWithNoTests: false,
  },
});
