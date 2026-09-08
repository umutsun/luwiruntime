import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.claude/worktrees/` holds git worktrees Claude Code creates for isolated
    // sessions; each carries its own tsconfig root, and typed linting refuses
    // to pick between two.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'temp/**',
      '.claude/worktrees/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The `scripts/**` hooks and launchers are Node ESM. They import what they can
    // from `node:` modules, but `fetch` is a Node 18+ global with no import; declare
    // the runtime globals so `no-undef` does not fire on it.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // AGENTS.md section 5: `@luwi/daemon` is the sole Redis-accessing process and
  // `@luwi/redis` owns every Redis-specific representation. Every other package
  // must stay Redis-independent so that domain logic, wire types, the CLI, the
  // dashboard, and the MCP adapter remain testable and transport-agnostic.
  //
  // This is mechanically provable, so it is enforced here rather than left to
  // review. Type-only imports are restricted too: importing a Redis type still
  // couples the package to the Redis representation that section 7 forbids
  // exposing from `@luwi/runtime` and `@luwi/protocol`.
  {
    files: [
      'apps/mcp-server/**/*.ts',
      'apps/cli/**/*.ts',
      'apps/dashboard/**/*.{ts,tsx}',
      'packages/protocol/**/*.ts',
      'packages/runtime/**/*.ts',
      'packages/adapters/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'redis',
              message:
                'Only @luwi/redis may use the Redis client directly (AGENTS.md section 5). Route Redis access through the daemon.',
            },
            {
              name: '@luwi/redis',
              message:
                'Only @luwi/daemon may depend on @luwi/redis (AGENTS.md section 5). @luwi/mcp-server in particular must never be a Redis client (section 12).',
            },
          ],
          patterns: [
            {
              group: ['redis/*', '@luwi/redis/*'],
              message:
                'Deep imports into the Redis client or @luwi/redis bypass the package boundary defined in AGENTS.md section 5.',
            },
          ],
        },
      ],
    },
  },
);
