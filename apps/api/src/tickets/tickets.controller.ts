import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateMessageResponseSchema,
  CreateMessageSchema,
  CreateTicketSchema,
  type CreateMessage,
  type CreateMessageResponse,
  IdSchema,
  BulkRequestSchema,
  BulkResponseSchema,
  type BulkRequest,
  type BulkResponse,
  TicketListQuerySchema,
  TicketListResponseSchema,
  type TicketListQuery,
  type TicketListResponse,
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
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/openapi.js';
import { zod } from '../common/zod.pipe.js';
import { MessagesService } from './messages.service.js';
import { QueueService } from './queue.service.js';
import { TicketsService } from './tickets.service.js';

@ApiTags('tickets')
@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly messages: MessagesService,
    private readonly queue: QueueService,
  ) {}

  /** Assigns the most urgent free ticket of the caller's categories (404 no_tickets_available). */
  @Post('take-next')
  @Roles('agent', 'lead')
  @HttpCode(200)
  @ApiZodResponse(200, TicketSchema)
  takeNext(@CurrentUser() user: AuthUser): Promise<Ticket> {
    return this.queue.takeNext(user);
  }

  /** Up to 200 tickets; per-ticket result with skip reasons. */
  @Post('bulk')
  @Roles('agent', 'lead')
  @HttpCode(200)
  @ApiZodBody(BulkRequestSchema)
  @ApiZodResponse(200, BulkResponseSchema)
  bulk(
    @CurrentUser() user: AuthUser,
    @Body(zod(BulkRequestSchema)) body: BulkRequest,
  ): Promise<BulkResponse> {
    return this.queue.bulk(user, body);
  }

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

  @Get()
  @ApiZodQuery(TicketListQuerySchema)
  @ApiZodResponse(200, TicketListResponseSchema)
  list(
    @CurrentUser() user: AuthUser,
    @Query(zod(TicketListQuerySchema)) query: TicketListQuery,
  ): Promise<TicketListResponse> {
    return this.tickets.list(user, query);
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
