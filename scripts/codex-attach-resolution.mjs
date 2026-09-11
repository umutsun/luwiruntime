import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { codexAttachPlan } from './native-mcp-binding.mjs';

const LUWI_CLI = join(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'main.js');

export function resolveCodexAttach({
  codexSid,
  cwd,
  temporaryDirectory,
  environment = process.env,
  record,
  execute = spawnSync,
}) {
  if (record !== undefined) {
    return { record, plan: codexAttachPlan(record, temporaryDirectory) };
  }

  const childEnvironment = { ...environment, CODEX_SESSION_ID: codexSid };
  delete childEnvironment.CLAUDE_CODE_CHILD_SESSION;
  delete childEnvironment.CLAUDE_CODE_SESSION_ID;
  delete childEnvironment.CLAUDE_PID;
  const resolved = execute(
    process.execPath,
    [LUWI_CLI, 'session', 'attach', '--agent-kind', 'codex', '--dry-run'],
    {
      cwd,
      env: childEnvironment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8_000,
    },
  );
  if (resolved.error) {
    throw new Error(`Codex attach dry-run timed out: ${resolved.error.message}`);
  }
  if (resolved.status !== 0) throw new Error('Codex attach dry-run failed');

  let request;
  try {
    request = JSON.parse(resolved.stdout);
  } catch {
    throw new Error('Codex attach dry-run returned invalid JSON');
  }
  const fallbackRecord = { request, codexSid, cwd };
  return {
    record: fallbackRecord,
    plan: codexAttachPlan(fallbackRecord, temporaryDirectory),
  };
}
