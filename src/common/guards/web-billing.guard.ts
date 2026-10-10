import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessProductStatus, BusinessProductType, PosDeviceStatus } from '@prisma/client';
import { resolveBusinessId } from '../../modules/pos/pos.utils';

@Injectable()
export class WebBillingGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const headers = request.headers || {};

    const platformHeader = headers['x-client-platform'] || headers['X-Client-Platform'];

    // 4. Peticiones sin cabecera de plataforma: responden 403 DEVICE_REQUIRED
    if (!platformHeader || !String(platformHeader).trim()) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_REQUIRED',
        message: 'Cabecera de plataforma requerida (X-Client-Platform)',
      });
    }

    const platform = String(platformHeader).trim().toLowerCase();

    // Si no es web (ej: desktop-win), permitir el flujo normal del desktop
    if (!platform.startsWith('web')) {
      return true;
    }

    const businessId = resolveBusinessId(user, request.query?.businessId);
    if (!businessId) {
      throw new ForbiddenException('Sin negocio asociado');
    }

    // 1. Verificar webBillingEnabled en el negocio
    const posSub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId,
          productType: BusinessProductType.POS,
        },
      },
    });

    if (
      !posSub ||
      posSub.status !== BusinessProductStatus.ACTIVE ||
      !posSub.webBillingEnabled ||
      (posSub as any).webAdminEnabled === false
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'WEB_BILLING_DISABLED',
        message: 'La facturación web no está habilitada para este negocio',
      });
    }

    // 2. Exigir X-Device-Id y X-Device-Secret
    const deviceIdRaw = headers['x-device-id'] || headers['X-Device-Id'];
    const deviceSecretRaw = headers['x-device-secret'] || headers['X-Device-Secret'];

    if (!deviceIdRaw || !deviceSecretRaw) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_REQUIRED',
        message: 'Dispositivo y secreto requeridos para facturación web (X-Device-Id y X-Device-Secret)',
      });
    }

    const deviceId = String(deviceIdRaw).trim();
    const deviceSecret = String(deviceSecretRaw).trim();

    // 3. Buscar dispositivo WEB en la base de datos
    const device = await this.prisma.posDevice.findFirst({
      where: {
        businessId,
        deviceId,
        category: 'WEB',
      },
    });

    if (!device) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_INVALID',
        message: 'Dispositivo web no encontrado o inválido para este negocio',
      });
    }

    if (device.status === PosDeviceStatus.REVOKED) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_REVOKED',
        message: 'Este dispositivo ha sido revocado. Contacta al administrador para reactivarlo.',
      });
    }

    if (device.status !== PosDeviceStatus.ACTIVE) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_INVALID',
        message: 'El dispositivo no está activo',
      });
    }

    // 4. Validar secreto
    const secretHash = crypto.createHash('sha256').update(deviceSecret).digest('hex');
    if (!device.secretHash || secretHash !== device.secretHash) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_INVALID',
        message: 'Secreto de dispositivo inválido',
      });
    }

    // 5. Validar que corresponda a este usuario (o registrarlo)
    if (device.userId && user?.sub && device.userId !== user.sub) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_INVALID',
        message: 'El dispositivo no está asignado a este usuario. Debe registrarlo nuevamente.',
      });
    }

    // 6. Actualizar última actividad
    const ipAddress = request.ip || request.connection?.remoteAddress || undefined;
    const userAgent = headers['user-agent'] || undefined;

    await this.prisma.posDevice.update({
      where: { id: device.id },
      data: {
        lastSeenAt: new Date(),
        ...(ipAddress && { ipAddress }),
        ...(userAgent && { userAgent }),
      },
    });

    request.posDevice = device;
    return true;
  }
}
