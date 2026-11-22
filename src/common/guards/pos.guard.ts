import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { resolveBusinessCoverage } from '../../modules/superadmin/utils/membership-billing.util';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductType, PosDeviceStatus, UserRole } from '@prisma/client';
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

    const coverage = await resolveBusinessCoverage(this.prisma, user.businessId);

    if (coverage.isCommercialBlocked) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'COMMERCIAL_PAYMENT_OVERDUE',
          message: 'Tenés una cuota vencida. Contactá a NEXOL para regularizar.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    if (coverage.source && !coverage.isCovered) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'MEMBERSHIP_EXPIRED',
          message: 'Mantenimiento o membresía vencida. Contactá a NEXOL para regularizar.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
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
        maxMobileDevices: true,
      },
    });

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

    // 277a: Control y validación para peticiones desde app móvil (Android / iOS)
    if (platform.startsWith('mobile')) {
      const maxMobileDevices = (posSub as any)?.maxMobileDevices ?? 0;
      if (maxMobileDevices <= 0) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MOBILE_APP_NOT_ENABLED',
          message: 'La app móvil no está activa para este negocio. Contactá a NEXOL.',
        });
      }

      const deviceIdRaw =
        request.headers['x-device-id'] || request.headers['X-Device-Id'];
      const deviceSecretRaw =
        request.headers['x-device-secret'] || request.headers['X-Device-Secret'];
      const deviceId = deviceIdRaw ? String(deviceIdRaw).trim() : null;
      const deviceSecret = deviceSecretRaw ? String(deviceSecretRaw).trim() : null;

      if (!deviceId || !deviceSecret) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MOBILE_DEVICE_NOT_PAIRED',
          message:
            'Este teléfono no está vinculado a tu negocio. Pedile al encargado un código de vinculación.',
        });
      }

      const device = await this.prisma.posDevice.findFirst({
        where: {
          businessId: user.businessId,
          deviceId,
          category: 'MOBILE',
        },
      });

      if (!device || device.status !== PosDeviceStatus.ACTIVE) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MOBILE_DEVICE_NOT_PAIRED',
          message:
            'Este teléfono no está vinculado a tu negocio. Pedile al encargado un código de vinculación.',
        });
      }

      const secretHash = crypto
        .createHash('sha256')
        .update(deviceSecret)
        .digest('hex');

      if (!device.secretHash || secretHash !== device.secretHash) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MOBILE_DEVICE_NOT_PAIRED',
          message:
            'Este teléfono no está vinculado a tu negocio. Pedile al encargado un código de vinculación.',
        });
      }

      this.prisma.posDevice
        .update({
          where: { id: device.id },
          data: { lastSeenAt: new Date(), lastUserId: user.sub },
        })
        .catch(() => {});
    }

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
        (method === 'GET' && normalizedPath === '/pos/salon/zones') ||
        (method === 'GET' && normalizedPath === '/pos/units') ||
        (method === 'GET' && /^\/pos\/tables\/[^/]+\/order$/.test(normalizedPath)) ||
        (method === 'GET' && /^\/pos\/tables\/[^/]+\/order\/rounds$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/open-order$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/order\/send-to-kitchen$/.test(normalizedPath)) ||
        (method === 'POST' && normalizedPath === '/pos/tables/receive') ||
        (method === 'GET' && normalizedPath === '/pos/products') ||
        (method === 'GET' && /^\/pos\/products\/[^/]+\/presentations$/.test(normalizedPath)) ||
        (method === 'GET' && /^\/pos\/products\/[^/]+\/variants$/.test(normalizedPath)) ||
        (method === 'GET' && (normalizedPath === '/pos/promotions' || /^\/pos\/promotions\/[^/]+$/.test(normalizedPath))) ||
        (method === 'GET' && normalizedPath === '/pos/categories') ||
        (method === 'GET' && (normalizedPath === '/pos/product-fields' || /^\/pos\/product-fields\/[^/]+$/.test(normalizedPath))) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/order\/items$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/order\/items\/[^/]+\/void$/.test(normalizedPath)) ||
        (method === 'PATCH' && /^\/pos\/tables\/[^/]+\/order\/items\/[^/]+$/.test(normalizedPath)) ||
        (method === 'DELETE' && /^\/pos\/tables\/[^/]+\/order\/items\/[^/]+$/.test(normalizedPath)) ||
        (method === 'PATCH' && /^\/pos\/tables\/[^/]+\/order\/tip$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/order\/request-bill$/.test(normalizedPath)) ||
        (method === 'GET' && /^\/pos\/tables\/[^/]+\/order\/bills$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/order\/cancel-bill-request$/.test(normalizedPath)) ||
        (method === 'GET' && normalizedPath === '/pos/receipt-settings') ||
        (method === 'POST' && /^\/pos\/tables\/[^/]+\/order\/split\/(start|move|add-account|merge|undo)$/.test(normalizedPath));

      if (!isAllowed) {
        throw new ForbiddenException(
          'Acceso denegado: el rol WAITER no tiene permiso para este recurso',
        );
      }
    }

    if (user.role === UserRole.VENDEDOR) {
      const rawPath =
        request.path ||
        (request.originalUrl ? request.originalUrl.split('?')[0] : (request.url ? request.url.split('?')[0] : ''));
      const normalizedPath = rawPath.replace(/^\/api\/v1/, '').replace(/\/$/, '') || '/';
      const method = (request.method || '').toUpperCase();

      const isAllowed =
        (method === 'GET' && (normalizedPath === '/pos/products' || /^\/pos\/products\/.*$/.test(normalizedPath))) ||
        (method === 'GET' && normalizedPath === '/pos/units') ||
        (method === 'GET' && (normalizedPath === '/pos/promotions' || /^\/pos\/promotions\/[^/]+$/.test(normalizedPath))) ||
        (method === 'GET' && (normalizedPath === '/pos/categories' || normalizedPath === '/pos/categories/summary')) ||
        (method === 'GET' && (normalizedPath === '/pos/product-fields' || /^\/pos\/product-fields\/[^/]+$/.test(normalizedPath))) ||
        (method === 'GET' && (
          normalizedPath === '/customers' ||
          normalizedPath === '/pos/customers' ||
          normalizedPath === '/customers/search' ||
          normalizedPath === '/pos/customers/search' ||
          normalizedPath === '/customers/lookup' ||
          normalizedPath === '/pos/customers/lookup' ||
          normalizedPath === '/businesses/me/customers' ||
          normalizedPath === '/businesses/me/customers/search' ||
          normalizedPath === '/businesses/me/customers/lookup' ||
          /^\/customers\/[^/]+$/.test(normalizedPath) ||
          /^\/pos\/customers\/[^/]+$/.test(normalizedPath) ||
          /^\/businesses\/me\/customers\/[^/]+$/.test(normalizedPath)
        )) ||
        (method === 'POST' && (
          normalizedPath === '/customers' ||
          normalizedPath === '/pos/customers' ||
          normalizedPath === '/businesses/me/customers'
        )) ||
        (method === 'POST' && normalizedPath === '/pos/print-audit/events') ||
        (method === 'GET' && (normalizedPath === '/businesses/me/products' || /^\/businesses\/[^/]+\/products$/.test(normalizedPath))) ||
        (method === 'POST' && normalizedPath === '/pos/presale-tickets') ||
        (method === 'GET' && normalizedPath === '/pos/presale-tickets/mine') ||
        (method === 'GET' && /^\/pos\/presale-tickets\/by-code\/[^/]+$/.test(normalizedPath)) ||
        (method === 'GET' && /^\/pos\/presale-tickets\/[^/]+$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/presale-tickets\/[^/]+\/cancel$/.test(normalizedPath)) ||
        (method === 'POST' && normalizedPath === '/pos/quotes') ||
        (method === 'GET' && normalizedPath === '/pos/quotes') ||
        (method === 'GET' && /^\/pos\/quotes\/[^/]+$/.test(normalizedPath)) ||
        (method === 'PATCH' && /^\/pos\/quotes\/[^/]+$/.test(normalizedPath)) ||
        (method === 'PATCH' && /^\/pos\/quotes\/[^/]+\/status$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/quotes\/[^/]+\/duplicate$/.test(normalizedPath)) ||
        (method === 'POST' && /^\/pos\/quotes\/[^/]+\/receipt-link$/.test(normalizedPath)) ||
        (method === 'GET' && (normalizedPath === '/pos/reports/sales-by-seller' || normalizedPath === '/reports/sales-by-seller')) ||
        (method === 'POST' && normalizedPath === '/pos/devices/register');

      if (!isAllowed) {
        throw new ForbiddenException(
          'Acceso denegado: el rol VENDEDOR no tiene permiso para este recurso',
        );
      }
    }

    return true;
  }
}

