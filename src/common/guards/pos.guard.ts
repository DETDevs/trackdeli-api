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
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MODULE_NOT_ENABLED',
        message: 'El módulo POS no está habilitado para este negocio. Contacta a TrackDeli.',
      });
    }

    const posSub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId: user.businessId,
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

    if (posSub?.trialEndsAt && new Date() >= posSub.trialEndsAt) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'TRIAL_EXPIRED',
        message: 'La prueba de este negocio terminó. Contactá a NEXOL para continuar.',
      });
    }

    const rawPlatform =
      request.headers['x-client-platform'] || request.headers['X-Client-Platform'];
    const platform = (rawPlatform || '').toString().toLowerCase();

    // 166a / 167a: Restricción webAdminEnabled solo aplica a usuarios del backoffice/admin (CAJERO, ENCARGADO).
    // No aplica a WAITER (comandero), REPARTIDOR ni SUPERADMIN. Tampoco a rutas de comandero (/pos/tables).
    if (
      platform.startsWith('web') &&
      (user.role === UserRole.CAJERO || user.role === UserRole.ENCARGADO)
    ) {
      const rawPath =
        request.path ||
        request.originalUrl?.split('?')[0] ||
        request.url?.split('?')[0] ||
        '';
      const normalizedPath =
        rawPath.replace(/^\/api\/v1/, '').replace(/\/$/, '') || '/';

      if (
        normalizedPath !== '/pos/web-billing/status' &&
        !normalizedPath.startsWith('/pos/tables') &&
        posSub?.webAdminEnabled === false
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'WEB_ACCESS_DISABLED',
          message: 'El acceso a la web de administración está deshabilitado para este negocio',
        });
      }
    }

    if (user.role === UserRole.WAITER) {
      const rawPath =
        request.path ||
        (request.originalUrl ? request.originalUrl.split('?')[0] : (request.url ? request.url.split('?')[0] : ''));
      const normalizedPath = rawPath.replace(/^\/api\/v1/, '').replace(/\/$/, '') || '/';
      const method = (request.method || '').toUpperCase();

      const isAllowed =
        (method === 'GET' && normalizedPath === '/pos/tables/status') ||
        (method === 'GET' && /^\/pos\/tables\/[^/]+\/order$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/open-order$/.test(normalizedPath)) ||
        (method === 'POST' && normalizedPath === '/pos/tables/receive') ||
        (method === 'GET' && normalizedPath === '/pos/products') ||
        (method === 'GET' && normalizedPath === '/pos/categories') ||
        (method === 'GET' && (normalizedPath === '/pos/product-fields' || /^\/pos\/product-fields\/[^/]+$/.test(normalizedPath))) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/order\/items$/.test(normalizedPath)) ||
        (method === 'PATCH' && /^\/pos\/tables\/[^/]+\/order\/items\/[^/]+$/.test(normalizedPath)) ||
        (method === 'DELETE' && /^\/pos\/tables\/[^/]+\/order\/items\/[^/]+$/.test(normalizedPath));

      if (!isAllowed) {
        throw new ForbiddenException(
          'Acceso denegado: el rol WAITER no tiene permiso para este recurso',
        );
      }
    }

    return true;
  }
}

