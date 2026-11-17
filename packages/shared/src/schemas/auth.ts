import { z } from 'zod';
import { CategorySchema, RoleSchema } from '../enums';
import { LIMITS } from '../limits';
import { IdSchema, safeString } from './common';

export const LoginRequestSchema = z.object({
  email: safeString().pipe(z.string().trim().toLowerCase().max(LIMITS.emailMax).pipe(z.email())),
  password: safeString().pipe(z.string().min(1).max(LIMITS.passwordMax)),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const MeSchema = z.object({
  id: IdSchema,
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
  categories: z.array(CategorySchema),
});
export type Me = z.infer<typeof MeSchema>;

export const StaffMemberSchema = z.object({
  id: IdSchema,
  name: z.string(),
  role: RoleSchema,
  categories: z.array(CategorySchema),
});
export type StaffMember = z.infer<typeof StaffMemberSchema>;
