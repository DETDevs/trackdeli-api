import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BusinessProductType, UserRole } from '@prisma/client';
import { BusinessProductsService } from '../../business-products/business-products.service';

@Injectable()
export class BackofficeGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'NOT_AUTHENTICATED',
        message: 'No autenticado',
      });
    }

    if (user.role !== UserRole.ENCARGADO && user.role !== UserRole.SUPERADMIN) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'ACCESS_DENIED',
        message: 'Acceso denegado: solo el propietario o administrador del negocio puede consultar el backoffice',
      });
    }

    const businessId = user.role === UserRole.SUPERADMIN
      ? (request.query?.businessId || user.businessId)
      : user.businessId;

    if (!businessId) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'NO_BUSINESS',
        message: 'Sin negocio asociado',
      });
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { isActive: true },
    });

    if (!business?.isActive) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'BUSINESS_INACTIVE',
        message: 'Negocio inactivo',
      });
    }

    const isPosActive = await this.businessProductsService.isActive(
      businessId,
      BusinessProductType.POS,
    );

    if (!isPosActive) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MODULE_NOT_ENABLED',
        message: 'El módulo POS no está habilitado para este negocio',
      });
    }

    if (user.role !== UserRole.SUPERADMIN) {
      const posSub = await this.prisma.businessProductSubscription.findUnique({
        where: {
          businessId_productType: {
            businessId,
            productType: BusinessProductType.POS,
          },
        },
        select: {
          trialHours: true,
          trialStartedAt: true,
          trialEndsAt: true,
        },
      });

      if (posSub?.trialEndsAt && new Date() >= posSub.trialEndsAt) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'TRIAL_EXPIRED',
          message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
        });
      }
    }

    return true;
  }
}
