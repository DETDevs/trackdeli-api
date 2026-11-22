import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PosDeviceStatus } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { resolveBusinessId } from '../../pos.utils';
import { JwtPayload } from '../../../../common/types/jwt-payload.interface';

export interface MobileDeviceContext {
  id: string;
  deviceId: string;
  businessId: string;
  platform: string;
}

/**
 * 300a - Guard exclusivo para endpoints de la app móvil.
 * Valida que la petición provenga de un teléfono vinculado (X-Client-Platform: mobile-*,
 * X-Device-Id y X-Device-Secret válidos en pos_devices) y deja request.mobileDevice disponible.
 */
@Injectable()
export class MobileDeviceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user: JwtPayload | undefined = request.user;

    if (!user) {
      throw new ForbiddenException('No autenticado.');
    }

    const rawPlatform =
      request.headers['x-client-platform'] || request.headers['X-Client-Platform'];
    const platform = (rawPlatform || '').toString().trim().toLowerCase();

    if (!platform.startsWith('mobile')) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MOBILE_ONLY_ENDPOINT',
        message: 'Este recurso solo está disponible desde la aplicación móvil.',
      });
    }

    const deviceIdRaw =
      request.headers['x-device-id'] || request.headers['X-Device-Id'];
    const deviceSecretRaw =
      request.headers['x-device-secret'] || request.headers['X-Device-Secret'];
    const deviceId = deviceIdRaw ? String(deviceIdRaw).trim() : '';
    const deviceSecret = deviceSecretRaw ? String(deviceSecretRaw).trim() : '';

    if (!deviceId || !deviceSecret) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MOBILE_DEVICE_NOT_PAIRED',
        message:
          'Este teléfono no está vinculado a tu negocio. Pedile al encargado un código de vinculación.',
      });
    }

    const businessId = resolveBusinessId(user, request.query?.businessId);

    const device = await this.prisma.posDevice.findFirst({
      where: {
        businessId,
        deviceId,
        category: 'MOBILE',
      },
      select: {
        id: true,
        deviceId: true,
        businessId: true,
        platform: true,
        status: true,
        secretHash: true,
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

    request.mobileDevice = {
      id: device.id,
      deviceId: device.deviceId,
      businessId: device.businessId,
      platform: device.platform || platform,
    } as MobileDeviceContext;

    return true;
  }
}
