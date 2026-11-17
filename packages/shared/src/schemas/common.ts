import { z } from 'zod';
import { LIMITS } from '../limits';

export const IdSchema = z.uuid();
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Base string: PostgreSQL text cannot store U+0000 (it would surface as a 500),
 * so every user-supplied string rejects it with a 400 validation_error.
 */
export const safeString = () =>
  z.string().refine((s) => !s.includes('\u0000'), 'Must not contain NUL characters');

/** Trimmed, non-empty string with an upper bound. */
export const text = (max: number, min = 1) =>
  safeString().pipe(z.string().trim().min(min).max(max));

export const TagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(LIMITS.tagMax)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Invalid tag');

export const TagsSchema = z
  .array(TagSchema)
  .max(LIMITS.tagsPerTicket)
  .transform((tags) => [...new Set(tags)]);

/**
 * Query-string list: accepts `a,b` or repeated `?x=a&x=b`.
 */
export const queryList = <T extends z.ZodType>(item: T, max = 20) =>
  z.preprocess((value: unknown): unknown => {
    if (value === undefined || value === '') return undefined;
    const raw: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
    return raw
      .flatMap((v): unknown[] => (typeof v === 'string' ? v.split(',') : [v]))
      .map((v): unknown => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== '');
  }, z.array(item).max(max).optional());

export const queryBoolean = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const UserRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
});
export type UserRef = z.infer<typeof UserRefSchema>;
