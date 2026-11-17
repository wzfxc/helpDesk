import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ErrorCode } from '@helpdesk/shared';
import { ApiError } from './errors.js';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'version_conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'invalid_transition',
  429: 'rate_limited',
};

/** Maps any thrown value to the unified error body. */
export function toApiError(exception: unknown): ApiError {
  if (exception instanceof ApiError) return exception;
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status < 500) {
      return new ApiError(status, STATUS_CODES[status] ?? 'bad_request', exception.message);
    }
  }
  // body-parser / busboy style errors carry a client status
  if (typeof exception === 'object' && exception !== null && 'status' in exception) {
    const status = Number(exception.status);
    const type = (exception as { type?: unknown }).type;
    if (status === 400 && type === 'entity.parse.failed') {
      return new ApiError(400, 'invalid_json', 'Malformed JSON body');
    }
    if (status === 413) return new ApiError(413, 'payload_too_large', 'Request body too large');
    if (status >= 400 && status < 500) {
      return new ApiError(status, STATUS_CODES[status] ?? 'bad_request', 'Bad request');
    }
  }
  return new ApiError(500, 'internal_error', 'Internal server error');
}

export function sendApiError(res: Response, error: ApiError): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error.headers) {
    for (const [k, v] of Object.entries(error.headers)) res.setHeader(k, v);
  }
  res.status(error.getStatus()).json(error.toBody());
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();
    const error = toApiError(exception);
    if (error.getStatus() >= 500) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    }
    sendApiError(res, error);
  }
}
