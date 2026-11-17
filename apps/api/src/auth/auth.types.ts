import type { Request } from 'express';
import type { Category, Role } from '@helpdesk/shared';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  categories: Category[];
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  sessionTokenHash?: string;
}

export const SESSION_COOKIE = 'hd_session';
