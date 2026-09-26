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
        (method === 'GET' && normalizedPath === '/pos/products') ||
        (method === 'GET' && normalizedPath === '/pos/categories') ||
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

