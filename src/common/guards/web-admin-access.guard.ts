import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductType, BusinessProductStatus, UserRole } from '@prisma/client';

@Injectable()
export class WebAdminAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;

    // No aplica a peticiones sin usuario ni a SUPERADMIN
    if (!user || user.role === UserRole.SUPERADMIN) {
      return true;
    }

    const rawPlatform =
      req.headers['x-client-platform'] || req.headers['X-Client-Platform'];
    if (!rawPlatform) {
      return true;
    }

    const platform = rawPlatform.toString().toLowerCase();
    if (!platform.startsWith('web')) {
      return true;
    }

    const rawPath =
      req.path ||
      req.originalUrl?.split('?')[0] ||
      req.url?.split('?')[0] ||
      '';
    const normalizedPath =
      rawPath.replace(/^\/api\/v1/, '').replace(/\/$/, '') || '/';

    // GET /pos/web-billing/status no debe bloquearse por webAdminEnabled = false
    if (normalizedPath === '/pos/web-billing/status') {
      return true;
    }

    // Solo aplica a rutas POS (incluyendo /backoffice)
    const isPosRoute =
      normalizedPath.startsWith('/pos') ||
      normalizedPath.startsWith('/backoffice');
    if (!isPosRoute) {
      return true;
    }

    const businessId = user.businessId || req.query?.businessId;
    if (!businessId) {
      return true;
    }

    const posSub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId,
          productType: BusinessProductType.POS,
        },
      },
      select: {
        status: true,
        webAdminEnabled: true,
      },
    });

    // Negocios sin suscripción POS activa no se ven afectados por esta regla POS
    if (!posSub || posSub.status !== BusinessProductStatus.ACTIVE) {
      return true;
    }

    if (posSub.webAdminEnabled === false) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'WEB_ACCESS_DISABLED',
        message: 'El acceso a la web de administración está deshabilitado para este negocio',
      });
    }

    return true;
  }
}
