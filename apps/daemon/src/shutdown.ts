import type { DaemonApp } from './app.js';

export type ShutdownSignal = 'SIGINT' | 'SIGTERM';
export type ShutdownSignalListener = () => Promise<void>;

export interface SignalSource {
  once(signal: ShutdownSignal, listener: ShutdownSignalListener): unknown;
  off(signal: ShutdownSignal, listener: ShutdownSignalListener): unknown;
}

export type GracefulShutdownController = {
  shutdown: (signal: ShutdownSignal) => Promise<void>;
  dispose: () => void;
};

const processSignalSource: SignalSource = {
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

export function installGracefulShutdown(
  app: DaemonApp,
  signals: SignalSource = processSignalSource,
  shutdownAction: () => Promise<void> = () => app.close(),
): GracefulShutdownController {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    if (shutdownPromise === undefined) {
      app.log.info({ signal }, 'Graceful shutdown requested');
      shutdownPromise = shutdownAction();
    }

    await shutdownPromise;
  };

  const onSigint = (): Promise<void> => shutdown('SIGINT');
  const onSigterm = (): Promise<void> => shutdown('SIGTERM');

  signals.once('SIGINT', onSigint);
  signals.once('SIGTERM', onSigterm);

  return {
    shutdown,
    dispose: () => {
      signals.off('SIGINT', onSigint);
      signals.off('SIGTERM', onSigterm);
    },
  };
}
