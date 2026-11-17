import { Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IdSchema, LIMITS } from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { notFound } from '../common/errors.js';
import { RateLimiter } from '../common/rate-limiter.js';
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
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Server-sent events: message.created, ticket.created, ticket.updated,
   * notification.created, typing. Cookie-authenticated, heartbeat comments every 20 s.
   * Replays missed non-typing events after Last-Event-ID from the in-memory ring buffer,
   * still filtered through per-user permission queries.
   */
  @Get('events')
  stream(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Headers('last-event-id') lastEventIdHeader?: string,
  ): void {
    const raw = lastEventIdHeader?.trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    const lastEventId = parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
    this.events.subscribe(user, res, lastEventId);
  }

  /** Extension: "X is replying" signal for other staff on the same ticket. */
  @Post('tickets/:id/typing')
  @Roles('agent', 'lead')
  @HttpCode(204)
  async typing(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
  ): Promise<void> {
    this.limiter.check('typing', `${user.id}:${id}`, LIMITS.rate.typing);
    if (!(await this.tickets.canAccess(user, id))) throw notFound('Ticket not found');
    await this.realtime.emit({
      type: 'typing',
      ticketId: id,
      userId: user.id,
      userName: user.name,
    });
  }
}
