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
