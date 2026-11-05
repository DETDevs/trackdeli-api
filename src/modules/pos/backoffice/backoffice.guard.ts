import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { resolveBusinessCoverage } from '../../superadmin/utils/membership-billing.util';
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
          webAdminEnabled: true,
        },
      });

      const coverage = await resolveBusinessCoverage(this.prisma, businessId);

      if (coverage.isCommercialBlocked) {
        throw new HttpException(
          {
            statusCode: 402,
            error: 'Payment Required',
            code: 'COMMERCIAL_PAYMENT_OVERDUE',
            message: 'Tenés una cuota vencida. Contactá a NEXOL para regularizar.',
          },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      if (posSub?.trialEndsAt && new Date() >= posSub.trialEndsAt) {
        if (!coverage.isCovered) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'TRIAL_EXPIRED',
            message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
          });
        }
      }

      const rawPlatform =
        request.headers['x-client-platform'] || request.headers['X-Client-Platform'];
      const platform = (rawPlatform || '').toString().toLowerCase();

      if (platform.startsWith('web') && posSub?.webAdminEnabled === false) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'WEB_ACCESS_DISABLED',
          message: 'El acceso a la web de administración está deshabilitado para este negocio',
        });
      }
    }

    return true;
  }
}
