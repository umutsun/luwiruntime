export { createCli, runCli } from './cli.js';
export type { CliDependencies, HttpResponseLike } from './cli.js';
export {
  createLifecycleService,
  createNodeLifecycleService,
  defaultLifecycleInstallationRoot,
  NodeLifecycleFileSystem,
} from './lifecycle.js';
export type {
  DoctorCheck,
  DoctorReport,
  LifecycleDependencies,
  LifecycleFileSystem,
  LifecycleService,
  LifecycleStatus,
  RuntimeResetResult,
  SetupResult,
} from './lifecycle.js';
// Discovery moved to @luwi/runtime so the daemon can share it; re-exported here
// so the CLI package's surface is unchanged.
export { createProjectDiscoveryService } from '@luwi/runtime';
export type {
  ProjectCandidate,
  ProjectDiscoveryEntry,
  ProjectDiscoveryFileSystem,
  ProjectDiscoveryPlan,
  ProjectDiscoveryService,
  ProjectDiscoveryServiceOptions,
} from '@luwi/runtime';
