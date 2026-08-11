import { describe, expect, it } from 'vitest';

import { createRedisKeys } from './index.js';

describe('Redis key registry', () => {
  it('constructs the approved production taxonomy centrally', () => {
    const keys = createRedisKeys();

    expect(keys.globalEvents).toBe('luwi:v1:events:global');
    expect(keys.projectEvents('project-1')).toBe('luwi:v1:events:project:project-1');
    expect(keys.deadLetterEvents).toBe('luwi:v1:events:dead-letter');
    expect(keys.project('project-1')).toBe('luwi:v1:project:project-1');
    expect(keys.session('session-1')).toBe('luwi:v1:session:session-1');
    expect(keys.projectsIndex).toBe('luwi:v1:index:projects');
    expect(keys.projectPathIndex('abc')).toBe('luwi:v1:index:project:path:abc');
    expect(keys.projectSessions('project-1')).toBe('luwi:v1:index:project:project-1:sessions');
    expect(keys.agentSessions('codex-sim')).toBe('luwi:v1:index:agent:codex-sim:sessions');
    expect(keys.sessionPresence('session-1')).toBe('luwi:v1:presence:session:session-1');
    expect(keys.heartbeatDeadlines).toBe('luwi:v1:deadline:heartbeats');
    expect(keys.messageDeadlines).toBe('luwi:v1:deadline:messages');
    expect(keys.messagesIndex).toBe('luwi:v1:index:messages');
    expect(keys.terminalMessages).toBe('luwi:v1:index:messages:terminal');
    expect(keys.message('message-1')).toBe('luwi:v1:message:message-1');
    expect(keys.messageCorrelation('correlation-1')).toBe(
      'luwi:v1:index:message:correlation:correlation-1',
    );
    expect(keys.messageIdempotency('session-1', 'abc123')).toBe(
      'luwi:v1:index:message:idempotency:session-1:abc123',
    );
    expect(keys.projectMessages('project-1')).toBe('luwi:v1:index:project:project-1:messages');
    expect(keys.sourceSessionMessages('session-1')).toBe(
      'luwi:v1:index:session:session-1:messages:source',
    );
    expect(keys.targetSessionMessages('session-2')).toBe(
      'luwi:v1:index:session:session-2:messages:target',
    );
    expect(keys.sessionInbox('session-1')).toBe('luwi:v1:inbox:session:session-1');
    expect(keys.daemonOwner).toBe('luwi:v1:runtime:daemon-owner');
    expect(keys.agentDefinition('codex-main')).toBe('luwi:v1:agent-definition:codex-main');
    expect(keys.agentDefinitionsIndex).toBe('luwi:v1:index:agent-definitions');
    expect(keys.projectAgentBinding('binding-1')).toBe('luwi:v1:project-agent-binding:binding-1');
    expect(keys.projectAgentBindings('project-1')).toBe(
      'luwi:v1:index:project:project-1:agent-bindings',
    );
    expect(keys.agentProjectBindings('codex-main')).toBe(
      'luwi:v1:index:agent:codex-main:project-bindings',
    );
    expect(keys.capability('skill-1')).toBe('luwi:v1:capability:skill-1');
    expect(keys.capabilitiesIndex).toBe('luwi:v1:index:capabilities');
    expect(keys.capabilitiesByKind('skill')).toBe('luwi:v1:index:capability:kind:skill');
    expect(keys.projectCapabilities('project-1')).toBe(
      'luwi:v1:index:project:project-1:capabilities',
    );
    expect(keys.projectCapabilityBindings('project-1')).toBe(
      'luwi:v1:index:project:project-1:capability-bindings',
    );
    expect(keys.agentCapabilities('codex-main')).toBe(
      'luwi:v1:index:agent:codex-main:capabilities',
    );
    expect(keys.profile('backend')).toBe('luwi:v1:profile:backend');
    expect(keys.profilesIndex).toBe('luwi:v1:index:profiles');
    expect(keys.configPlan('plan-1')).toBe('luwi:v1:config-plan:plan-1');
    expect(keys.configPlansExpiry).toBe('luwi:v1:index:config-plans:expiry');
    expect(keys.configOperation('operation-1')).toBe('luwi:v1:config-operation:operation-1');
    expect(keys.configOperationsIndex).toBe('luwi:v1:index:config-operations');
    expect(keys.configDrift('drift-1')).toBe('luwi:v1:config-drift:drift-1');
    expect(keys.configDriftsIndex).toBe('luwi:v1:index:config-drifts');
    expect(keys.contextSource('source-1')).toBe('luwi:v1:context-source:source-1');
    expect(keys.projectContextSources('project-1')).toBe(
      'luwi:v1:index:project:project-1:context-sources',
    );
    expect(keys.agentContextSources('codex-main')).toBe(
      'luwi:v1:index:agent:codex-main:context-sources',
    );
    expect(keys.contextFootprint('project-1', 'codex-main')).toBe(
      'luwi:v1:context-footprint:project:project-1:agent:codex-main',
    );
    expect(keys.usage('usage-1')).toBe('luwi:v1:usage:usage-1');
    expect(keys.usageIndex).toBe('luwi:v1:index:usage');
    expect(keys.projectUsage('project-1')).toBe('luwi:v1:index:project:project-1:usage');
    expect(keys.agentUsage('codex-main')).toBe('luwi:v1:index:agent:codex-main:usage');
    expect(keys.sessionUsage('session-1')).toBe('luwi:v1:index:session:session-1:usage');
    expect(keys.usageSourceEvent('event-1')).toBe('luwi:v1:index:usage:source-event:event-1');
    expect(keys.usageMetric('day:2026-07-30:project:project-1', 'agent-exact')).toBe(
      'luwi:v1:metrics:day:2026-07-30:project:project-1:source:agent-exact',
    );
    expect(keys.gitObservation('git-1')).toBe('luwi:v1:git:observation:git-1');
    expect(keys.projectGitCurrent('project-1')).toBe('luwi:v1:git:project:project-1:current');
    expect(keys.projectGitObservations('project-1')).toBe(
      'luwi:v1:index:project:project-1:git-observations',
    );
    expect(keys.gitCommit('project-1', 'abc')).toBe('luwi:v1:git:commit:project-1:abc');
    expect(keys.projectCommits('project-1')).toBe('luwi:v1:index:project:project-1:commits');
    expect(keys.sessionCommits('session-1')).toBe('luwi:v1:index:session:session-1:commits');
    expect(keys.package('project-1', 'node', 'pkg-1')).toBe('luwi:v1:package:project-1:node:pkg-1');
    expect(keys.projectPackages('project-1')).toBe('luwi:v1:index:project:project-1:packages');
    expect(keys.projectTechnologies('project-1')).toBe(
      'luwi:v1:index:project:project-1:technologies',
    );
    expect(keys.graphNode('generation-1', 'project', 'project-1')).toBe(
      'luwi:v1:graph:generation:generation-1:node:project:project-1',
    );
    expect(keys.graphEdge('generation-1', 'edge-1')).toBe(
      'luwi:v1:graph:generation:generation-1:edge:edge-1',
    );
    expect(keys.graphOutgoing('generation-1', 'project', 'project-1')).toBe(
      'luwi:v1:graph:generation:generation-1:out:project:project-1',
    );
    expect(keys.graphActiveGeneration).toBe('luwi:v1:graph:generation:active');
    expect(keys.graphGenerationsIndex).toBe('luwi:v1:index:graph:generations');
    expect(keys.graphRebuild('rebuild-1')).toBe('luwi:v1:graph:rebuild:rebuild-1');
    expect(keys.optimizationFinding('finding-1')).toBe('luwi:v1:optimization:finding:finding-1');
    expect(keys.optimizationProposal('proposal-1')).toBe(
      'luwi:v1:optimization:proposal:proposal-1',
    );
    expect(keys.optimizationEvaluation('evaluation-1')).toBe(
      'luwi:v1:optimization:evaluation:evaluation-1',
    );
  });

  it('supports a run-specific test namespace without changing suffixes', () => {
    const keys = createRedisKeys('luwi:test:run-123:v1');

    expect(keys.globalEvents).toBe('luwi:test:run-123:v1:events:global');
    expect(keys.project('project-1')).toBe('luwi:test:run-123:v1:project:project-1');
  });

  it('rejects unsafe entity identifiers before constructing keys', () => {
    const keys = createRedisKeys();

    expect(() => keys.project('project/1')).toThrow();
    expect(() => keys.agentSessions('../agent')).toThrow();
    expect(() => keys.messageIdempotency('session-1', 'bad/hash')).toThrow();
    expect(() => keys.capability('../skill')).toThrow();
    expect(() => keys.contextFootprint('project-1', 'bad/agent')).toThrow();
  });
});

describe('native session keys', () => {
  const keys = createRedisKeys();

  it('namespaces every native key under the library prefix', () => {
    expect(keys.nativeSessionBinding('b1')).toBe('luwi:v1:native-session:b1');
    expect(keys.nativeSessionLink('l1')).toBe('luwi:v1:native-session-link:l1');
    expect(keys.nativeSessionLinks('b1')).toBe('luwi:v1:index:native-session:b1:links');
    expect(keys.sessionNativeBinding('s1')).toBe('luwi:v1:index:session:s1:native');
  });

  /**
   * The identifiers reaching these builders are derived hashes, but the guard is
   * what keeps a future caller from passing a raw native value through.
   */
  it('rejects an unsafe identifier rather than building a key from it', () => {
    for (const unsafe of ['', 'has space', 'a/b', '-leading']) {
      expect(() => keys.nativeSessionBinding(unsafe)).toThrow('Unsafe Redis key identifier');
      expect(() => keys.nativeSessionLink(unsafe)).toThrow('Unsafe Redis key identifier');
      expect(() => keys.nativeSessionLinks(unsafe)).toThrow('Unsafe Redis key identifier');
      expect(() => keys.sessionNativeBinding(unsafe)).toThrow('Unsafe Redis key identifier');
    }
  });
});
