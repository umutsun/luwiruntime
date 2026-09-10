import type { AgentKind, BridgeExecutionProfile, BridgeProvider } from '@luwi/protocol';

/**
 * The wake supervisor: one foreground process that owns zero or more bridge
 * workers, one per enabled project-agent binding whose effective configuration
 * carries a strict `settings.luwiNativeBridge` leaf.
 *
 * Supervision adds no second message-execution path. A worker is the same
 * slot-owning bridge the operator's `session bridge native` runs; the
 * supervisor only decides which tuples get one, and what to do when a worker
 * stands down: a `held` slot belongs to another supervisor, a `lost` slot was
 * taken while this one ran, and both mean wait and try again rather than spin.
 */

export type WakeCandidate = {
  projectId: string;
  agentId: string;
  agentKind: AgentKind;
  provider: BridgeProvider;
  executionProfile: BridgeExecutionProfile;
  /** The registered project root the worker is confined to. */
  localPath: string;
  executable?: string;
};

export type WakeWorkerOutcome = 'held' | 'stopped' | 'lost';

export interface WakeWorker {
  start(): Promise<WakeWorkerOutcome>;
  stop(): void;
}

export type WakeSupervisorOptions = {
  discover(signal?: AbortSignal): Promise<WakeCandidate[]>;
  createWorker(candidate: WakeCandidate): WakeWorker;
  /** How long a held or lost tuple waits before a fresh worker tries again. */
  standbyMs: number;
  /** How often bindings are rediscovered. */
  rescanMs: number;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
  setInterval?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  report?: (line: object) => void;
};

export interface WakeSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Tuples with a worker loop, whether owning or standing by. */
  readonly active: number;
}

function keyOf(candidate: WakeCandidate): string {
  return `${candidate.projectId}\u0000${candidate.agentId}`;
}

function sameCandidate(left: WakeCandidate, right: WakeCandidate): boolean {
  return (
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.agentKind === right.agentKind &&
    left.provider === right.provider &&
    left.executionProfile === right.executionProfile &&
    left.localPath === right.localPath &&
    left.executable === right.executable
  );
}

export function createWakeSupervisor(options: WakeSupervisorOptions): WakeSupervisor {
  const arm = options.setInterval ?? setInterval;
  const disarm = options.clearInterval ?? clearInterval;
  const report = options.report ?? (() => undefined);

  type Loop = {
    candidate: WakeCandidate;
    worker: WakeWorker | undefined;
    standbyController: AbortController | undefined;
    done: Promise<void>;
  };
  const loops = new Map<string, Loop>();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let scanInFlight: Promise<void> | undefined;
  let discoveryController: AbortController | undefined;

  const runLoop = async (key: string, candidate: WakeCandidate): Promise<void> => {
    const loop = loops.get(key);
    while (!stopping && loops.get(key) === loop && loop !== undefined) {
      const worker = options.createWorker(candidate);
      loop.worker = worker;
      let outcome: WakeWorkerOutcome;
      try {
        outcome = await worker.start();
      } catch (error) {
        // A worker that threw (daemon unreachable, binding unresolved) is a
        // standby too; the failure is reported, not fatal to the supervisor.
        report({ event: 'worker_failed', ...identity(candidate), cause: String(error) });
        outcome = 'lost';
      }
      loop.worker = undefined;
      report({ event: `worker_${outcome}`, ...identity(candidate) });
      if (stopping || loops.get(key) !== loop) break;
      const standbyController = new AbortController();
      loop.standbyController = standbyController;
      try {
        await options.wait(options.standbyMs, standbyController.signal);
      } catch (error) {
        if (!standbyController.signal.aborted) throw error;
      } finally {
        if (loop.standbyController === standbyController) loop.standbyController = undefined;
      }
    }
  };

  const performReconcile = async (): Promise<void> => {
    let candidates: WakeCandidate[];
    const controller = new AbortController();
    discoveryController = controller;
    try {
      candidates = await options.discover(controller.signal);
    } catch (error) {
      if (stopping && controller.signal.aborted) return;
      report({ event: 'discovery_failed', cause: String(error) });
      return;
    } finally {
      if (discoveryController === controller) discoveryController = undefined;
    }
    if (stopping) return;
    const wanted = new Map(candidates.map((candidate) => [keyOf(candidate), candidate]));
    const retired: Loop[] = [];
    for (const [key, loop] of loops) {
      const replacement = wanted.get(key);
      if (replacement !== undefined && sameCandidate(loop.candidate, replacement)) continue;
      loops.delete(key);
      retired.push(loop);
      loop.standbyController?.abort();
      loop.worker?.stop();
      report({
        event: replacement === undefined ? 'binding_removed' : 'binding_changed',
        ...identity(loop.candidate),
      });
    }
    await Promise.all(retired.map((loop) => loop.done));
    if (stopping) return;
    for (const [key, candidate] of wanted) {
      if (loops.has(key)) continue;
      const loop: Loop = {
        candidate,
        worker: undefined,
        standbyController: undefined,
        done: Promise.resolve(),
      };
      loops.set(key, loop);
      loop.done = runLoop(key, candidate);
      report({ event: 'binding_added', ...identity(candidate) });
    }
  };

  const reconcile = (): Promise<void> => {
    if (stopping) return Promise.resolve();
    if (scanInFlight !== undefined) return scanInFlight;
    const operation = performReconcile().finally(() => {
      if (scanInFlight === operation) scanInFlight = undefined;
    });
    scanInFlight = operation;
    return operation;
  };

  return {
    get active() {
      return loops.size;
    },

    async start() {
      stopping = false;
      await reconcile();
      if (stopping) return;
      timer = arm(() => {
        void reconcile();
      }, options.rescanMs);
    },

    async stop() {
      stopping = true;
      discoveryController?.abort();
      if (timer !== undefined) {
        disarm(timer);
        timer = undefined;
      }
      await scanInFlight;
      const pending = [...loops.values()];
      loops.clear();
      for (const loop of pending) {
        loop.standbyController?.abort();
        loop.worker?.stop();
      }
      await Promise.all(pending.map((loop) => loop.done));
    },
  };
}

function identity(candidate: WakeCandidate): {
  projectId: string;
  agentId: string;
  provider: BridgeProvider;
} {
  return {
    projectId: candidate.projectId,
    agentId: candidate.agentId,
    provider: candidate.provider,
  };
}
