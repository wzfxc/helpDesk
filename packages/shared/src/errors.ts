import { z } from 'zod';

export const ERROR_CODES = [
  'validation_error',
  'invalid_json',
  'invalid_cursor',
  'bad_request',
  'unauthorized',
  'invalid_credentials',
  'forbidden',
  'not_found',
  'version_conflict',
  'invalid_transition',
  'ticket_closed',
  'payload_too_large',
  'unsupported_media_type',
  'too_many_attachments',
  'attachment_unavailable',
  'no_tickets_available',
  'rate_limited',
  'internal_error',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const FieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.array(FieldErrorSchema).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
