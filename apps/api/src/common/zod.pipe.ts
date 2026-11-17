import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validationError } from './errors.js';

/** Validates and transforms input with a shared Zod schema; failures become 400 validation_error. */
@Injectable()
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) throw validationError(result.error);
    return result.data;
  }
}

export const zod = <S extends z.ZodType>(schema: S) => new ZodPipe(schema);
