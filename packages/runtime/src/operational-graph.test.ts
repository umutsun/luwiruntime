import { describe, expect, it } from 'vitest';

import type { GraphEdge, GraphNode } from '@luwi/protocol';

import {
  createGraphEdge,
  createGraphNode,
  createOperationalGraphQuery,
} from './operational-graph.js';

const observedAt = '2026-07-30T00:00:00.000Z';

describe('operational graph policy', () => {
  const project = createGraphNode({
    kind: 'project',
    entityId: 'project-1',
    projectId: 'project-1',
    observedAt,
    provenance: 'project.registered',
    confidence: 'high',
    evidenceIds: ['event-project'],
  });
  const agent = createGraphNode({
    kind: 'agent',
    entityId: 'codex',
    projectId: 'project-1',
    observedAt,
    provenance: 'agent.definition.registered',
    confidence: 'high',
    evidenceIds: ['event-agent'],
  });
  const session = createGraphNode({
    kind: 'session',
    entityId: 'session-1',
    projectId: 'project-1',
    observedAt,
    provenance: 'session.registered',
    confidence: 'high',
    evidenceIds: ['event-session'],
  });
  const projectAgent = createGraphEdge({
    source: { kind: 'project', id: 'project-1' },
    target: { kind: 'agent', id: 'codex' },
    kind: 'PROJECT_BOUND_AGENT',
    projectId: 'project-1',
    observedAt,
    provenance: 'project.agent.bound',
    confidence: 'high',
    evidenceIds: ['binding-event'],
  });
  const agentSession = createGraphEdge({
    source: { kind: 'agent', id: 'codex' },
    target: { kind: 'session', id: 'session-1' },
    kind: 'AGENT_RAN_SESSION',
    projectId: 'project-1',
    observedAt,
    provenance: 'session.registered',
    confidence: 'high',
    evidenceIds: ['session-event'],
  });

  it('creates deterministic node and edge identities with provenance', () => {
    expect(
      createGraphNode({
        kind: 'project',
        entityId: 'project-1',
        projectId: 'project-1',
        observedAt,
        provenance: 'project.registered',
        confidence: 'high',
        evidenceIds: ['event-project'],
      }).id,
    ).toBe(project.id);
    expect(projectAgent.id).toBe(
      createGraphEdge({
        ...projectAgent,
        id: undefined,
      }).id,
    );
    expect(projectAgent.evidenceIds).toEqual(['binding-event']);
  });

  it('keeps project-scoped node identities distinct across projects', () => {
    const first = createGraphNode({
      kind: 'technology',
      entityId: 'typescript',
      projectId: 'project-1',
      observedAt,
      provenance: 'technology-inventory',
      confidence: 'high',
      evidenceIds: ['package.json'],
    });
    const second = createGraphNode({
      ...first,
      id: undefined,
      projectId: 'project-2',
    });
    expect(second.id).not.toBe(first.id);
  });

  it('queries bounded outgoing and incoming neighbors', () => {
    const graph = createOperationalGraphQuery(
      [project, agent, session],
      [projectAgent, agentSession],
    );
    expect(graph.neighbors('project', 'project-1', 'out', { limit: 100 })).toMatchObject({
      nodes: [agent],
      edges: [projectAgent],
      truncated: false,
    });
    expect(graph.neighbors('session', 'session-1', 'in', { limit: 100 }).nodes).toEqual([agent]);
  });

  it('finds a bounded shortest path and subgraph', () => {
    const graph = createOperationalGraphQuery(
      [project, agent, session],
      [projectAgent, agentSession],
    );
    const path = graph.shortestPath('project', 'project-1', {
      toKind: 'session',
      toId: 'session-1',
      maxDepth: 3,
    });
    expect(path.found).toBe(true);
    expect(path.nodes.map(({ kind }) => kind)).toEqual(['project', 'agent', 'session']);
    expect(path.edges).toHaveLength(2);

    const subgraph = graph.subgraph({
      nodeKind: 'project',
      nodeId: 'project-1',
      maxDepth: 2,
      nodeLimit: 3,
    });
    expect(subgraph.nodes).toHaveLength(3);
    expect(subgraph.truncated).toBe(false);
  });

  it('rejects runtime calls above protocol bounds even with typed input bypasses', () => {
    const graph = createOperationalGraphQuery(
      [project, agent, session] as GraphNode[],
      [projectAgent, agentSession] as GraphEdge[],
    );
    expect(() => graph.neighbors('project', 'project-1', 'out', { limit: 1001 })).toThrowError(
      /limit/i,
    );
    expect(() =>
      graph.shortestPath('project', 'project-1', {
        toKind: 'session',
        toId: 'session-1',
        maxDepth: 7,
      }),
    ).toThrowError(/depth/i);
  });
});
