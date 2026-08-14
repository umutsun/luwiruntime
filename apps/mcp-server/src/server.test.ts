import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createLuwiMcpServer } from './server.js';
import type { McpToolHandlers } from './tools.js';

describe('LUWI MCP server', () => {
  it('registers the approved thin daemon-client tool surface', async () => {
    const operation = vi.fn(async () => ({}));
    const handlers: McpToolHandlers = {
      listProjects: vi.fn(async () => ({ projects: [], truncated: false })),
      listSessions: operation,
      getSession: operation,
      getProjectState: operation,
      askAgent: operation,
      awaitResponse: operation,
      getMessage: operation,
      inboxNext: operation,
      acknowledgeMessage: operation,
      markMessageProcessing: operation,
      respondToMessage: operation,
      rejectMessage: operation,
      failMessage: operation,
      listAgents: vi.fn(async () => ({ agents: [], truncated: false })),
      getAgent: operation,
      listProjectAgents: vi.fn(async () => ({ bindings: [], truncated: false })),
      getEffectiveConfig: operation,
      listCapabilities: vi.fn(async () => ({ capabilities: [], truncated: false })),
      getCapability: operation,
      getContextFootprint: operation,
      getConfigDrift: vi.fn(async () => ({ drifts: [], truncated: false })),
      getUsageSummary: operation,
      getContextIntelligence: operation,
      getGitStatus: operation,
      getRecentCommits: operation,
      getPackageInventory: operation,
      getTechnologyInventory: operation,
      getGraphNeighbors: operation,
      getGraphPath: operation,
      listOptimizationFindings: operation,
      getOptimizationProposal: operation,
      requestOptimizationAnalysis: operation,
      acquireLease: operation,
      renewLease: operation,
      releaseLease: operation,
      listLeases: vi.fn(async () => ({ leases: [], truncated: false })),
    };
    const server = createLuwiMcpServer(handlers);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).toSorted()).toEqual(
      [
        'luwi_acknowledge_message',
        'luwi_acquire_lease',
        'luwi_ask_agent',
        'luwi_list_leases',
        'luwi_release_lease',
        'luwi_renew_lease',
        'luwi_await_response',
        'luwi_fail_message',
        'luwi_get_message',
        'luwi_get_agent',
        'luwi_get_capability',
        'luwi_get_config_drift',
        'luwi_get_context_footprint',
        'luwi_get_context_intelligence',
        'luwi_get_effective_config',
        'luwi_get_git_status',
        'luwi_get_graph_neighbors',
        'luwi_get_graph_path',
        'luwi_get_project_state',
        'luwi_get_session',
        'luwi_get_usage_summary',
        'luwi_get_recent_commits',
        'luwi_get_package_inventory',
        'luwi_get_technology_inventory',
        'luwi_get_optimization_proposal',
        'luwi_inbox_next',
        'luwi_list_projects',
        'luwi_list_agents',
        'luwi_list_capabilities',
        'luwi_list_project_agents',
        'luwi_list_sessions',
        'luwi_list_optimization_findings',
        'luwi_mark_message_processing',
        'luwi_reject_message',
        'luwi_respond_to_message',
        'luwi_request_optimization_analysis',
      ].toSorted(),
    );
    expect(tools.tools.every(({ outputSchema }) => outputSchema?.type === 'object')).toBe(true);
    const result = await client.callTool({
      name: 'luwi_list_projects',
      arguments: {},
    });
    expect(result.structuredContent).toEqual({ projects: [], truncated: false });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: '0 projects returned.',
      },
    ]);
    expect(JSON.stringify(result.content).length).toBeLessThan(512);
    await client.close();
    await server.close();
  });
});
