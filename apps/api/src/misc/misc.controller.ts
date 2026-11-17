import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CannedResponseSchema,
  CreateSavedViewSchema,
  IdSchema,
  MarkNotificationsReadSchema,
  NotificationListSchema,
  SavedViewSchema,
  SlaPolicySchema,
  StatsQuerySchema,
  StatsSchema,
  UpdateSlaPoliciesSchema,
  UpsertCannedResponseSchema,
  type CannedResponse,
  type CreateSavedView,
  type MarkNotificationsRead,
  type NotificationList,
  type SavedView,
  type SlaPolicy,
  type Stats,
  type StatsQuery,
  type UpdateSlaPolicies,
  type UpsertCannedResponse,
} from '@helpdesk/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from '../common/openapi.js';
import { zod } from '../common/zod.pipe.js';
import { MiscService } from './misc.service.js';

const NotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly misc: MiscService) {}

  @Get()
  @ApiZodQuery(NotificationsQuerySchema)
  @ApiZodResponse(200, NotificationListSchema)
  list(
    @CurrentUser() user: AuthUser,
    @Query(zod(NotificationsQuerySchema)) q: z.infer<typeof NotificationsQuerySchema>,
  ): Promise<NotificationList> {
    return this.misc.notifications(user, q.limit);
  }

  @Post('read')
  @HttpCode(200)
  @ApiZodBody(MarkNotificationsReadSchema)
  @ApiZodResponse(200, NotificationListSchema)
  read(
    @CurrentUser() user: AuthUser,
    @Body(zod(MarkNotificationsReadSchema)) body: MarkNotificationsRead,
  ): Promise<NotificationList> {
    return this.misc.markRead(user, body);
  }
}

@ApiTags('canned-responses')
@Controller('canned-responses')
export class CannedResponsesController {
  constructor(private readonly misc: MiscService) {}

  @Get()
  @Roles('agent', 'lead')
  @ApiZodResponse(200, CannedResponseSchema.array())
  list(): Promise<CannedResponse[]> {
    return this.misc.listCanned();
  }

  @Post()
  @Roles('lead')
  @ApiZodBody(UpsertCannedResponseSchema)
  @ApiZodResponse(201, CannedResponseSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(zod(UpsertCannedResponseSchema)) body: UpsertCannedResponse,
  ): Promise<CannedResponse> {
    return this.misc.createCanned(user, body);
  }

  @Put(':id')
  @Roles('lead')
  @ApiZodBody(UpsertCannedResponseSchema)
  @ApiZodResponse(200, CannedResponseSchema)
  update(
    @Param('id', zod(IdSchema)) id: string,
    @Body(zod(UpsertCannedResponseSchema)) body: UpsertCannedResponse,
  ): Promise<CannedResponse> {
    return this.misc.updateCanned(id, body);
  }

  @Delete(':id')
  @Roles('lead')
  @HttpCode(204)
  async remove(@Param('id', zod(IdSchema)) id: string): Promise<void> {
    await this.misc.deleteCanned(id);
  }
}

@ApiTags('views')
@Controller('views')
export class ViewsController {
  constructor(private readonly misc: MiscService) {}

  /** Built-in views followed by the caller's own saved views (extension). */
  @Get()
  @Roles('agent', 'lead')
  @ApiZodResponse(200, SavedViewSchema.array())
  list(@CurrentUser() user: AuthUser): Promise<SavedView[]> {
    return this.misc.listViews(user);
  }

  @Post()
  @Roles('agent', 'lead')
  @ApiZodBody(CreateSavedViewSchema)
  @ApiZodResponse(201, SavedViewSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(zod(CreateSavedViewSchema)) body: CreateSavedView,
  ): Promise<SavedView> {
    return this.misc.createView(user, body);
  }

  @Delete(':id')
  @Roles('agent', 'lead')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', zod(IdSchema)) id: string,
  ): Promise<void> {
    await this.misc.deleteView(user, id);
  }
}

@ApiTags('sla')
@Controller('sla-policies')
export class SlaPoliciesController {
  constructor(private readonly misc: MiscService) {}

  @Get()
  @Roles('agent', 'lead')
  @ApiZodResponse(200, SlaPolicySchema.array())
  list(): Promise<SlaPolicy[]> {
    return this.misc.policies();
  }

  /** Lead only. Affects new tickets and tickets whose priority changes later. */
  @Put()
  @Roles('lead')
  @ApiZodBody(UpdateSlaPoliciesSchema)
  @ApiZodResponse(200, SlaPolicySchema.array())
  update(
    @CurrentUser() user: AuthUser,
    @Body(zod(UpdateSlaPoliciesSchema)) body: UpdateSlaPolicies,
  ): Promise<SlaPolicy[]> {
    return this.misc.updatePolicies(user, body);
  }
}

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly misc: MiscService) {}

  @Get()
  @Roles('lead')
  @ApiZodQuery(StatsQuerySchema)
  @ApiZodResponse(200, StatsSchema)
  stats(@Query(zod(StatsQuerySchema)) q: StatsQuery): Promise<Stats> {
    return this.misc.stats(new Date(q.from), new Date(q.to));
  }
}
