import { UserRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;        // userId
  email: string;
  role: UserRole;
  businessId: string;
  iat?: number;
  exp?: number;
}
