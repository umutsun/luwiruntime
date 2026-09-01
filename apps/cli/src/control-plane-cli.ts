import {
  agentDefinitionCollectionSchema,
  agentDefinitionSchema,
  agentDetectionResponseSchema,
  capabilityBindingSchema,
  capabilityCollectionSchema,
  capabilityPackageSchema,
  capabilityProfileCollectionSchema,
  capabilityProfileSchema,
  capabilityScanResponseSchema,
  configDriftCollectionSchema,
  configOperationReceiptSchema,
  configPlanApprovalResponseSchema,
  configPlanCollectionSchema,
  configPlanSchema,
  configReconcileResponseSchema,
  configSnapshotCollectionSchema,
  contextFootprintSchema,
  contextSourceCollectionSchema,
  effectiveAgentConfigurationSchema,
  nativeConfigInspectionSchema,
  projectAgentBindingCollectionSchema,
  projectAgentBindingSchema,
  publicErrorResponseSchema,
} from '@luwi/protocol';
import { ApplicationError } from '@luwi/runtime';
import type { Command } from 'commander';

type Parser<Output> = { parse(value: unknown): Output };

export type ControlPlaneCliDependencies = {
  fetch: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  stdout: { write(text: string): unknown };
  confirm(prompt: string): Promise<boolean>;
};

const DEFAULT_URL = 'http://127.0.0.1:4782';

function endpoint(base: string, path: string): string {
  return new URL(path, `${base.replace(/\/+$/, '')}/`).toString();
}

async function request<Output>(
  dependencies: ControlPlaneCliDependencies,
  base: string,
  path: string,
  parser: Parser<Output>,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Output> {
  const response = await dependencies.fetch(endpoint(base, path), init);
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

function mutation(method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  return {
    method,
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

function print(dependencies: ControlPlaneCliDependencies, value: unknown): void {
  dependencies.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function id(value: string): string {
  return encodeURIComponent(value);
}

function addUrl(command: Command): Command {
  return command.option('-u, --url <url>', 'LUWI daemon base URL', DEFAULT_URL);
}

export function registerControlPlaneCli(
  program: Command,
  projects: Command,
  dependencies: ControlPlaneCliDependencies,
): Command {
  const agents = program.command('agent').description('Manage coding-agent definitions');
  addUrl(agents.command('detect').option('--project <projectId>', 'Project context')).action(
    async (options: { project?: string; url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          '/api/v1/agents/detect',
          agentDetectionResponseSchema,
          mutation('POST', {
            ...(options.project === undefined ? {} : { projectId: options.project }),
          }),
        ),
      ),
  );
  addUrl(agents.command('list')).action(async (options: { url: string }) =>
    print(
      dependencies,
      await request(dependencies, options.url, '/api/v1/agents', agentDefinitionCollectionSchema),
    ),
  );
  addUrl(agents.command('get <agentId>')).action(
    async (agentId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/agents/${id(agentId)}`,
          agentDefinitionSchema,
        ),
      ),
  );
  addUrl(
    agents
      .command('register')
      .requiredOption('--body <json>', 'AgentDefinition create request JSON'),
  ).action(async (options: { body: string; url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/agents',
        agentDefinitionSchema,
        mutation('POST', parseObject(options.body)),
      ),
    ),
  );
  addUrl(
    agents.command('update <agentId>').requiredOption('--body <json>', 'Agent patch JSON'),
  ).action(async (agentId: string, options: { body: string; url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/agents/${id(agentId)}`,
        agentDefinitionSchema,
        mutation('PATCH', parseObject(options.body)),
      ),
    ),
  );
  addUrl(agents.command('disable <agentId>')).action(
    async (agentId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/agents/${id(agentId)}`,
          agentDefinitionSchema,
          mutation('PATCH', { enabled: false }),
        ),
      ),
  );

  const projectAgents = projects.command('agent').description('Manage project-agent bindings');
  addUrl(projectAgents.command('list <projectId>')).action(
    async (projectId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(projectId)}/agents`,
          projectAgentBindingCollectionSchema,
        ),
      ),
  );
  addUrl(
    projectAgents
      .command('bind <projectId>')
      .requiredOption('--body <json>', 'ProjectAgentBinding create request JSON'),
  ).action(async (projectId: string, options: { body: string; url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/projects/${id(projectId)}/agents`,
        projectAgentBindingSchema,
        mutation('POST', parseObject(options.body)),
      ),
    ),
  );
  addUrl(
    projectAgents
      .command('update <projectId> <bindingId>')
      .requiredOption('--body <json>', 'ProjectAgentBinding patch JSON'),
  ).action(async (projectId: string, bindingId: string, options: { body: string; url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/projects/${id(projectId)}/agents/${id(bindingId)}`,
        projectAgentBindingSchema,
        mutation('PATCH', parseObject(options.body)),
      ),
    ),
  );
  addUrl(projectAgents.command('unbind <projectId> <bindingId>')).action(
    async (projectId: string, bindingId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(projectId)}/agents/${id(bindingId)}`,
          projectAgentBindingSchema,
          mutation('DELETE'),
        ),
      ),
  );
  addUrl(projectAgents.command('effective <projectId> <agentId>')).action(
    async (projectId: string, agentId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(projectId)}/agents/${id(agentId)}/effective-config`,
          effectiveAgentConfigurationSchema,
        ),
      ),
  );

  const capabilities = program.command('capability').description('Manage capability packages');
  addUrl(capabilities.command('scan')).action(async (options: { url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/capabilities/scan',
        capabilityScanResponseSchema,
        mutation('POST', {}),
      ),
    ),
  );
  addUrl(
    capabilities
      .command('list')
      .option('--kind <kind>')
      .option('--scope <scope>')
      .option('--project <projectId>')
      .option('--agent <agentId>')
      .option('--enabled <boolean>')
      .option('--limit <number>'),
  ).action(
    async (options: {
      kind?: string;
      scope?: string;
      project?: string;
      agent?: string;
      enabled?: string;
      limit?: string;
      url: string;
    }) => {
      const query = new URLSearchParams();
      if (options.kind !== undefined) query.set('kind', options.kind);
      if (options.scope !== undefined) query.set('scope', options.scope);
      if (options.project !== undefined) query.set('projectId', options.project);
      if (options.agent !== undefined) query.set('agentId', options.agent);
      if (options.enabled !== undefined) query.set('enabled', options.enabled);
      if (options.limit !== undefined) query.set('limit', options.limit);
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/capabilities${query.size === 0 ? '' : `?${query.toString()}`}`,
          capabilityCollectionSchema,
        ),
      );
    },
  );
  addUrl(capabilities.command('get <capabilityId>')).action(
    async (capabilityId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/capabilities/${id(capabilityId)}`,
          capabilityPackageSchema,
        ),
      ),
  );
  for (const action of ['register', 'update'] as const) {
    const command =
      action === 'register'
        ? capabilities.command(action)
        : capabilities.command(`${action} <capabilityId>`);
    addUrl(command.requiredOption('--body <json>', 'Capability request JSON')).action(
      async (...arguments_: unknown[]) => {
        const options = arguments_.at(-2) as { body: string; url: string };
        const capabilityId = action === 'update' ? (arguments_[0] as string) : undefined;
        print(
          dependencies,
          await request(
            dependencies,
            options.url,
            capabilityId === undefined
              ? '/api/v1/capabilities'
              : `/api/v1/capabilities/${id(capabilityId)}`,
            capabilityPackageSchema,
            mutation(action === 'register' ? 'POST' : 'PATCH', parseObject(options.body)),
          ),
        );
      },
    );
  }
  for (const action of ['assign', 'unassign'] as const) {
    addUrl(
      capabilities
        .command(`${action} <capabilityId>`)
        .requiredOption('--body <json>', 'Capability assignment request JSON'),
    ).action(async (capabilityId: string, options: { body: string; url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/capabilities/${id(capabilityId)}/${action}`,
          capabilityBindingSchema,
          mutation('POST', parseObject(options.body)),
        ),
      ),
    );
  }
  for (const action of ['enable', 'disable'] as const) {
    addUrl(capabilities.command(`${action} <capabilityId>`)).action(
      async (capabilityId: string, options: { url: string }) =>
        print(
          dependencies,
          await request(
            dependencies,
            options.url,
            `/api/v1/capabilities/${id(capabilityId)}`,
            capabilityPackageSchema,
            mutation('PATCH', { enabled: action === 'enable' }),
          ),
        ),
    );
  }

  const profiles = program.command('profile').description('Manage named capability profiles');
  addUrl(profiles.command('list')).action(async (options: { url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/profiles',
        capabilityProfileCollectionSchema,
      ),
    ),
  );
  addUrl(profiles.command('get <profileId>')).action(
    async (profileId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/profiles/${id(profileId)}`,
          capabilityProfileSchema,
        ),
      ),
  );
  for (const action of ['create', 'update'] as const) {
    const command =
      action === 'create' ? profiles.command(action) : profiles.command(`${action} <profileId>`);
    addUrl(command.requiredOption('--body <json>', 'Profile request JSON')).action(
      async (...arguments_: unknown[]) => {
        const options = arguments_.at(-2) as { body: string; url: string };
        const profileId = action === 'update' ? (arguments_[0] as string) : undefined;
        print(
          dependencies,
          await request(
            dependencies,
            options.url,
            profileId === undefined ? '/api/v1/profiles' : `/api/v1/profiles/${id(profileId)}`,
            capabilityProfileSchema,
            mutation(action === 'create' ? 'POST' : 'PATCH', parseObject(options.body)),
          ),
        );
      },
    );
  }

  const config = program.command('config').description('Inspect and safely manage native config');
  const configCreateCommands: Array<{
    name: string;
    route: string;
    parser: Parser<unknown>;
  }> = [
    {
      name: 'inspect',
      route: '/api/v1/config/inspect',
      parser: nativeConfigInspectionSchema,
    },
    {
      name: 'import-plan',
      route: '/api/v1/config/import-plan',
      parser: configPlanSchema,
    },
    {
      name: 'render-plan',
      route: '/api/v1/config/render-plan',
      parser: configPlanSchema,
    },
  ];
  for (const { name, route, parser } of configCreateCommands) {
    addUrl(config.command(name).requiredOption('--body <json>', 'Validated request JSON')).action(
      async (options: { body: string; url: string }) =>
        print(
          dependencies,
          await request(
            dependencies,
            options.url,
            route,
            parser,
            mutation('POST', parseObject(options.body)),
          ),
        ),
    );
  }
  const plan = config.command('plan').description('Inspect and authorize config plans');
  addUrl(plan.command('list')).action(async (options: { url: string }) =>
    print(
      dependencies,
      await request(dependencies, options.url, '/api/v1/config/plans', configPlanCollectionSchema),
    ),
  );
  addUrl(plan.command('get <planId>')).action(async (planId: string, options: { url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/config/plans/${id(planId)}`,
        configPlanSchema,
      ),
    ),
  );
  addUrl(plan.command('approve <planId>')).action(
    async (planId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/config/plans/${id(planId)}/approve`,
          configPlanApprovalResponseSchema,
          mutation('POST', {}),
        ),
      ),
  );
  addUrl(
    plan
      .command('apply <planId>')
      .requiredOption('--approval-token <token>', 'One-time daemon approval token')
      .option('--yes', 'Confirm this approved plan without an interactive prompt', false),
  ).action(
    async (planId: string, options: { approvalToken: string; yes: boolean; url: string }) => {
      const confirmed =
        options.yes ||
        (await dependencies.confirm(
          `Apply approved config plan ${planId} with snapshot and precondition checks?`,
        ));
      if (!confirmed) {
        throw new ApplicationError(
          'CLI_CONFIRMATION_REQUIRED',
          'Config apply was cancelled because explicit confirmation was not provided.',
          400,
        );
      }
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/config/plans/${id(planId)}/apply`,
          configOperationReceiptSchema,
          mutation('POST', { approvalToken: options.approvalToken }),
        ),
      );
    },
  );
  const snapshot = config.command('snapshot').description('Inspect local config snapshots');
  addUrl(snapshot.command('list')).action(async (options: { url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/config/snapshots',
        configSnapshotCollectionSchema,
      ),
    ),
  );
  addUrl(config.command('rollback-plan <snapshotId>')).action(
    async (snapshotId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/config/snapshots/${id(snapshotId)}/rollback-plan`,
          configPlanSchema,
          mutation('POST', {}),
        ),
      ),
  );
  addUrl(config.command('drift').option('--scan', 'Run a fresh drift scan', false)).action(
    async (options: { scan: boolean; url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          options.scan ? '/api/v1/config/drift/scan' : '/api/v1/config/drift',
          configDriftCollectionSchema,
          options.scan ? mutation('POST', {}) : undefined,
        ),
      ),
  );
  addUrl(config.command('reconcile')).action(async (options: { url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/config/reconcile',
        configReconcileResponseSchema,
        mutation('POST', {}),
      ),
    ),
  );

  const context = program.command('context').description('Inspect static context footprint');
  addUrl(
    context.command('scan').requiredOption('--agent <agentId>').option('--project <projectId>'),
  ).action(async (options: { agent: string; project?: string; url: string }) =>
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        '/api/v1/context/scan',
        contextSourceCollectionSchema,
        mutation('POST', {
          agentId: options.agent,
          ...(options.project === undefined ? {} : { projectId: options.project }),
        }),
      ),
    ),
  );
  addUrl(
    context
      .command('sources')
      .option('--agent <agentId>')
      .option('--project <projectId>')
      .option('--limit <number>'),
  ).action(async (options: { agent?: string; project?: string; limit?: string; url: string }) => {
    const query = new URLSearchParams();
    if (options.agent !== undefined) query.set('agentId', options.agent);
    if (options.project !== undefined) query.set('projectId', options.project);
    if (options.limit !== undefined) query.set('limit', options.limit);
    print(
      dependencies,
      await request(
        dependencies,
        options.url,
        `/api/v1/context/sources${query.size === 0 ? '' : `?${query.toString()}`}`,
        contextSourceCollectionSchema,
      ),
    );
  });
  addUrl(context.command('footprint <projectId> <agentId>')).action(
    async (projectId: string, agentId: string, options: { url: string }) =>
      print(
        dependencies,
        await request(
          dependencies,
          options.url,
          `/api/v1/projects/${id(projectId)}/agents/${id(agentId)}/context-footprint`,
          contextFootprintSchema,
        ),
      ),
  );
  return agents;
}
