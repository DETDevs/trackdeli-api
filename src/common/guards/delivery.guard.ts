import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductType, UserRole } from '@prisma/client';
import { BusinessProductsService } from '../../modules/business-products/business-products.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class DeliveryGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('No autenticado');
    }

    if (user.role === UserRole.SUPERADMIN) {
      return true;
    }

    // Los repartidores operan en base a pedidos asignados o independientes
    if (user.role === UserRole.REPARTIDOR) {
      return true;
    }

    // Para roles de negocio (ENCARGADO, CAJERO)
    const businessId = user.businessId;
    if (!businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { isActive: true },
    });

    if (!business?.isActive) {
      throw new ForbiddenException('Negocio inactivo');
    }

    const isDeliveryActive = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.DELIVERY,
    );

    if (!isDeliveryActive) {
      throw new ForbiddenException(
        'El servicio de Delivery no está activo para este negocio. Contactá a TrackDeli.',
      );
    }

    return true;
  }
}
