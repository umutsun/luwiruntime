import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { build, type Rollup, type UserConfig } from 'vite';

import config from './vite.config.js';

describe('dashboard development server configuration', () => {
  const value = config as UserConfig;

  it('binds to the exact loopback development host', () => {
    expect(value.server).toMatchObject({
      host: '127.0.0.1',
      port: 4783,
      strictPort: true,
    });
  });

  it('proxies both HTTP and WebSocket API traffic to the loopback daemon', () => {
    expect(value.server?.proxy?.['/api']).toEqual({
      target: 'http://127.0.0.1:4782',
      changeOrigin: true,
      ws: true,
    });
    expect(value.server?.proxy?.['/health']).toEqual({
      target: 'http://127.0.0.1:4782',
      changeOrigin: true,
    });
  });

  it('bundles without a Node runtime external in the browser entry', async () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const result = await build({
      ...value,
      root,
      configFile: false,
      logLevel: 'silent',
      build: { write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (output: Rollup.RollupOutput) => output.output,
    );
    const javascript = outputs
      .filter((output): output is Rollup.OutputChunk => output.type === 'chunk')
      .map((output) => output.code)
      .join('\n');

    expect(javascript).not.toContain('node:crypto');
    expect(javascript).not.toContain('__vite-browser-external');
  });
});
