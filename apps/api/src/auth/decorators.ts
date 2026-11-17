import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@helpdesk/shared';
import type { AuthUser, AuthedRequest } from './auth.types.js';
import { unauthorized } from '../common/errors.js';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** Route does not require a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route is limited to the given roles (403 otherwise). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw unauthorized();
  return req.user;
});
