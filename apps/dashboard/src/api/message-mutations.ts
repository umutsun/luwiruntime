import {
  messageCreateRequestSchema,
  messageCreateResponseSchema,
  publicErrorResponseSchema,
} from '@luwi/protocol/browser';

export type AskMessageInput = {
  sourceSessionId: string;
  targetSessionId: string;
  subject?: string;
  content: string;
  timeoutMs: number;
  idempotencyKey: string;
};

export type AskMessageReceipt = {
  correlationId: string;
  targetSessionId: string;
  idempotent: boolean;
};

export type AskMessageResult =
  | { state: 'ok'; data: AskMessageReceipt; httpStatus: number }
  | {
      state: 'failed';
      reason: 'input' | 'http';
      code: string;
      message: string;
      httpStatus?: number;
    }
  | { state: 'failed'; reason: 'transport' }
  | { state: 'failed'; reason: 'invalid'; httpStatus: number };

function validIdempotencyKey(value: string): boolean {
  return (
    value.trim() === value &&
    value.length >= 1 &&
    value.length <= 128 &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f);
    })
  );
}

export function createMessageMutations(fetchImpl: typeof fetch = fetch) {
  return {
    async ask(input: AskMessageInput): Promise<AskMessageResult> {
      let request: ReturnType<typeof messageCreateRequestSchema.safeParse>;
      try {
        request = messageCreateRequestSchema.safeParse({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          kind: 'question',
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          content: input.content,
          evidenceRequirements: [],
          timeoutMs: input.timeoutMs,
        });
      } catch {
        request = { success: false } as ReturnType<typeof messageCreateRequestSchema.safeParse>;
      }
      if (!request.success || !validIdempotencyKey(input.idempotencyKey)) {
        return {
          state: 'failed',
          reason: 'input',
          code: 'REQUEST_VALIDATION_FAILED',
          message: 'The request fields do not match the bounded message protocol.',
        };
      }

      let response: Response;
      try {
        response = await fetchImpl('/api/v1/messages', {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': input.idempotencyKey,
          },
          body: JSON.stringify(request.data),
        });
      } catch {
        return { state: 'failed', reason: 'transport' };
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return { state: 'failed', reason: 'invalid', httpStatus: response.status };
      }
      if (!response.ok) {
        const error = publicErrorResponseSchema.safeParse(value);
        return error.success
          ? {
              state: 'failed',
              reason: 'http',
              httpStatus: response.status,
              code: error.data.error.code,
              message: error.data.error.message,
            }
          : { state: 'failed', reason: 'invalid', httpStatus: response.status };
      }

      let parsed: ReturnType<typeof messageCreateResponseSchema.safeParse>;
      try {
        parsed = messageCreateResponseSchema.safeParse(value);
      } catch {
        return { state: 'failed', reason: 'invalid', httpStatus: response.status };
      }
      return parsed.success
        ? {
            state: 'ok',
            httpStatus: response.status,
            data: {
              correlationId: parsed.data.message.correlationId,
              targetSessionId: parsed.data.selectedTargetSessionId,
              idempotent: parsed.data.idempotent,
            },
          }
        : { state: 'failed', reason: 'invalid', httpStatus: response.status };
    },
  };
}

export type MessageMutations = ReturnType<typeof createMessageMutations>;
