import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const source = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@luwi/protocol/browser',
        replacement: source('./packages/protocol/src/browser.ts'),
      },
      { find: '@luwi/protocol', replacement: source('./packages/protocol/src/index.ts') },
      { find: '@luwi/adapters', replacement: source('./packages/adapters/src/index.ts') },
      { find: '@luwi/redis', replacement: source('./packages/redis/src/index.ts') },
      { find: '@luwi/runtime', replacement: source('./packages/runtime/src/index.ts') },
    ],
  },
  test: {
    include: ['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/dist/**', '**/node_modules/**'],
    passWithNoTests: false,
  },
});
