export interface RedisKeys {
  readonly namespace: string;
  readonly globalEvents: string;
  readonly deadLetterEvents: string;
  readonly projectsIndex: string;
  readonly heartbeatDeadlines: string;
  readonly messagesIndex: string;
  readonly terminalMessages: string;
  readonly messageDeadlines: string;
  readonly daemonOwner: string;
  readonly agentDefinitionsIndex: string;
  readonly capabilitiesIndex: string;
  readonly profilesIndex: string;
  readonly capabilityBindingsIndex: string;
  readonly configPlansExpiry: string;
  readonly configOperationsIndex: string;
  readonly configDriftsIndex: string;
  readonly contextSourcesIndex: string;
  readonly contextFootprintsIndex: string;
  readonly usageIndex: string;
  readonly contextContributionsIndex: string;
  readonly gitObservationsIndex: string;
  readonly attributionsIndex: string;
  readonly graphActiveGeneration: string;
  readonly graphGenerationsIndex: string;
  readonly graphRebuildsIndex: string;
  readonly graphRebuildLock: string;
  readonly graphProjectionFailures: string;
  readonly graphProjectionHealth: string;
  readonly optimizationFindingsIndex: string;
  readonly optimizationProposalsIndex: string;
  readonly optimizationEvaluationsIndex: string;
  readonly intelligenceEarliestObservation: string;
  projectEvents(projectId: string): string;
  project(projectId: string): string;
  session(sessionId: string): string;
  projectPathIndex(pathIdentityHash: string): string;
  projectSessions(projectId: string): string;
  agentSessions(agentId: string): string;
  sessionPresence(sessionId: string): string;
  message(messageId: string): string;
  messageCorrelation(correlationId: string): string;
  messageIdempotency(sourceSessionId: string, hash: string): string;
  projectMessages(projectId: string): string;
  sourceSessionMessages(sessionId: string): string;
  targetSessionMessages(sessionId: string): string;
  sessionInbox(sessionId: string): string;
  agentDefinition(agentId: string): string;
  projectAgentBinding(bindingId: string): string;
  projectAgentBindings(projectId: string): string;
  agentProjectBindings(agentId: string): string;
  capability(capabilityId: string): string;
  capabilitiesByKind(kind: string): string;
  projectCapabilities(projectId: string): string;
  projectCapabilityBindings(projectId: string): string;
  agentCapabilities(agentId: string): string;
  profile(profileId: string): string;
  capabilityBinding(bindingId: string): string;
  configPlan(planId: string): string;
  configOperation(operationId: string): string;
  configDrift(driftId: string): string;
  contextSource(sourceId: string): string;
  projectContextSources(projectId: string): string;
  agentContextSources(agentId: string): string;
  contextFootprint(projectId: string, agentId: string): string;
  usage(usageId: string): string;
  projectUsage(projectId: string): string;
  agentUsage(agentId: string): string;
  sessionUsage(sessionId: string): string;
  usageSourceEvent(sourceEventId: string): string;
  usageMetric(scope: string, source: string): string;
  contextContribution(contributionId: string): string;
  projectContextContributions(projectId: string): string;
  agentContextContributions(agentId: string): string;
  sessionContextContributions(sessionId: string): string;
  gitObservation(observationId: string): string;
  projectGitCurrent(projectId: string): string;
  projectGitObservations(projectId: string): string;
  gitCommit(projectId: string, commitSha: string): string;
  projectCommits(projectId: string): string;
  sessionCommits(sessionId: string): string;
  attribution(attributionId: string): string;
  projectAttributions(projectId: string): string;
  package(projectId: string, ecosystem: string, packageId: string): string;
  projectPackages(projectId: string): string;
  technology(projectId: string, technologyId: string): string;
  projectTechnologies(projectId: string): string;
  graphNode(generation: string, nodeKind: string, nodeId: string): string;
  graphEdge(generation: string, edgeId: string): string;
  graphOutgoing(generation: string, nodeKind: string, nodeId: string): string;
  graphIncoming(generation: string, nodeKind: string, nodeId: string): string;
  graphNodesByKind(generation: string, nodeKind: string): string;
  graphEdgesByKind(generation: string, edgeKind: string): string;
  graphRebuild(operationId: string): string;
  optimizationFinding(findingId: string): string;
  projectOptimizationFindings(projectId: string): string;
  optimizationProposal(proposalId: string): string;
  projectOptimizationProposals(projectId: string): string;
  optimizationEvaluation(evaluationId: string): string;
}

export const SESSION_INBOX_CONSUMER_GROUP = 'luwi-session-inbox-v1';

const safeKeyPartPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function keyPart(value: string): string {
  if (!safeKeyPartPattern.test(value)) {
    throw new Error('Unsafe Redis key identifier');
  }
  return value;
}

export function createRedisKeys(namespace = 'luwi:v1'): RedisKeys {
  const prefix = namespace.replace(/:+$/, '');

  return {
    namespace: prefix,
    globalEvents: `${prefix}:events:global`,
    deadLetterEvents: `${prefix}:events:dead-letter`,
    projectsIndex: `${prefix}:index:projects`,
    heartbeatDeadlines: `${prefix}:deadline:heartbeats`,
    messagesIndex: `${prefix}:index:messages`,
    terminalMessages: `${prefix}:index:messages:terminal`,
    messageDeadlines: `${prefix}:deadline:messages`,
    daemonOwner: `${prefix}:runtime:daemon-owner`,
    agentDefinitionsIndex: `${prefix}:index:agent-definitions`,
    capabilitiesIndex: `${prefix}:index:capabilities`,
    profilesIndex: `${prefix}:index:profiles`,
    capabilityBindingsIndex: `${prefix}:index:capability-bindings`,
    configPlansExpiry: `${prefix}:index:config-plans:expiry`,
    configOperationsIndex: `${prefix}:index:config-operations`,
    configDriftsIndex: `${prefix}:index:config-drifts`,
    contextSourcesIndex: `${prefix}:index:context-sources`,
    contextFootprintsIndex: `${prefix}:index:context-footprints`,
    usageIndex: `${prefix}:index:usage`,
    contextContributionsIndex: `${prefix}:index:context-contributions`,
    gitObservationsIndex: `${prefix}:index:git-observations`,
    attributionsIndex: `${prefix}:index:attributions`,
    graphActiveGeneration: `${prefix}:graph:generation:active`,
    graphGenerationsIndex: `${prefix}:index:graph:generations`,
    graphRebuildsIndex: `${prefix}:index:graph:rebuilds`,
    graphRebuildLock: `${prefix}:graph:rebuild:lock`,
    graphProjectionFailures: `${prefix}:graph:projection:failures`,
    graphProjectionHealth: `${prefix}:graph:projection:health`,
    optimizationFindingsIndex: `${prefix}:index:optimization:findings`,
    optimizationProposalsIndex: `${prefix}:index:optimization:proposals`,
    optimizationEvaluationsIndex: `${prefix}:index:optimization:evaluations`,
    intelligenceEarliestObservation: `${prefix}:intelligence:earliest-observation`,
    projectEvents: (projectId) => `${prefix}:events:project:${keyPart(projectId)}`,
    project: (projectId) => `${prefix}:project:${keyPart(projectId)}`,
    session: (sessionId) => `${prefix}:session:${keyPart(sessionId)}`,
    projectPathIndex: (pathIdentityHash) =>
      `${prefix}:index:project:path:${keyPart(pathIdentityHash)}`,
    projectSessions: (projectId) => `${prefix}:index:project:${keyPart(projectId)}:sessions`,
    agentSessions: (agentId) => `${prefix}:index:agent:${keyPart(agentId)}:sessions`,
    sessionPresence: (sessionId) => `${prefix}:presence:session:${keyPart(sessionId)}`,
    message: (messageId) => `${prefix}:message:${keyPart(messageId)}`,
    messageCorrelation: (correlationId) =>
      `${prefix}:index:message:correlation:${keyPart(correlationId)}`,
    messageIdempotency: (sourceSessionId, hash) =>
      `${prefix}:index:message:idempotency:${keyPart(sourceSessionId)}:${keyPart(hash)}`,
    projectMessages: (projectId) => `${prefix}:index:project:${keyPart(projectId)}:messages`,
    sourceSessionMessages: (sessionId) =>
      `${prefix}:index:session:${keyPart(sessionId)}:messages:source`,
    targetSessionMessages: (sessionId) =>
      `${prefix}:index:session:${keyPart(sessionId)}:messages:target`,
    sessionInbox: (sessionId) => `${prefix}:inbox:session:${keyPart(sessionId)}`,
    agentDefinition: (agentId) => `${prefix}:agent-definition:${keyPart(agentId)}`,
    projectAgentBinding: (bindingId) => `${prefix}:project-agent-binding:${keyPart(bindingId)}`,
    projectAgentBindings: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:agent-bindings`,
    agentProjectBindings: (agentId) => `${prefix}:index:agent:${keyPart(agentId)}:project-bindings`,
    capability: (capabilityId) => `${prefix}:capability:${keyPart(capabilityId)}`,
    capabilitiesByKind: (kind) => `${prefix}:index:capability:kind:${keyPart(kind)}`,
    projectCapabilities: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:capabilities`,
    projectCapabilityBindings: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:capability-bindings`,
    agentCapabilities: (agentId) => `${prefix}:index:agent:${keyPart(agentId)}:capabilities`,
    profile: (profileId) => `${prefix}:profile:${keyPart(profileId)}`,
    capabilityBinding: (bindingId) => `${prefix}:capability-binding:${keyPart(bindingId)}`,
    configPlan: (planId) => `${prefix}:config-plan:${keyPart(planId)}`,
    configOperation: (operationId) => `${prefix}:config-operation:${keyPart(operationId)}`,
    configDrift: (driftId) => `${prefix}:config-drift:${keyPart(driftId)}`,
    contextSource: (sourceId) => `${prefix}:context-source:${keyPart(sourceId)}`,
    projectContextSources: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:context-sources`,
    agentContextSources: (agentId) => `${prefix}:index:agent:${keyPart(agentId)}:context-sources`,
    contextFootprint: (projectId, agentId) =>
      `${prefix}:context-footprint:project:${keyPart(projectId)}:agent:${keyPart(agentId)}`,
    usage: (usageId) => `${prefix}:usage:${keyPart(usageId)}`,
    projectUsage: (projectId) => `${prefix}:index:project:${keyPart(projectId)}:usage`,
    agentUsage: (agentId) => `${prefix}:index:agent:${keyPart(agentId)}:usage`,
    sessionUsage: (sessionId) => `${prefix}:index:session:${keyPart(sessionId)}:usage`,
    usageSourceEvent: (sourceEventId) =>
      `${prefix}:index:usage:source-event:${keyPart(sourceEventId)}`,
    usageMetric: (scope, source) => `${prefix}:metrics:${keyPart(scope)}:source:${keyPart(source)}`,
    contextContribution: (contributionId) =>
      `${prefix}:context-contribution:${keyPart(contributionId)}`,
    projectContextContributions: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:context-contributions`,
    agentContextContributions: (agentId) =>
      `${prefix}:index:agent:${keyPart(agentId)}:context-contributions`,
    sessionContextContributions: (sessionId) =>
      `${prefix}:index:session:${keyPart(sessionId)}:context-contributions`,
    gitObservation: (observationId) => `${prefix}:git:observation:${keyPart(observationId)}`,
    projectGitCurrent: (projectId) => `${prefix}:git:project:${keyPart(projectId)}:current`,
    projectGitObservations: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:git-observations`,
    gitCommit: (projectId, commitSha) =>
      `${prefix}:git:commit:${keyPart(projectId)}:${keyPart(commitSha)}`,
    projectCommits: (projectId) => `${prefix}:index:project:${keyPart(projectId)}:commits`,
    sessionCommits: (sessionId) => `${prefix}:index:session:${keyPart(sessionId)}:commits`,
    attribution: (attributionId) => `${prefix}:attribution:${keyPart(attributionId)}`,
    projectAttributions: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:attributions`,
    package: (projectId, ecosystem, packageId) =>
      `${prefix}:package:${keyPart(projectId)}:${keyPart(ecosystem)}:${keyPart(packageId)}`,
    projectPackages: (projectId) => `${prefix}:index:project:${keyPart(projectId)}:packages`,
    technology: (projectId, technologyId) =>
      `${prefix}:technology:${keyPart(projectId)}:${keyPart(technologyId)}`,
    projectTechnologies: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:technologies`,
    graphNode: (generation, nodeKind, nodeId) =>
      `${prefix}:graph:generation:${keyPart(generation)}:node:${keyPart(nodeKind)}:${keyPart(nodeId)}`,
    graphEdge: (generation, edgeId) =>
      `${prefix}:graph:generation:${keyPart(generation)}:edge:${keyPart(edgeId)}`,
    graphOutgoing: (generation, nodeKind, nodeId) =>
      `${prefix}:graph:generation:${keyPart(generation)}:out:${keyPart(nodeKind)}:${keyPart(nodeId)}`,
    graphIncoming: (generation, nodeKind, nodeId) =>
      `${prefix}:graph:generation:${keyPart(generation)}:in:${keyPart(nodeKind)}:${keyPart(nodeId)}`,
    graphNodesByKind: (generation, nodeKind) =>
      `${prefix}:graph:generation:${keyPart(generation)}:index:nodes:${keyPart(nodeKind)}`,
    graphEdgesByKind: (generation, edgeKind) =>
      `${prefix}:graph:generation:${keyPart(generation)}:index:edges:${keyPart(edgeKind)}`,
    graphRebuild: (operationId) => `${prefix}:graph:rebuild:${keyPart(operationId)}`,
    optimizationFinding: (findingId) => `${prefix}:optimization:finding:${keyPart(findingId)}`,
    projectOptimizationFindings: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:optimization-findings`,
    optimizationProposal: (proposalId) => `${prefix}:optimization:proposal:${keyPart(proposalId)}`,
    projectOptimizationProposals: (projectId) =>
      `${prefix}:index:project:${keyPart(projectId)}:optimization-proposals`,
    optimizationEvaluation: (evaluationId) =>
      `${prefix}:optimization:evaluation:${keyPart(evaluationId)}`,
  };
}
