import type { z } from 'zod';

export type ResourceResult<T> =
  | {
      state: 'ready';
      data: T;
      httpStatus: number;
      receivedAt: string;
    }
  | {
      state: 'unavailable';
      reason: 'transport' | 'http' | 'invalid';
      httpStatus?: number;
    };

export type GetOptions = {
  acceptValidatedErrorBody?: boolean;
  signal?: AbortSignal;
};

export function createDaemonClient(fetchImpl: typeof fetch = fetch) {
  return {
    async get<T>(
      path: string,
      schema: z.ZodType<T>,
      options: GetOptions = {},
    ): Promise<ResourceResult<T>> {
      let response: Response;
      try {
        response = await fetchImpl(path, {
          headers: { accept: 'application/json' },
          method: 'GET',
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch {
        return { state: 'unavailable', reason: 'transport' };
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return {
          state: 'unavailable',
          reason: 'invalid',
          httpStatus: response.status,
        };
      }

      if (!response.ok && options.acceptValidatedErrorBody !== true) {
        return { state: 'unavailable', reason: 'http', httpStatus: response.status };
      }

      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        return {
          state: 'unavailable',
          reason: 'invalid',
          httpStatus: response.status,
        };
      }

      return {
        state: 'ready',
        data: parsed.data,
        httpStatus: response.status,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
