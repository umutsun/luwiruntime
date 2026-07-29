export class ApplicationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, string | number | boolean | null> | undefined;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: Record<string, string | number | boolean | null>,
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export type PublicError = {
  statusCode: number;
  body: {
    error: {
      code: string;
      message: string;
      details?: Record<string, string | number | boolean | null>;
    };
  };
};

export function toPublicError(error: unknown): PublicError {
  if (error instanceof ApplicationError) {
    return {
      statusCode: error.statusCode,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
      },
    },
  };
}
