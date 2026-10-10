import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductType, BusinessProductStatus, UserRole } from '@prisma/client';
import { SKIP_WEB_ADMIN_ACCESS_KEY } from '../decorators/skip-web-admin-access.decorator';

@Injectable()
export class WebAdminAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 167a: Verificar si el handler o la clase tiene el decorador @SkipWebAdminAccess()
    const skipCheck = this.reflector.getAllAndOverride<boolean>(
      SKIP_WEB_ADMIN_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skipCheck) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const user = req.user;

    // 167a: El acceso web admin solo restringe al backoffice (CAJERO y ENCARGADO).
    // No aplica a peticiones sin usuario, ni a WAITER (comandero/mesero), REPARTIDOR (DeliTrack) ni SUPERADMIN.
    if (
      !user ||
      (user.role !== UserRole.CAJERO && user.role !== UserRole.ENCARGADO)
    ) {
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
    // Tampoco las rutas operativas de comandero/salón (/pos/tables)
    if (
      normalizedPath === '/pos/web-billing/status' ||
      normalizedPath.startsWith('/pos/tables')
    ) {
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
