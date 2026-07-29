export interface BackgroundWorkTracker {
  run(operation: () => Promise<unknown>, onError: (error: unknown) => void): boolean;
  stop(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

export async function waitForCompletion(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) {
    void operation.catch(() => undefined);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    void operation.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      },
    );
  });
}

export async function closeWithinDeadline(
  close: () => Promise<unknown>,
  forceClose: () => void,
  timeoutMs: number,
  forceWaitMs = 100,
): Promise<boolean> {
  const closing = close();
  if (await waitForCompletion(closing, timeoutMs)) {
    return true;
  }

  forceClose();
  await waitForCompletion(closing, forceWaitMs);
  return false;
}

export function createBackgroundWorkTracker(): BackgroundWorkTracker {
  const active = new Set<Promise<void>>();
  let accepting = true;

  return {
    run(operation, onError) {
      if (!accepting) {
        return false;
      }

      let work: Promise<unknown>;
      try {
        work = operation();
      } catch (error) {
        onError(error);
        return true;
      }
      const tracked = work
        .catch((error: unknown) => onError(error))
        .then(() => undefined)
        .finally(() => active.delete(tracked));
      active.add(tracked);
      return true;
    },

    stop() {
      accepting = false;
    },

    async waitForIdle(timeoutMs) {
      if (active.size === 0) {
        return true;
      }
      return waitForCompletion(Promise.allSettled([...active]), timeoutMs);
    },
  };
}
