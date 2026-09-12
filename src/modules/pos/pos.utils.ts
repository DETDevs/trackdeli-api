import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Resolves the target businessId for POS endpoints.
 * - SUPERADMIN can pass ?businessId=xxx to view any business.
 * - If user has their own businessId (ENCARGADO or SUPERADMIN with assigned store), uses it.
 * - If SUPERADMIN has no assigned store and omits ?businessId=xxx, throws BadRequestException (never null).
 * - If ENCARGADO has no assigned store, throws ForbiddenException (never null).
 */
export function resolveBusinessId(user: JwtPayload, queryBusinessId?: string): string {
  if (user.role === UserRole.SUPERADMIN && queryBusinessId) {
    return queryBusinessId;
  }

  const businessId = user.businessId || (user.role === UserRole.SUPERADMIN ? queryBusinessId : undefined);

  if (!businessId) {
    if (user.role === UserRole.SUPERADMIN) {
      throw new BadRequestException(
        'Debe especificar el parámetro ?businessId=xxx para consultar este recurso POS como SuperAdmin.',
      );
    }
    throw new ForbiddenException('Usuario sin negocio asignado para operar en el módulo POS.');
  }

  return businessId;
}

