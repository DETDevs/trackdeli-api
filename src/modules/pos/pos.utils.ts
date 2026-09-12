import { JwtPayload } from '../../common/types/jwt-payload.interface';
import { UserRole } from '@prisma/client';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

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

