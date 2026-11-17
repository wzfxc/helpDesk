import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { LIMITS } from '@helpdesk/shared';
import { sendApiError, toApiError } from './common/error.filter.js';

export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

/** Shared between main.ts and integration tests so both run the exact same pipeline. */
export function configureApp(app: INestApplication, trustProxy = DEFAULT_TRUST_PROXY): void {
  const http = app.getHttpAdapter().getInstance() as express.Express;
  // Behind the Next.js proxy: honour X-Forwarded-For only from trusted (private network) hops,
  // so a direct client cannot spoof its IP to dodge per-IP login limits.
  http.set('trust proxy', trustProxy);
  http.disable('x-powered-by');

  // Every JSON / urlencoded endpoint is capped at 256 KB (413 payload_too_large); only the
  // multipart POST /attachments may carry up to 10 MiB and is not touched by these parsers.
  const json = express.json({ limit: LIMITS.jsonBodyMaxBytes });
  const urlencoded = express.urlencoded({ extended: false, limit: LIMITS.jsonBodyMaxBytes });
  // Body parser errors (malformed JSON, too large) never reach Nest filters: convert them here.
  app.use((req: Request, res: Response, next: NextFunction) => {
    json(req, res, (err?: unknown) => {
      if (err) {
        sendApiError(res, toApiError(err));
        return;
      }
      urlencoded(req, res, (err2?: unknown) => {
        if (err2) {
          sendApiError(res, toApiError(err2));
          return;
        }
        next();
      });
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
