import {
  createRuntimeEvent,
  LUWI_RUNTIME_VERSION,
  type RuntimeEvent,
  type RuntimeEventDependencies,
} from '@luwi/protocol';

export type RuntimeLifecyclePhase = 'started' | 'stopping';

export type RuntimeLifecycleContext = {
  workspaceId: string;
};

const eventTypeByPhase = {
  started: 'runtime.started',
  stopping: 'runtime.stopping',
} as const;

export function createRuntimeLifecycleEvent(
  phase: RuntimeLifecyclePhase,
  context: RuntimeLifecycleContext,
  dependencies?: RuntimeEventDependencies,
): RuntimeEvent {
  return createRuntimeEvent(
    {
      type: eventTypeByPhase[phase],
      workspaceId: context.workspaceId,
      payload: {
        runtimeVersion: LUWI_RUNTIME_VERSION,
      },
    },
    dependencies,
  );
}
