import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const workspaceRoot = join(import.meta.dirname, '..', '..', '..');
const tsxCli = join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const mainEntry = join(import.meta.dirname, 'main.ts');

async function runInvalidStartup(debug = false): Promise<string> {
  const environment = { ...process.env };
  delete environment.LUWI_SESSION_ID;
  delete environment.LUWI_SESSION_FILE;
  delete environment.LUWI_MCP_DEBUG;
  if (debug) environment.LUWI_MCP_DEBUG = '1';
  try {
    await run(process.execPath, [tsxCli, mainEntry], {
      cwd: workspaceRoot,
      env: environment,
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    return String((error as Error & { stderr?: string }).stderr ?? '');
  }
  throw new Error('MCP startup unexpectedly succeeded without a session binding.');
}

describe('MCP server startup diagnostics', () => {
  it('does not expose an unknown startup error or stack on stderr by default', async () => {
    const stderr = await runInvalidStartup();
    const lines = stderr.trimEnd().split(/\r?\n/u);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      code: 'MCP_SERVER_START_FAILED',
      message: 'LUWI MCP server failed to start.',
    });
    expect(stderr).not.toContain('ZodError');
    expect(stderr).not.toContain('config.ts');
  });

  it('prints the unknown startup stack only with the explicit MCP debug flag', async () => {
    const stderr = await runInvalidStartup(true);
    const lines = stderr.trimEnd().split(/\r?\n/u);

    expect(JSON.parse(lines[0]!)).toEqual({
      code: 'MCP_SERVER_START_FAILED',
      message: 'LUWI MCP server failed to start.',
    });
    expect(lines.slice(1).join('\n')).toContain('ZodError');
    expect(lines.slice(1).join('\n')).toContain('config.ts');
  });
});
