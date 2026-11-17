import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller.js';
import { MessagesService } from './messages.service.js';
import { QueueService } from './queue.service.js';
import { TicketsService } from './tickets.service.js';

@Module({
  controllers: [TicketsController],
  providers: [TicketsService, MessagesService, QueueService],
  exports: [TicketsService],
})
export class TicketsModule {}
