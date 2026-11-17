import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime/realtime.service.js';
import { SlaService } from './sla/sla.service.js';
import { TicketMutations } from './tickets/ticket-mutations.js';

/** Domain services shared by tickets, messages, bulk actions and background jobs. */
@Global()
@Module({
  providers: [RealtimeService, SlaService, TicketMutations],
  exports: [RealtimeService, SlaService, TicketMutations],
})
export class CoreModule {}
