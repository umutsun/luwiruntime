import { describe, expect, it, vi } from 'vitest';

import {
  createWakeSupervisor,
  type WakeCandidate,
  type WakeWorker,
  type WakeWorkerOutcome,
} from './wake-supervisor.js';

const codex: WakeCandidate = {
  projectId: 'project-1',
  agentId: 'codex',
  agentKind: 'codex',
  provider: 'codex',
  executionProfile: 'workspace-write',
  localPath: 'C:/work/app',
  executable: 'C:/tools/codex.exe',
};
const claude: WakeCandidate = { ...codex, agentId: 'claude-code', provider: 'claude-code' };

/** A worker whose outcome the test decides, so start() resolves only when told. */
function controllableWorker() {
  let settle: ((outcome: WakeWorkerOutcome) => void) | undefined;
  const worker: WakeWorker & { finish(outcome: WakeWorkerOutcome): void; stopped: number } = {
    stopped: 0,
    start: () =>
      new Promise<WakeWorkerOutcome>((resolve) => {
        settle = resolve;
      }),
    stop: () => {
      worker.stopped += 1;
      settle?.('stopped');
    },
    finish: (outcome) => settle?.(outcome),
  };
  return worker;
}

function harness(candidates: WakeCandidate[][]) {
  const workers: Array<ReturnType<typeof controllableWorker> & { candidate: WakeCandidate }> = [];
  const timers: Array<() => void> = [];
  const waits: number[] = [];
  const lines: object[] = [];
  let scan = 0;
  const supervisor = createWakeSupervisor({
    discover: async () => candidates[Math.min(scan++, candidates.length - 1)] ?? [],
    createWorker: (candidate) => {
      const worker = Object.assign(controllableWorker(), { candidate });
      workers.push(worker);
      return worker;
    },
    standbyMs: 15_000,
    rescanMs: 60_000,
    wait: async (ms) => {
      waits.push(ms);
    },
    setInterval: ((callback: () => void) => {
      timers.push(callback);
      return timers.length as unknown as NodeJS.Timeout;
    }) as never,
    clearInterval: vi.fn() as never,
    report: (line) => lines.push(line),
  });
  return { supervisor, workers, timers, waits, lines };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('wake supervisor', () => {
  it('starts one worker per enabled binding and stops them all on stop', async () => {
    const { supervisor, workers } = harness([[codex, claude]]);

    await supervisor.start();
    await flush();
    expect(workers.map((worker) => worker.candidate.agentId)).toEqual(['codex', 'claude-code']);

    await supervisor.stop();

    expect(workers.every((worker) => worker.stopped === 1)).toBe(true);
  });

  /** A held slot means another supervisor owns it: stand by, then try again. */
  it('stands by after a held or lost worker and retries with a fresh worker', async () => {
    const { supervisor, workers, waits } = harness([[codex]]);
    await supervisor.start();
    await flush();

    workers[0]!.finish('held');
    await flush();
    expect(waits).toEqual([15_000]);
    expect(workers).toHaveLength(2);

    workers[1]!.finish('lost');
    await flush();
    expect(waits).toEqual([15_000, 15_000]);
    expect(workers).toHaveLength(3);

    await supervisor.stop();
  });

  it('rescans bindings, starting new ones and stopping ones that vanished', async () => {
    const { supervisor, workers, timers } = harness([[codex], [claude]]);
    await supervisor.start();
    await flush();
    expect(workers.map((worker) => worker.candidate.agentId)).toEqual(['codex']);

    timers[0]!();
    await flush();

    expect(workers[0]!.stopped).toBe(1);
    expect(workers.map((worker) => worker.candidate.agentId)).toEqual(['codex', 'claude-code']);
    // The stopped worker is not restarted: its binding is gone.
    await flush();
    expect(workers).toHaveLength(2);

    await supervisor.stop();
  });

  it('reports a discovery failure and keeps running until the next scan', async () => {
    const lines: object[] = [];
    const supervisor = createWakeSupervisor({
      discover: async () => {
        throw new Error('daemon unreachable');
      },
      createWorker: () => controllableWorker(),
      standbyMs: 1,
      rescanMs: 1,
      wait: async () => undefined,
      setInterval: (() => 1 as unknown as NodeJS.Timeout) as never,
      clearInterval: vi.fn() as never,
      report: (line) => lines.push(line),
    });

    await supervisor.start();

    expect(lines).toEqual([expect.objectContaining({ event: 'discovery_failed' })]);
    await supervisor.stop();
  });
});
