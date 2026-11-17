import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { LIMITS, type ErrorCode } from '@helpdesk/shared';
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

/** SQLSTATE of a pg error, also when wrapped by drizzle (`cause`). */
function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; typeof e === 'object' && e !== null && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Maps any thrown value to the unified error body. */
export function toApiError(exception: unknown): ApiError {
  if (exception instanceof ApiError) return exception;
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 413) {
      // only multer's LIMIT_FILE_SIZE (the attachment upload) is raised as an HttpException
      return new ApiError(
        413,
        'payload_too_large',
        `File is larger than ${LIMITS.attachmentMaxMb.toString()} MB`,
      );
    }
    if (status < 500) {
      return new ApiError(status, STATUS_CODES[status] ?? 'bad_request', exception.message);
    }
  }
  // PostgreSQL "data exception" (SQLSTATE class 22: 22021 invalid byte sequence / NUL,
  // 22P05, 22P02, 22001 ...) is caused by client input that slipped past validation: 400.
  const pgCode = pgErrorCode(exception);
  if (pgCode?.startsWith('22')) {
    return new ApiError(400, 'validation_error', 'Request contains invalid characters or values');
  }
  // Server-side guards: statement_timeout (57014) or no free pooled connection in time.
  if (
    pgCode === '57014' ||
    (exception instanceof Error &&
      /timeout exceeded when trying to connect/.test(exception.message))
  ) {
    return new ApiError(
      503,
      'service_unavailable',
      'The service is busy, try again shortly',
      undefined,
      undefined,
      { 'Retry-After': '2' },
    );
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
