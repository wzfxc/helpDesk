import { z } from 'zod';
import { ALLOWED_MIME_TYPES } from '../limits';
import { IdSchema } from './common';

export const AttachmentSchema = z.object({
  id: IdSchema,
  filename: z.string(),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
