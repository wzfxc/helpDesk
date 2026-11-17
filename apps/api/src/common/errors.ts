import { HttpException } from '@nestjs/common';
import type { ApiErrorBody, ErrorCode, FieldError } from '@helpdesk/shared';
import type { z } from 'zod';

/** The only exception type business code throws; rendered as `{ error: { code, message, details? } }`. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: FieldError[],
    /** Extra top-level fields merged into the body (e.g. `current` for 409). */
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message, status);
  }

  toBody(): ApiErrorBody & Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
      ...this.extra,
    };
  }
}

export const badRequest = (message: string, code: ErrorCode = 'bad_request') =>
  new ApiError(400, code, message);
export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const invalidTransition = (message: string) =>
  new ApiError(422, 'invalid_transition', message);
export const ticketClosed = () =>
  new ApiError(422, 'ticket_closed', 'Closed tickets cannot be changed');

export function zodDetails(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

export const validationError = (error: z.ZodError) =>
  new ApiError(400, 'validation_error', 'Validation failed', zodDetails(error));
