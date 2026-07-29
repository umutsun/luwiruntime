import { LUWI_PROTOCOL_VERSION, LUWI_RUNTIME_VERSION } from '@luwi/protocol';

export type RuntimeState = {
  version: typeof LUWI_RUNTIME_VERSION;
  protocolVersion: typeof LUWI_PROTOCOL_VERSION;
  workspaceId: string;
  startedAt: string;
};

export type CreateRuntimeStateInput = {
  workspaceId: string;
  startedAt: Date;
};

export function createRuntimeState(input: CreateRuntimeStateInput): RuntimeState {
  return {
    version: LUWI_RUNTIME_VERSION,
    protocolVersion: LUWI_PROTOCOL_VERSION,
    workspaceId: input.workspaceId,
    startedAt: input.startedAt.toISOString(),
  };
}

export function getRuntimeUptimeMs(state: RuntimeState, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(state.startedAt));
}
