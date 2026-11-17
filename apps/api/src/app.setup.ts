import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { sendApiError, toApiError } from './common/error.filter.js';

const JSON_LIMIT = '1mb';

/** Shared between main.ts and integration tests so both run the exact same pipeline. */
export function configureApp(app: INestApplication): void {
  const http = app.getHttpAdapter().getInstance() as express.Express;
  // Behind the Next.js proxy: use X-Forwarded-For for the client IP (login rate limiting).
  http.set('trust proxy', true);
  http.disable('x-powered-by');

  const json = express.json({ limit: JSON_LIMIT });
  // Body parser errors (malformed JSON, too large) never reach Nest filters: convert them here.
  app.use((req: Request, res: Response, next: NextFunction) => {
    json(req, res, (err?: unknown) => {
      if (err) {
        sendApiError(res, toApiError(err));
        return;
      }
      next();
    });
  });
  app.use(cookieParser());

  const config = new DocumentBuilder()
    .setTitle('Helpdesk API')
    .setDescription(
      'Session cookie auth (POST /auth/login). Errors: { error: { code, message, details? } }.',
    )
    .setVersion('1.0')
    .addCookieAuth('hd_session')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config));
}
