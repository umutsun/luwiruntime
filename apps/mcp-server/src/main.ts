#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadMcpServerConfig } from './config.js';
import { createDaemonClient, McpDaemonError } from './daemon-client.js';
import { createLuwiMcpServer } from './server.js';
import { createSessionIdResolver } from './session-binding.js';
import { createMcpToolHandlers } from './tools.js';

async function main(): Promise<void> {
  const config = loadMcpServerConfig(process.env);
  const client = createDaemonClient({
    daemonUrl: config.daemonUrl,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const resolveSessionId = createSessionIdResolver(config.sessionBinding);
  const resolveBoundSession = async () => client.verifyBoundSession(await resolveSessionId());
  const boundSession = await resolveBoundSession();
  const server = createLuwiMcpServer(
    createMcpToolHandlers(client, boundSession, resolveBoundSession),
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
