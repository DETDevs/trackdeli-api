import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BusinessProductStatus,
  BusinessProductType,
  PosDeviceStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { UpdatePosSubscriptionDto } from './dto/update-pos-subscription.dto';

@Injectable()
export class PosDevicesService {
  private readonly logger = new Logger(PosDevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Valida y registra o actualiza el dispositivo que hace login en el POS.
   * Si no se envía X-Device-Id, se permite el acceso sin registrar dispositivo (versiones viejas).
   */
  async validateAndRegisterOnLogin(
    user: { id: string; email: string; role: UserRole; businessId?: string | null },
    req?: any,
  ): Promise<void> {
    if (!user.businessId) {
      return;
    }

    if (user.role === UserRole.SUPERADMIN || user.role === UserRole.REPARTIDOR) {
      return;
    }

    // 7. Solo para negocios con el tipo de producto POS
    const posSub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId: user.businessId,
          productType: BusinessProductType.POS,
        },
      },
    });

    if (!posSub || posSub.status !== BusinessProductStatus.ACTIVE) {
      return;
    }

    const headers = req?.headers || {};
    const deviceIdRaw = headers['x-device-id'] || headers['X-Device-Id'];
    const deviceId = deviceIdRaw ? String(deviceIdRaw).trim() : null;

    const deviceNameRaw = headers['x-device-name'] || headers['X-Device-Name'];
    const deviceName = deviceNameRaw ? String(deviceNameRaw).trim() : null;

    const platformRaw = headers['x-client-platform'] || headers['X-Client-Platform'];
    const platform = platformRaw ? String(platformRaw).trim().toLowerCase() : null;
    const isDesktopWin = platform === 'desktop-win';

    const versionRaw = headers['x-client-version'] || headers['X-Client-Version'];
    const appVersion = versionRaw ? String(versionRaw).trim() : null;

    const ipAddress = req?.ip || req?.connection?.remoteAddress || undefined;

    // Si el header X-Device-Id no viene:
    if (!deviceId) {
      // 132c: Si el negocio tiene límite (maxDevices !== null) y es desktop-win, exigir el header
      if (isDesktopWin && posSub.maxDevices !== null) {
        this.logger.warn(
          `[validateAndRegisterOnLogin] Login rechazado sin X-Device-Id en desktop-win para businessId=${user.businessId} (maxDevices=${posSub.maxDevices})`,
        );

        await this.auditService.record({
          businessId: user.businessId,
          userId: user.id,
          userRole: user.role,
          action: 'DEVICE_ID_REQUIRED',
          entityType: 'PosDevice',
          reason: 'Intento de login desde desktop-win sin X-Device-Id en negocio con límite de dispositivos',
          ipAddress,
        });

        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'DEVICE_ID_REQUIRED',
          message:
            'Esta versión del POS ya no es compatible con tu plan. Actualiza a la última versión desde el instalador de NEXOL.',
        });
      }

      // Si maxDevices es null o es otra plataforma (web, comandero, etc.): se permite sin bloquear
      this.logger.log(
        `[validateAndRegisterOnLogin] Login sin X-Device-Id permitido para businessId=${user.businessId}, user=${user.email} (platform=${platform || 'desconocida'}, maxDevices=${posSub.maxDevices})`,
      );
      return;
    }

    const existingDevice = await this.prisma.posDevice.findUnique({
      where: {
        businessId_deviceId: {
          businessId: user.businessId,
          deviceId,
        },
      },
    });

    if (existingDevice) {
      if (existingDevice.status === PosDeviceStatus.REVOKED) {
        this.logger.warn(
          `[validateAndRegisterOnLogin] Intento de login con dispositivo revocado: ${deviceId} en businessId=${user.businessId}`,
        );

        await this.auditService.record({
          businessId: user.businessId,
          userId: user.id,
          userRole: user.role,
          action: 'DEVICE_BLOCKED_REVOKED',
          entityType: 'PosDevice',
          entityId: existingDevice.id,
          reason: `Intento de login con dispositivo revocado (deviceId: ${deviceId})`,
          ipAddress,
        });

        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'DEVICE_REVOKED',
          message: 'Este dispositivo ha sido revocado. Contacta al administrador para reactivarlo.',
        });
      }

      // Si existe y está ACTIVE: actualizar lastSeenAt, appVersion y lastUserId
      await this.prisma.posDevice.update({
        where: { id: existingDevice.id },
        data: {
          lastSeenAt: new Date(),
          lastUserId: user.id,
          ...(appVersion && { appVersion }),
          ...(platform && { platform }),
          ...(deviceName && !existingDevice.name && { name: deviceName }),
        },
      });

      return;
    }

    // Si no existe: verificar límite maxDevices
    const activeDevicesCount = await this.prisma.posDevice.count({
      where: {
        businessId: user.businessId,
        status: PosDeviceStatus.ACTIVE,
      },
    });

    if (posSub.maxDevices !== null && activeDevicesCount >= posSub.maxDevices) {
      this.logger.warn(
        `[validateAndRegisterOnLogin] Límite de dispositivos alcanzado para businessId=${user.businessId}: ${activeDevicesCount}/${posSub.maxDevices}`,
      );

      await this.auditService.record({
        businessId: user.businessId,
        userId: user.id,
        userRole: user.role,
        action: 'DEVICE_LIMIT_EXCEEDED',
        entityType: 'PosDevice',
        reason: `Intento de registrar dispositivo '${deviceId}' excediendo límite (${activeDevicesCount}/${posSub.maxDevices})`,
        before: { activeDevices: activeDevicesCount, maxDevices: posSub.maxDevices },
        ipAddress,
      });

      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'DEVICE_LIMIT_REACHED',
        message: `Límite de dispositivos alcanzado (${activeDevicesCount}/${posSub.maxDevices}). No es posible registrar una nueva computadora.`,
        maxDevices: posSub.maxDevices,
        activeDevices: activeDevicesCount,
      });
    }

    // Dentro del límite o sin límite: crearlo
    const newDevice = await this.prisma.posDevice.create({
      data: {
        businessId: user.businessId,
        deviceId,
        name: deviceName || `Caja ${activeDevicesCount + 1}`,
        platform,
        appVersion,
        status: PosDeviceStatus.ACTIVE,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastUserId: user.id,
      },
    });

    await this.auditService.record({
      businessId: user.businessId,
      userId: user.id,
      userRole: user.role,
      action: 'DEVICE_REGISTERED',
      entityType: 'PosDevice',
      entityId: newDevice.id,
      after: {
        deviceId: newDevice.deviceId,
        name: newDevice.name,
        platform: newDevice.platform,
        appVersion: newDevice.appVersion,
        status: newDevice.status,
      },
      ipAddress,
    });

    this.logger.log(
      `[validateAndRegisterOnLogin] Dispositivo registrado: id=${newDevice.id} deviceId=${deviceId} en businessId=${user.businessId}`,
    );
  }

  async getBusinessDevices(businessId: string) {
    return this.prisma.posDevice.findMany({
      where: { businessId },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async updateDevice(
    businessId: string,
    deviceIdOrId: string,
    dto: UpdateDeviceDto,
    actorUser?: JwtPayload,
  ) {
    const device = await this.prisma.posDevice.findFirst({
      where: {
        businessId,
        OR: [{ id: deviceIdOrId }, { deviceId: deviceIdOrId }],
      },
    });

    if (!device) {
      throw new NotFoundException('Dispositivo no encontrado');
    }

    const updated = await this.prisma.posDevice.update({
      where: { id: device.id },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.name !== undefined && { name: dto.name.trim() }),
      },
    });

    let action = 'DEVICE_UPDATED';
    if (dto.status && dto.status !== device.status) {
      action = dto.status === PosDeviceStatus.REVOKED ? 'DEVICE_REVOKED' : 'DEVICE_ACTIVATED';
    }

    await this.auditService.record({
      businessId,
      userId: actorUser?.sub || 'system',
      userRole: actorUser?.role || 'SUPERADMIN',
      action,
      entityType: 'PosDevice',
      entityId: device.id,
      before: { status: device.status, name: device.name },
      after: { status: updated.status, name: updated.name },
    });

    this.logger.log(
      `[updateDevice] Dispositivo ${device.id} (${device.deviceId}) actualizado: status=${updated.status}, name="${updated.name}" por ${actorUser?.sub || 'system'}`,
    );

    return updated;
  }

  async updatePosSubscription(
    businessId: string,
    dto: UpdatePosSubscriptionDto,
    actorUser?: JwtPayload,
  ) {
    const sub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId,
          productType: BusinessProductType.POS,
        },
      },
    });

    if (!sub) {
      throw new NotFoundException('Suscripción POS no encontrada para este negocio');
    }

    const updated = await this.prisma.businessProductSubscription.update({
      where: { id: sub.id },
      data: {
        ...(dto.maxDevices !== undefined && { maxDevices: dto.maxDevices }),
      },
    });

    await this.auditService.record({
      businessId,
      userId: actorUser?.sub || 'system',
      userRole: actorUser?.role || 'SUPERADMIN',
      action: 'DEVICE_LIMIT_CHANGED',
      entityType: 'BusinessProductSubscription',
      entityId: sub.id,
      before: { maxDevices: sub.maxDevices },
      after: { maxDevices: updated.maxDevices },
    });

    this.logger.log(
      `[updatePosSubscription] Límite maxDevices de businessId=${businessId} cambiado de ${sub.maxDevices} a ${updated.maxDevices} por ${actorUser?.sub || 'system'}`,
    );

    return updated;
  }
}
