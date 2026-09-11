#!/usr/bin/env node
/**
 * Codex 0.153 may expose distinct process-session and conversation-thread ids
 * to MCP children. LUWI binds to the stable conversation thread when present.
 */
import process from 'node:process';

const conversationId = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
if (conversationId !== undefined) {
  process.env.CODEX_SESSION_ID = conversationId;
  process.env.CODEX_THREAD_ID = conversationId;
}

await import('./codex-mcp-launch-v2.mjs');
