#!/usr/bin/env node
import { LUWI_RUNTIME_VERSION } from '@luwi/protocol';

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function childEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
}

function parseInput(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool input must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
    cwd: process.cwd(),
    env: childEnvironment(),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'luwi-mcp-harness', version: LUWI_RUNTIME_VERSION });
  await client.connect(transport);
  try {
    const toolName = process.argv[2];
    const result =
      toolName === undefined
        ? await client.listTools()
        : await client.callTool({
            name: toolName,
            arguments: parseInput(process.argv[3]),
          });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

void main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      error: {
        code: 'MCP_HARNESS_FAILED',
        message: 'The LUWI MCP harness failed.',
      },
    })}\n`,
  );
  process.exitCode = 1;
});
