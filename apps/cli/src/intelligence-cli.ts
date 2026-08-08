import {
  attributionCollectionSchema,
  contextContributionCollectionSchema,
  contextContributionObservationRequestSchema,
  contextContributionSchema,
  contextIntelligenceSchema,
  contextSummarySchema,
  gitCommitCollectionSchema,
  gitObservationSchema,
  gitWorktreeCollectionSchema,
  graphNeighborsResponseSchema,
  graphNodeSchema,
  graphPathResponseSchema,
  graphRebuildOperationSchema,
  graphSubgraphResponseSchema,
  optimizationAnalysisResponseSchema,
  optimizationConfigPlanResponseSchema,
  optimizationEvaluationSchema,
  optimizationFindingCollectionSchema,
  optimizationProposalCollectionSchema,
  optimizationProposalSchema,
  packageCollectionSchema,
  packageScanResponseSchema,
  publicErrorResponseSchema,
  technologyCollectionSchema,
  usageCollectionSchema,
  usageIngestRequestSchema,
  usageRecordSchema,
  usageSummarySchema,
  type ContextContribution,
  type UsageRecord,
} from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import type { Command } from 'commander';

import type { FetchInitLike, HttpResponseLike } from './cli.js';

type Parser<Output> = { parse(value: unknown): Output };

export type IntelligenceCliDependencies = {
  fetch: (url: string, init?: FetchInitLike) => Promise<HttpResponseLike>;
  stdout: { write(text: string): unknown };
};

const DEFAULT_URL = 'http://127.0.0.1:4782';

function endpoint(base: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path, `${base.replace(/\/+$/, '')}/`);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.toString();
}

async function request<Output>(
  dependencies: IntelligenceCliDependencies,
  base: string,
  path: string,
  parser: Parser<Output>,
  init?: FetchInitLike,
  query?: Record<string, string | undefined>,
): Promise<Output> {
  const response = await dependencies.fetch(endpoint(base, path, query), init);
  const body = await response.json();
  if (!response.ok) {
    const parsed = publicErrorResponseSchema.safeParse(body);
    if (parsed.success) {
      throw new ApplicationError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
        parsed.data.error.details,
      );
    }
    throw new ApplicationError(
      'DAEMON_REQUEST_FAILED',
      `Daemon request failed with status ${response.status}`,
      response.status,
    );
  }
  return parser.parse(body);
}

function mutation(body?: unknown): FetchInitLike {
  return {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  };
}

function parseObject(value: string, option = '--body'): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApplicationError('CLI_OPTION_INVALID', `${option} must be a JSON object.`, 400);
  }
}

function print(dependencies: IntelligenceCliDependencies, value: unknown): void {
  dependencies.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function addUrl(command: Command): Command {
  return command.option('-u, --url <url>', 'LUWI daemon base URL', DEFAULT_URL);
}

function id(value: string): string {
  return encodeURIComponent(value);
}

function usageLabel(record: UsageRecord): 'exact' | 'reported' | 'estimated' | 'unknown' {
  switch (record.source) {
    case 'agent-exact':
      return 'exact';
    case 'agent-reported':
    case 'adapter-extracted':
      return 'reported';
    case 'luwi-estimated':
      return 'estimated';
    case 'unavailable':
      return 'unknown';
  }
}

function labelledUsage(record: UsageRecord): UsageRecord & { measurementLabel: string } {
  return { ...record, measurementLabel: usageLabel(record) };
}

function labelledContribution(
  contribution: ContextContribution,
): ContextContribution & { observationLabel: 'reported' | 'estimated' | 'unknown' } {
  return {
    ...contribution,
    observationLabel:
      contribution.loaded === 'unknown' && contribution.invoked === 'unknown'
        ? 'unknown'
        : contribution.source === 'estimated'
          ? 'estimated'
          : 'reported',
  };
}

type UrlOptions = { url: string };
type ProjectOptions = UrlOptions & { project: string; limit?: string };

export function registerIntelligenceCli(
  program: Command,
  dependencies: IntelligenceCliDependencies,
): void {
  const usage = program.command('usage').description('Inspect labelled usage intelligence');
  addUrl(usage.command('ingest').requiredOption('--body <json>', 'Usage record JSON')).action(
    async (options: UrlOptions & { body: string }) => {
      const body = usageIngestRequestSchema.parse(parseObject(options.body));
      const record = await request(
        dependencies,
        options.url,
        '/api/v1/usage',
        usageRecordSchema,
        mutation(body),
      );
      print(dependencies, labelledUsage(record));
    },
  );
  addUrl(
    usage
      .command('list')
      .option('--project <projectId>')
      .option('--agent <agentId>')
      .option('--session <sessionId>')
      .option('--source <source>')
      .option('--confidence <confidence>')
      .option('--from <timestamp>')
      .option('--to <timestamp>')
      .option('--limit <count>', 'Maximum records', '100'),
  ).action(
    async (
      options: UrlOptions & {
        project?: string;
        agent?: string;
        session?: string;
        source?: string;
        confidence?: string;
        from?: string;
        to?: string;
        limit: string;
      },
    ) => {
      const result = await request(
        dependencies,
        options.url,
        '/api/v1/usage',
        usageCollectionSchema,
        undefined,
        {
          projectId: options.project,
          agentId: options.agent,
          sessionId: options.session,
          source: options.source,
          confidence: options.confidence,
          from: options.from,
          to: options.to,
          limit: options.limit,
        },
      );
      print(dependencies, {
        ...result,
        records: result.records.map(labelledUsage),
      });
    },
  );
  addUrl(
    usage
      .command('summary')
      .option('--project <projectId>')
      .option('--agent <agentId>')
      .option('--session <sessionId>')
      .option('--from <timestamp>')
      .option('--to <timestamp>')
      .option('--limit <count>', 'Maximum records', '1000'),
  ).action(
    async (
      options: UrlOptions & {
        project?: string;
        agent?: string;
        session?: string;
        from?: string;
        to?: string;
        limit: string;
      },
    ) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          '/api/v1/usage/summary',
          usageSummarySchema,
          undefined,
          {
            projectId: options.project,
            agentId: options.agent,
            sessionId: options.session,
            from: options.from,
            to: options.to,
            limit: options.limit,
          },
        ),
      ),
  );

  const context =
    program.commands.find((command) => command.name() === 'context') ??
    program.command('context').description('Inspect context contribution evidence');
  addUrl(
    context.command('observe').requiredOption('--body <json>', 'Session context observation JSON'),
  ).action(async (options: UrlOptions & { body: string }) => {
    const body = contextContributionObservationRequestSchema.parse(parseObject(options.body));
    const result = await request(
      dependencies,
      options.url,
      '/api/v1/context/contributions',
      contextContributionSchema,
      mutation(body),
    );
    print(dependencies, labelledContribution(result));
  });
  addUrl(
    context
      .command('analyze')
      .requiredOption('--project <projectId>')
      .requiredOption('--agent <agentId>'),
  ).action(async (options: UrlOptions & { project: string; agent: string }) => {
    const result = await request(
      dependencies,
      options.url,
      '/api/v1/context/analyze',
      contextIntelligenceSchema,
      mutation({ projectId: options.project, agentId: options.agent }),
    );
    print(dependencies, {
      ...result,
      contributions: result.contributions.map(labelledContribution),
    });
  });
  addUrl(
    context
      .command('intelligence')
      .requiredOption('--project <projectId>')
      .requiredOption('--agent <agentId>'),
  ).action(async (options: UrlOptions & { project: string; agent: string }) => {
    const result = await request(
      dependencies,
      options.url,
      `/api/v1/projects/${id(options.project)}/agents/${id(options.agent)}/context-intelligence`,
      contextIntelligenceSchema,
    );
    print(dependencies, {
      ...result,
      contributions: result.contributions.map(labelledContribution),
    });
  });
  addUrl(
    context
      .command('contributions')
      .option('--project <projectId>')
      .option('--agent <agentId>')
      .option('--session <sessionId>')
      .option('--limit <count>', 'Maximum contributions', '100'),
  ).action(
    async (
      options: UrlOptions & {
        project?: string;
        agent?: string;
        session?: string;
        limit: string;
      },
    ) => {
      const result = await request(
        dependencies,
        options.url,
        '/api/v1/context/contributions',
        contextContributionCollectionSchema,
        undefined,
        {
          projectId: options.project,
          agentId: options.agent,
          sessionId: options.session,
          limit: options.limit,
        },
      );
      print(dependencies, {
        ...result,
        contributions: result.contributions.map(labelledContribution),
      });
    },
  );
  addUrl(
    context
      .command('summary')
      .requiredOption('--project <projectId>')
      .requiredOption('--agent <agentId>'),
  ).action(async (options: UrlOptions & { project: string; agent: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/context/summary',
        contextSummarySchema,
        undefined,
        { projectId: options.project, agentId: options.agent },
      ),
    ),
  );

  const git = program.command('git').description('Inspect read-only local Git observations');
  addUrl(git.command('scan').requiredOption('--project <projectId>')).action(
    async (options: ProjectOptions) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(options.project)}/git/scan`,
          gitObservationSchema,
          mutation(),
        ),
      ),
  );
  addUrl(git.command('status').requiredOption('--project <projectId>')).action(
    async (options: ProjectOptions) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(options.project)}/git`,
          gitObservationSchema,
        ),
      ),
  );
  addUrl(
    git
      .command('commits')
      .requiredOption('--project <projectId>')
      .option('--limit <count>', 'Maximum commits', '100'),
  ).action(async (options: ProjectOptions & { limit: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/projects/${id(options.project)}/git/commits`,
        gitCommitCollectionSchema,
        undefined,
        { limit: options.limit },
      ),
    ),
  );
  addUrl(git.command('worktrees').requiredOption('--project <projectId>')).action(
    async (options: ProjectOptions) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(options.project)}/git/worktrees`,
          gitWorktreeCollectionSchema,
        ),
      ),
  );
  addUrl(
    git
      .command('attributions')
      .requiredOption('--project <projectId>')
      .option('--limit <count>', 'Maximum attributions', '100'),
  ).action(async (options: ProjectOptions & { limit: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/projects/${id(options.project)}/git/attributions`,
        attributionCollectionSchema,
        undefined,
        { limit: options.limit },
      ),
    ),
  );

  const packages = program.command('package').description('Inspect declared package inventory');
  addUrl(packages.command('scan').requiredOption('--project <projectId>')).action(
    async (options: ProjectOptions) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(options.project)}/packages/scan`,
          packageScanResponseSchema,
          mutation(),
        ),
      ),
  );
  addUrl(
    packages
      .command('list')
      .requiredOption('--project <projectId>')
      .option('--limit <count>', 'Maximum packages', '100'),
  ).action(async (options: ProjectOptions & { limit: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/projects/${id(options.project)}/packages`,
        packageCollectionSchema,
        undefined,
        { limit: options.limit },
      ),
    ),
  );
  const technologies = program
    .command('technology')
    .description('Inspect evidence-backed technology inventory');
  addUrl(
    technologies
      .command('list')
      .requiredOption('--project <projectId>')
      .option('--limit <count>', 'Maximum technologies', '100'),
  ).action(async (options: ProjectOptions & { limit: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/projects/${id(options.project)}/technologies`,
        technologyCollectionSchema,
        undefined,
        { limit: options.limit },
      ),
    ),
  );

  const graph = program.command('graph').description('Query the bounded operational graph');
  addUrl(graph.command('node <kind> <nodeId>')).action(
    async (kind: string, nodeId: string, options: UrlOptions) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/graph/nodes/${id(kind)}/${id(nodeId)}`,
          graphNodeSchema,
        ),
      ),
  );
  addUrl(
    graph
      .command('neighbors <kind> <nodeId>')
      .requiredOption('--direction <direction>', 'out or in')
      .option('--edge-kind <kind>')
      .option('--project <projectId>')
      .option('--limit <count>', 'Maximum neighbors', '100'),
  ).action(
    async (
      kind: string,
      nodeId: string,
      options: UrlOptions & {
        direction: string;
        edgeKind?: string;
        project?: string;
        limit: string;
      },
    ) => {
      if (options.direction !== 'out' && options.direction !== 'in') {
        throw new ApplicationError('CLI_OPTION_INVALID', '--direction must be out or in.', 400);
      }
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/graph/nodes/${id(kind)}/${id(nodeId)}/${options.direction}`,
          graphNeighborsResponseSchema,
          undefined,
          { edgeKind: options.edgeKind, projectId: options.project, limit: options.limit },
        ),
      );
    },
  );
  addUrl(
    graph
      .command('path <fromKind> <fromId> <toKind> <toId>')
      .option('--project <projectId>')
      .option('--edge-kind <kind>')
      .option('--max-depth <count>', 'Maximum traversal depth', '3'),
  ).action(
    async (
      fromKind: string,
      fromId: string,
      toKind: string,
      toId: string,
      options: UrlOptions & { project?: string; edgeKind?: string; maxDepth: string },
    ) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          '/api/v1/graph/path',
          graphPathResponseSchema,
          undefined,
          {
            fromKind,
            fromId,
            toKind,
            toId,
            projectId: options.project,
            edgeKind: options.edgeKind,
            maxDepth: options.maxDepth,
          },
        ),
      ),
  );
  addUrl(
    graph
      .command('subgraph <kind> <nodeId>')
      .option('--project <projectId>')
      .option('--max-depth <count>', 'Maximum traversal depth', '2')
      .option('--node-limit <count>', 'Maximum nodes', '250'),
  ).action(
    async (
      kind: string,
      nodeId: string,
      options: UrlOptions & { project?: string; maxDepth: string; nodeLimit: string },
    ) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          '/api/v1/graph/subgraph',
          graphSubgraphResponseSchema,
          undefined,
          {
            nodeKind: kind,
            nodeId,
            projectId: options.project,
            maxDepth: options.maxDepth,
            nodeLimit: options.nodeLimit,
          },
        ),
      ),
  );
  addUrl(graph.command('rebuild')).action(async (options: UrlOptions) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/graph/rebuild',
        graphRebuildOperationSchema,
        mutation(),
      ),
    ),
  );
  addUrl(graph.command('rebuild-status <operationId>')).action(
    async (operationId: string, options: UrlOptions) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/graph/rebuild/${id(operationId)}`,
          graphRebuildOperationSchema,
        ),
      ),
  );

  const optimize = program
    .command('optimize')
    .description('Analyze and stage structural context optimizations');
  addUrl(
    optimize
      .command('analyze')
      .requiredOption('--project <projectId>')
      .option('--agent <agentId>')
      .option('--minimum-sessions <count>'),
  ).action(
    async (options: UrlOptions & { project: string; agent?: string; minimumSessions?: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          '/api/v1/optimization/analyze',
          optimizationAnalysisResponseSchema,
          mutation({
            projectId: options.project,
            ...(options.agent === undefined ? {} : { agentId: options.agent }),
            ...(options.minimumSessions === undefined
              ? {}
              : { minimumSessions: Number(options.minimumSessions) }),
          }),
        ),
      ),
  );
  addUrl(
    optimize
      .command('findings')
      .option('--project <projectId>')
      .option('--limit <count>', 'Maximum findings', '100'),
  ).action(async (options: UrlOptions & { project?: string; limit: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/optimization/findings',
        optimizationFindingCollectionSchema,
        undefined,
        { projectId: options.project, limit: options.limit },
      ),
    ),
  );
  addUrl(
    optimize
      .command('proposals')
      .option('--project <projectId>')
      .option('--limit <count>', 'Maximum proposals', '100'),
  ).action(async (options: UrlOptions & { project?: string; limit: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/optimization/proposals',
        optimizationProposalCollectionSchema,
        undefined,
        { projectId: options.project, limit: options.limit },
      ),
    ),
  );
  addUrl(optimize.command('proposal <proposalId>')).action(
    async (proposalId: string, options: UrlOptions) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/optimization/proposals/${id(proposalId)}`,
          optimizationProposalSchema,
        ),
      ),
  );
  addUrl(optimize.command('accept <proposalId>')).action(
    async (proposalId: string, options: UrlOptions) => {
      const proposal = await request(
        dependencies,
        options.url,
        `/api/v1/optimization/proposals/${id(proposalId)}/accept`,
        optimizationProposalSchema,
        mutation({ accepted: true }),
      );
      print(dependencies, { ...proposal, configurationApplied: false });
    },
  );
  addUrl(optimize.command('reject <proposalId>').option('--reason <text>')).action(
    async (proposalId: string, options: UrlOptions & { reason?: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/optimization/proposals/${id(proposalId)}/reject`,
          optimizationProposalSchema,
          mutation(options.reason === undefined ? {} : { reason: options.reason }),
        ),
      ),
  );
  addUrl(
    optimize
      .command('create-plan <proposalId>')
      .option('--action-index <index>', 'Proposed action index', '0'),
  ).action(async (proposalId: string, options: UrlOptions & { actionIndex: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/optimization/proposals/${id(proposalId)}/create-config-plan`,
        optimizationConfigPlanResponseSchema,
        mutation({ actionIndex: Number(options.actionIndex) }),
      ),
    ),
  );
  addUrl(
    optimize
      .command('evaluate <proposalId>')
      .option('--minimum-post-sessions <count>')
      .option('--minimum-observation-hours <hours>'),
  ).action(
    async (
      proposalId: string,
      options: UrlOptions & {
        minimumPostSessions?: string;
        minimumObservationHours?: string;
      },
    ) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/optimization/proposals/${id(proposalId)}/evaluate`,
          optimizationEvaluationSchema,
          mutation({
            ...(options.minimumPostSessions === undefined
              ? {}
              : { minimumPostSessions: Number(options.minimumPostSessions) }),
            ...(options.minimumObservationHours === undefined
              ? {}
              : { minimumObservationHours: Number(options.minimumObservationHours) }),
          }),
        ),
      ),
  );
}
