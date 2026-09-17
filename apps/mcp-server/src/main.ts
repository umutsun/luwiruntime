#!/usr/bin/env node

import type { SessionView } from '@luwi/protocol';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadMcpServerConfig } from './config.js';
import { createDaemonClient, McpDaemonError } from './daemon-client.js';
import { createLuwiMcpServer } from './server.js';
import { createSessionBindingResolver } from './session-binding.js';
import { createSessionRevival } from './session-revival.js';
import { createMcpToolHandlers } from './tools.js';

async function main(): Promise<void> {
  const config = loadMcpServerConfig(process.env);
  const client = createDaemonClient({
    daemonUrl: config.daemonUrl,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const resolveBinding = createSessionBindingResolver(config.sessionBinding);
  const resolveSessionId = async () => (await resolveBinding()).attached;
  const revival = createSessionRevival({
    client,
    resolveBinding,
    onError: (error) => {
      if (process.env.LUWI_MCP_DEBUG === '1') process.stderr.write(`${String(error)}\n`);
    },
  });
  const resolveBoundSession = () => revival.resolveBoundSession();
  // Still fail-closed on a missing or unknown session. A dropped attach session
  // is neither: its project is known, and the first `luwi_join` revives it
  // (ADR 0034); every other tool answers BOUND_SESSION_TERMINAL until then.
  let boundSession: SessionView;
  try {
    boundSession = await resolveBoundSession();
  } catch (error) {
    if (!(error instanceof McpDaemonError) || error.code !== 'BOUND_SESSION_TERMINAL') throw error;
    boundSession = await client.getSession(await resolveSessionId());
  }
  const server = createLuwiMcpServer(
    createMcpToolHandlers(client, boundSession, resolveBoundSession, () => revival.revive()),
  );
  await server.connect(new StdioServerTransport());

  // A connected MCP server IS the session's reader. A session still `starting`
  // (nothing ever called `luwi_join`) is promoted to `idle` on connect, so an
  // active agent — a GUI/IDE session that never explicitly joins — stops
  // reading `starting` forever. Guarded to `starting` only, so it never
  // overrides a bridge child's own `tool_running`; best-effort, because a
  // failed promotion must not take the server down. A dropped/terminal binding
  // is not `starting`, so the guard leaves ADR 0034 revival to `luwi_join`.
  if (boundSession.status === 'starting') {
    try {
      await client.setSessionStatus(boundSession.id, 'idle');
    } catch (error) {
      if (process.env.LUWI_MCP_DEBUG === '1') {
        process.stderr.write(`idle-on-connect failed: ${String(error)}\n`);
      }
    }
  }
}

void main().catch((error: unknown) => {
  const safe =
    error instanceof McpDaemonError
      ? { code: error.code, message: error.message }
      : { code: 'MCP_SERVER_START_FAILED', message: 'LUWI MCP server failed to start.' };
  process.stderr.write(`${JSON.stringify(safe)}\n`);
  if (process.env.LUWI_MCP_DEBUG === '1') {
    const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${diagnostic}\n`);
  }
  process.exitCode = 1;
});
