import { Module } from '@nestjs/common';
import {
  CannedResponsesController,
  NotificationsController,
  SlaPoliciesController,
  StatsController,
  ViewsController,
} from './misc.controller.js';
import { MiscService } from './misc.service.js';

@Module({
  controllers: [
    NotificationsController,
    CannedResponsesController,
    ViewsController,
    SlaPoliciesController,
    StatsController,
  ],
  providers: [MiscService],
  exports: [MiscService],
})
export class MiscModule {}
