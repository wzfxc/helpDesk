import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';

/** Converts a shared Zod schema into an OpenAPI schema object for Swagger. */
export function toOpenApi(schema: z.ZodType, io: 'input' | 'output' = 'output'): SchemaObject {
  const json = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete json.$schema;
  // JSON Schema and OpenAPI SchemaObject are structurally compatible for these schemas.
  return json;
}

export const ApiZodBody = (schema: z.ZodType) => ApiBody({ schema: toOpenApi(schema, 'input') });

export const ApiZodResponse = (status: number, schema: z.ZodType) =>
  ApiResponse({ status, schema: toOpenApi(schema, 'output') });

/** Documents each top-level property of an object schema as a query parameter. */
export function ApiZodQuery(schema: z.ZodObject) {
  const decorators = Object.keys(schema.shape).map((name) =>
    ApiQuery({ name, required: false, schema: { type: 'string' } }),
  );
  return applyDecorators(...decorators);
}
