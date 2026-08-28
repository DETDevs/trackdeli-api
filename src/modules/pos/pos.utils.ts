import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';

/**
 * Resolves the target businessId for POS endpoints.
 * - SUPERADMIN can pass ?businessId=xxx to view any business
 * - ENCARGADO always uses their own businessId
 */
export function resolveBusinessId(user: JwtPayload, queryBusinessId?: string): string {
  if (user.role === UserRole.SUPERADMIN && queryBusinessId) {
    return queryBusinessId;
  }
  return user.businessId;
}
