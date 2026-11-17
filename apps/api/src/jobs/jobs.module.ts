import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { JobHandlers } from './handlers.js';
import { JobQueue } from './job-queue.js';
import { TestHooksController } from './test-hooks.controller.js';
import { JobWorker } from './worker.js';

@Module({
  imports: [AttachmentsModule],
  controllers: [TestHooksController],
  providers: [JobQueue, JobHandlers, JobWorker],
  exports: [JobQueue, JobHandlers, JobWorker],
})
export class JobsModule {}
