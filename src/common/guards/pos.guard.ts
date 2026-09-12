import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductType, UserRole } from '@prisma/client';
import { BusinessProductsService } from '../../modules/business-products/business-products.service';

@Injectable()
export class PosGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('No autenticado');
    }

    if (user.role === UserRole.REPARTIDOR) {
      throw new ForbiddenException('Acceso denegado - el modulo POS no esta disponible para repartidores');
    }

    if (user.role === UserRole.SUPERADMIN) {
      return true;
    }

    if (!user.businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: user.businessId },
      select: { isActive: true },
    });

    if (!business?.isActive) {
      throw new ForbiddenException('Negocio inactivo');
    }

    const isPosActive = await this.businessProductsService.isActive(
      user.businessId,
      BusinessProductType.POS,
    );

    if (!isPosActive) {
      throw new ForbiddenException(
        'El modulo POS no esta activo para este negocio. Contacta a TrackDeli.',
      );
    }

    return true;
  }
}

