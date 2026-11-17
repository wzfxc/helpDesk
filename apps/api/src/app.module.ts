import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { AppConfig } from './config.js';
import { ConfigModule } from './config.module.js';
import { CommonModule } from './common/common.module.js';
import { ApiErrorFilter } from './common/error.filter.js';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';
import { CoreModule } from './core.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({})
export class AppModule {
  static forRoot(overrides: Partial<AppConfig> = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(overrides),
        CommonModule,
        DbModule,
        CoreModule,
        AuthModule,
        TicketsModule,
        AttachmentsModule,
        JobsModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
    };
  }
}
