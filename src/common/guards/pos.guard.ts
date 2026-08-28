import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';

@Injectable()
export class PosGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('No autenticado');
    }

    // REPARTIDOR nunca tiene acceso al POS
    if (user.role === UserRole.REPARTIDOR) {
      throw new ForbiddenException('Acceso denegado — el módulo POS no está disponible para repartidores');
    }

    // SUPERADMIN siempre tiene acceso (puede pasar ?businessId=xxx en la query)
    if (user.role === UserRole.SUPERADMIN) {
      return true;
    }

    // ENCARGADO: verificar que su negocio tiene POS activo
    if (!user.businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: user.businessId },
      select: { hasPOS: true, isActive: true },
    });

    if (!business?.isActive) {
      throw new ForbiddenException('Negocio inactivo');
    }

    if (!business?.hasPOS) {
      throw new ForbiddenException(
        'El módulo POS no está activo para este negocio. Contactá a TrackDeli.',
      );
    }

    return true;
  }
}
