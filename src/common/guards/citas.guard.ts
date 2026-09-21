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
export class CitasGuard implements CanActivate {
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

    if (user.role === UserRole.REPARTIDOR) {
      throw new ForbiddenException(
        'Acceso denegado - el módulo de Citas no está disponible para repartidores',
      );
    }

    // Resolver businessId desde usuario o parámetros
    let businessId: string | undefined = user.businessId;

    if (user.role === UserRole.SUPERADMIN) {
      if (request.query?.businessId) {
        businessId = request.query.businessId as string;
      } else if (request.params?.businessId) {
        businessId = request.params.businessId as string;
      } else if (request.params?.id && request.route?.path?.includes('/businesses/:id/')) {
        businessId = request.params.id as string;
      }
    }

    if (!businessId && request.params?.id) {
      if (request.route?.path?.includes('/businesses/:id/')) {
        businessId = request.params.id;
      } else if (request.route?.path?.includes('/appointments/:id/')) {
        const appointment = await this.prisma.appointment.findUnique({
          where: { id: request.params.id },
          select: { businessId: true },
        });
        if (appointment) {
          businessId = appointment.businessId;
        }
      } else if (request.route?.path?.includes('/booking/services/:id')) {
        const service = await this.prisma.bookingService.findUnique({
          where: { id: request.params.id },
          select: { businessId: true },
        });
        if (service) {
          businessId = service.businessId;
        }
      }
    }

    if (!businessId) {
      if (user.role === UserRole.SUPERADMIN) {
        return true;
      }
      throw new ForbiddenException('Sin negocio asociado');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { isActive: true },
    });

    if (!business?.isActive) {
      throw new ForbiddenException('Negocio inactivo');
    }

    const isCitasActive = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.CITAS,
    );

    if (!isCitasActive) {
      throw new ForbiddenException(
        'El módulo de Citas no está contratado ni activo para este negocio',
      );
    }

    return true;
  }
}
