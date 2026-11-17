import { Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IdSchema } from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { notFound } from '../common/errors.js';
import { zod } from '../common/zod.pipe.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { EventsService } from './events.service.js';

@ApiTags('events')
@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly realtime: RealtimeService,
    private readonly tickets: TicketsService,
  ) {}

  /**
   * Server-sent events: message.created, ticket.created, ticket.updated,
   * notification.created, typing. Cookie-authenticated, heartbeat comments every 20 s.
   * No replay buffer: after a reconnect clients refetch (Last-Event-ID is not honoured).
   */
  @Get('events')
  stream(@CurrentUser() user: AuthUser, @Res() res: Response): void {
    this.events.subscribe(user, res);
  }

  /** Extension: "X is replying" signal for other staff on the same ticket. */
  @Post('tickets/:id/typing')
  @Roles('agent', 'lead')
  @HttpCode(204)
  async typing(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
  ): Promise<void> {
    if (!(await this.tickets.canAccess(user, id))) throw notFound('Ticket not found');
    await this.realtime.emit({
      type: 'typing',
      ticketId: id,
      userId: user.id,
      userName: user.name,
    });
  }
}
