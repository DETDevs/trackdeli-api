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
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { UpdatePosSubscriptionDto } from './dto/update-pos-subscription.dto';
import { RegisterWebDeviceDto } from './dto/register-web-device.dto';

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

    // 165a: Los dispositivos web solo se registran al cobrar, no al iniciar sesión
    if (platform && platform.startsWith('web')) {
      return;
    }

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

    // Si no existe: verificar límite maxDevices (solo para DESKTOP)
    const activeDevicesCount = await this.prisma.posDevice.count({
      where: {
        businessId: user.businessId,
        status: PosDeviceStatus.ACTIVE,
        category: 'DESKTOP',
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
        category: 'DESKTOP',
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
    const devices = await this.prisma.posDevice.findMany({
      where: { businessId },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    });
    return devices.map(({ secretHash, ...d }) => d);
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

    const { secretHash, ...safe } = updated;
    return safe;
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
        ...(dto.webBillingEnabled !== undefined && { webBillingEnabled: dto.webBillingEnabled }),
        ...(dto.maxWebDevices !== undefined && { maxWebDevices: dto.maxWebDevices }),
      },
    });

    await this.auditService.record({
      businessId,
      userId: actorUser?.sub || 'system',
      userRole: actorUser?.role || 'SUPERADMIN',
      action: 'DEVICE_LIMIT_CHANGED',
      entityType: 'BusinessProductSubscription',
      entityId: sub.id,
      before: { maxDevices: sub.maxDevices, webBillingEnabled: sub.webBillingEnabled, maxWebDevices: sub.maxWebDevices },
      after: { maxDevices: updated.maxDevices, webBillingEnabled: updated.webBillingEnabled, maxWebDevices: updated.maxWebDevices },
    });

    this.logger.log(
      `[updatePosSubscription] Límite maxDevices de businessId=${businessId} cambiado de ${sub.maxDevices} a ${updated.maxDevices} por ${actorUser?.sub || 'system'}`,
    );

    return updated;
  }

  /**
   * 165a - Registro de dispositivo web (roles CAJERO, ENCARGADO, SUPERADMIN).
   */
  async registerWebDevice(
    dto: RegisterWebDeviceDto,
    businessId: string,
    user: { id: string; email: string; role: UserRole },
    req?: any,
  ): Promise<{ success: boolean; device: any; secret?: string }> {
    const posSub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId,
          productType: BusinessProductType.POS,
        },
      },
    });

    if (!posSub || posSub.status !== BusinessProductStatus.ACTIVE || !posSub.webBillingEnabled) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'WEB_BILLING_DISABLED',
        message: 'La facturación web no está habilitada para este negocio',
      });
    }

    const headers = req?.headers || {};
    const secretHeader = headers['x-device-secret'] || headers['X-Device-Secret'];
    const ipAddress = req?.ip || req?.connection?.remoteAddress || undefined;
    const userAgent = dto.userAgent || headers['user-agent'] || undefined;

    const existingDevice = await this.prisma.posDevice.findUnique({
      where: {
        businessId_deviceId: {
          businessId,
          deviceId: dto.deviceId,
        },
      },
    });

    if (existingDevice) {
      if (existingDevice.status === PosDeviceStatus.REVOKED) {
        this.logger.warn(`[registerWebDevice] Dispositivo web revocado: ${dto.deviceId} en businessId=${businessId}`);
        await this.auditService.record({
          businessId,
          userId: user.id,
          userRole: user.role,
          action: 'WEB_DEVICE_BLOCKED_REVOKED',
          entityType: 'PosDevice',
          entityId: existingDevice.id,
          reason: `Intento de registro con dispositivo web revocado (${dto.deviceId})`,
          ipAddress,
        });

        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'DEVICE_REVOKED',
          message: 'Este dispositivo ha sido revocado. Contacta al administrador para reactivarlo.',
        });
      }

      // Dispositivo existente ACTIVE: exigir el secreto
      if (!secretHeader) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'DEVICE_INVALID',
          message: 'Secreto del dispositivo requerido para actualizar dispositivo existente',
        });
      }

      const providedHash = crypto.createHash('sha256').update(String(secretHeader).trim()).digest('hex');
      if (!existingDevice.secretHash || providedHash !== existingDevice.secretHash) {
        this.logger.warn(`[registerWebDevice] Secreto incorrecto para deviceId: ${dto.deviceId}`);
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'DEVICE_INVALID',
          message: 'El secreto del dispositivo es inválido o no coincide',
        });
      }

      // Si coincide: actualizar lastSeenAt, userAgent, ipAddress y userId (sin gastar un lugar nuevo)
      const updated = await this.prisma.posDevice.update({
        where: { id: existingDevice.id },
        data: {
          lastSeenAt: new Date(),
          userId: user.id,
          lastUserId: user.id,
          category: 'WEB',
          ...(dto.name && { name: dto.name.trim() }),
          ...(userAgent && { userAgent }),
          ...(ipAddress && { ipAddress }),
        },
      });

      await this.auditService.record({
        businessId,
        userId: user.id,
        userRole: user.role,
        action: 'WEB_DEVICE_UPDATED',
        entityType: 'PosDevice',
        entityId: updated.id,
        reason: 'Dispositivo web reactivado/actualizado con secreto válido',
        ipAddress,
      });

      const { secretHash: _, ...safeDevice } = updated;
      return { success: true, device: safeDevice };
    }

    // Dispositivo nuevo: verificar límite maxWebDevices
    const activeWebDevices = await this.prisma.posDevice.count({
      where: {
        businessId,
        status: PosDeviceStatus.ACTIVE,
        category: 'WEB',
      },
    });

    if (posSub.maxWebDevices !== null && activeWebDevices >= posSub.maxWebDevices) {
      this.logger.warn(
        `[registerWebDevice] Límite de dispositivos web alcanzado para businessId=${businessId}: ${activeWebDevices}/${posSub.maxWebDevices}`,
      );

      await this.auditService.record({
        businessId,
        userId: user.id,
        userRole: user.role,
        action: 'WEB_DEVICE_LIMIT_EXCEEDED',
        entityType: 'PosDevice',
        reason: `Intento de registrar dispositivo web '${dto.deviceId}' excediendo límite (${activeWebDevices}/${posSub.maxWebDevices})`,
        before: { activeWebDevices, maxWebDevices: posSub.maxWebDevices },
        ipAddress,
      });

      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'WEB_DEVICE_LIMIT_REACHED',
        message: `Límite de dispositivos web alcanzado (${activeWebDevices}/${posSub.maxWebDevices}).`,
        maxWebDevices: posSub.maxWebDevices,
        activeWebDevices,
      });
    }

    // Generar secreto aleatorio de 256 bits y guardar solo su hash SHA-256
    const secret = crypto.randomBytes(32).toString('hex');
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

    const newDevice = await this.prisma.posDevice.create({
      data: {
        businessId,
        deviceId: dto.deviceId,
        name: dto.name.trim(),
        category: 'WEB',
        platform: 'web',
        status: PosDeviceStatus.ACTIVE,
        userId: user.id,
        lastUserId: user.id,
        userAgent: userAgent || null,
        ipAddress: ipAddress || null,
        secretHash,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    await this.auditService.record({
      businessId,
      userId: user.id,
      userRole: user.role,
      action: 'WEB_DEVICE_REGISTERED',
      entityType: 'PosDevice',
      entityId: newDevice.id,
      after: {
        deviceId: newDevice.deviceId,
        name: newDevice.name,
        category: newDevice.category,
        status: newDevice.status,
      },
      ipAddress,
    });

    this.logger.log(
      `[registerWebDevice] Dispositivo web registrado: id=${newDevice.id} deviceId=${dto.deviceId} en businessId=${businessId}`,
    );

    const { secretHash: _, ...safeDevice } = newDevice;
    return { success: true, device: safeDevice, secret };
  }

  /**
   * 165a - Listar dispositivos web del negocio (solo ENCARGADO y SUPERADMIN).
   */
  async getWebDevices(businessId: string) {
    const devices = await this.prisma.posDevice.findMany({
      where: {
        businessId,
        category: 'WEB',
      },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    });

    const userIds = Array.from(new Set(devices.map((d) => d.userId).filter(Boolean))) as string[];
    const users = userIds.length > 0 ? await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    }) : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    return devices.map(({ secretHash, ...d }) => ({
      ...d,
      user: d.userId ? userMap.get(d.userId) || null : null,
    }));
  }

  /**
   * 165a - Revocar dispositivo web (solo ENCARGADO y SUPERADMIN).
   */
  async revokeWebDevice(
    businessId: string,
    deviceIdOrId: string,
    actorUser?: JwtPayload,
    ipAddress?: string,
  ) {
    const device = await this.prisma.posDevice.findFirst({
      where: {
        businessId,
        category: 'WEB',
        OR: [{ id: deviceIdOrId }, { deviceId: deviceIdOrId }],
      },
    });

    if (!device) {
      throw new NotFoundException('Dispositivo web no encontrado');
    }

    const updated = await this.prisma.posDevice.update({
      where: { id: device.id },
      data: { status: PosDeviceStatus.REVOKED },
    });

    await this.auditService.record({
      businessId,
      userId: actorUser?.sub || 'system',
      userRole: actorUser?.role || 'ENCARGADO',
      action: 'WEB_DEVICE_REVOKED',
      entityType: 'PosDevice',
      entityId: device.id,
      before: { status: device.status },
      after: { status: updated.status },
      ipAddress,
    });

    this.logger.log(
      `[revokeWebDevice] Dispositivo web ${device.id} (${device.deviceId}) revocado por ${actorUser?.sub || 'system'}`,
    );

    const { secretHash, ...safe } = updated;
    return safe;
  }

  /**
   * 165a - Estado de facturación web para UI.
   */
  async getWebBillingStatus(businessId: string, userId: string) {
    const posSub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId,
          productType: BusinessProductType.POS,
        },
      },
    });

    const enabled = !!(posSub && posSub.status === BusinessProductStatus.ACTIVE && posSub.webBillingEnabled);
    const maxWebDevices = posSub?.maxWebDevices ?? null;

    const activeWebDevices = await this.prisma.posDevice.count({
      where: {
        businessId,
        category: 'WEB',
        status: PosDeviceStatus.ACTIVE,
      },
    });

    const openShift = await this.prisma.cashRegister.findFirst({
      where: { businessId, cashierId: userId, status: 'OPEN' },
    }) || await this.prisma.cashRegister.findFirst({
      where: { businessId, status: 'OPEN' },
    });

    return {
      enabled,
      maxWebDevices,
      activeWebDevices,
      hasOpenShift: !!openShift,
    };
  }
}
