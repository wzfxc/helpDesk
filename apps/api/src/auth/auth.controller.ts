import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { asc, inArray } from 'drizzle-orm';
import { LoginRequestSchema, type LoginRequest, type Me, type StaffMember } from '@helpdesk/shared';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { zod } from '../common/zod.pipe.js';
import { ApiZodBody, ApiZodResponse } from '../common/openapi.js';
import { DB, type Db } from '../db/db.js';
import { users } from '../db/schema.js';
import { MeSchema } from '@helpdesk/shared';
import { AuthService } from './auth.service.js';
import { readSessionCookie } from './auth.guard.js';
import { SESSION_COOKIE, type AuthUser, type AuthedRequest } from './auth.types.js';
import { CurrentUser, Public, Roles } from './decorators.js';

@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  @ApiZodBody(LoginRequestSchema)
  @ApiZodResponse(200, MeSchema)
  async login(
    @Body(zod(LoginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const { user, token } = await this.auth.login(body.email, body.password, ip);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.COOKIE_SECURE,
      path: '/',
      // Relative lifetime; the authoritative expiry is sessions.expires_at on the server.
      maxAge: this.config.SESSION_TTL_HOURS * 3_600_000,
    });
    return user;
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = readSessionCookie(req);
    if (token) await this.auth.logout(token);
    res.clearCookie(SESSION_COOKIE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.COOKIE_SECURE,
    });
  }

  @Get('me')
  @ApiZodResponse(200, MeSchema)
  me(@CurrentUser() user: AuthUser): Me {
    return user;
  }

  /** Staff directory for assignee pickers (extension). */
  @Get('users/staff')
  @Roles('agent', 'lead')
  async staff(): Promise<StaffMember[]> {
    return this.db
      .select({ id: users.id, name: users.name, role: users.role, categories: users.categories })
      .from(users)
      .where(inArray(users.role, ['agent', 'lead']))
      .orderBy(asc(users.name));
  }
}
