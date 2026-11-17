import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateMessageResponseSchema,
  CreateMessageSchema,
  CreateTicketSchema,
  type CreateMessage,
  type CreateMessageResponse,
  IdSchema,
  RatingInputSchema,
  TicketDetailSchema,
  TicketSchema,
  UpdateTicketSchema,
  VersionConflictSchema,
  type CreateTicket,
  type RatingInput,
  type Ticket,
  type TicketDetail,
  type UpdateTicket,
} from '@helpdesk/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { ApiZodBody, ApiZodResponse } from '../common/openapi.js';
import { zod } from '../common/zod.pipe.js';
import { MessagesService } from './messages.service.js';
import { TicketsService } from './tickets.service.js';

@ApiTags('tickets')
@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly messages: MessagesService,
  ) {}

  @Post()
  @Roles('customer')
  @ApiZodBody(CreateTicketSchema)
  @ApiZodResponse(201, TicketSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(zod(CreateTicketSchema)) body: CreateTicket,
  ): Promise<Ticket> {
    return this.tickets.create(user, body);
  }

  @Get(':id')
  @ApiZodResponse(200, TicketDetailSchema)
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
  ): Promise<TicketDetail> {
    return this.tickets.detail(user, id);
  }

  @Patch(':id')
  @Roles('agent', 'lead')
  @ApiZodBody(UpdateTicketSchema)
  @ApiZodResponse(200, TicketSchema)
  @ApiZodResponse(409, VersionConflictSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
    @Body(zod(UpdateTicketSchema)) body: UpdateTicket,
  ): Promise<Ticket> {
    return this.tickets.update(user, id, body);
  }

  /** Public reply or internal note; idempotent on clientMessageId. */
  @Post(':id/messages')
  @ApiZodBody(CreateMessageSchema)
  @ApiZodResponse(201, CreateMessageResponseSchema)
  createMessage(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
    @Body(zod(CreateMessageSchema)) body: CreateMessage,
  ): Promise<CreateMessageResponse> {
    return this.messages.create(user, id, body);
  }

  /** Customer: "Problem solved" (extension). */
  @Post(':id/resolve')
  @Roles('customer')
  @HttpCode(200)
  @ApiZodResponse(200, TicketSchema)
  resolve(@CurrentUser() user: AuthUser, @Param('id', zod(IdSchema)) id: string): Promise<Ticket> {
    return this.tickets.resolveByCustomer(user, id);
  }

  /** Customer: 1–5 rating with optional comment after resolution (extension). */
  @Post(':id/rating')
  @Roles('customer')
  @HttpCode(200)
  @ApiZodBody(RatingInputSchema)
  @ApiZodResponse(200, TicketSchema)
  rate(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
    @Body(zod(RatingInputSchema)) body: RatingInput,
  ): Promise<Ticket> {
    return this.tickets.rate(user, id, body);
  }

  /** Marks the ticket as read for the current user (drives "unread" highlighting). */
  @Post(':id/read')
  @HttpCode(204)
  async read(@CurrentUser() user: AuthUser, @Param('id', zod(IdSchema)) id: string): Promise<void> {
    await this.tickets.markRead(user, id);
  }
}
