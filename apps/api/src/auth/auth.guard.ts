import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@helpdesk/shared';
import { forbidden, unauthorized } from '../common/errors.js';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE, type AuthedRequest } from './auth.types.js';
import { IS_PUBLIC, ROLES } from './decorators.js';

export function readSessionCookie(req: AuthedRequest): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 && value.length < 200 ? value : undefined;
}

/** Global guard: every route needs a valid session unless marked @Public(); @Roles() narrows further. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = readSessionCookie(req);
    const user = token ? await this.auth.userForToken(token) : null;
    if (!user) throw unauthorized();
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(user.role)) throw forbidden();
    return true;
  }
}
