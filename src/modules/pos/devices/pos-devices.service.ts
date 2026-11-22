import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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
import { PairMobileDeviceDto } from './dto/pair-mobile-device.dto';
import { PushService } from '../push/push.service';

@Injectable()
export class PosDevicesService {
  private readonly logger = new Logger(PosDevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly pushService: PushService,
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

    // 165a: Los dispositivos web solo se registran al cobrar, no al iniciar sesión
    if (platform && platform.startsWith('web')) {
      return;
    }

    // 277a: Los teléfonos móviles solo se registran mediante código, nunca en el login.
    const isMobile = Boolean(platform && platform.startsWith('mobile'));
    if (isMobile) {
      const secretRaw = headers['x-device-secret'] || headers['X-Device-Secret'];
      const deviceSecret = secretRaw ? String(secretRaw).trim() : null;

      if (!deviceId || !deviceSecret) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MOBILE_DEVICE_NOT_PAIRED',
          message:
            'Este teléfono no está vinculado a tu negocio. Pedile al encargado un código de vinculación.',
        });
      }

      const maxMobileDevices = (posSub as any).maxMobileDevices ?? 0;
      if (maxMobileDevices <= 0) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MOBILE_APP_NOT_ENABLED',
          message: 'La app móvil no está activa para este negocio. Contactá a NEXOL.',
        });
      }

      const mobileDevice = await this.prisma.posDevice.findFirst({
        where: {
          businessId: user.businessId,
          deviceId,
          category: 'MOBILE',
        },
      });

      if (!mobileDevice || mobileDevice.status !== PosDeviceStatus.ACTIVE) {
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

      if (!mobileDevice.secretHash || secretHash !== mobileDevice.secretHash) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'MOBILE_DEVICE_NOT_PAIRED',
          message:
            'Este teléfono no está vinculado a tu negocio. Pedile al encargado un código de vinculación.',
        });
      }

      // Actualizar lastSeenAt, lastUserId y metadata del teléfono
      await this.prisma.posDevice.update({
        where: { id: mobileDevice.id },
        data: {
          lastSeenAt: new Date(),
          lastUserId: user.id,
          ...(appVersion && { appVersion }),
          ...(platform && { platform }),
          ...(deviceName && !mobileDevice.name && { name: deviceName }),
        },
      });

      return;
    }

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
      where: { businessId, archivedAt: null },
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

    const isRevokingMobile =
      device.category === 'MOBILE' && dto.status === PosDeviceStatus.REVOKED;

    const updated = await this.prisma.posDevice.update({
      where: { id: device.id },
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(isRevokingMobile && { secretHash: null }),
        ...(dto.status === PosDeviceStatus.ACTIVE && { archivedAt: null }),
      },
    });

    if (dto.status === PosDeviceStatus.REVOKED) {
      try {
        await this.pushService.deactivateTokensByDevice(businessId, device.deviceId);
      } catch (err: any) {
        this.logger.warn(
          `[updateDevice] No se pudieron desactivar tokens push del dispositivo ${device.deviceId}: ${err?.message || 'desconocido'}`,
        );
      }
    }

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

  /**
   * 297a - Archivar equipo revocado (solo SUPERADMIN).
   * Solo para equipos con estado REVOKED. Si está activo -> 409 DEVICE_NOT_REVOKED.
   * Idempotente.
   */
  async archiveDevice(id: string, actorUser?: JwtPayload) {
    const device = await this.prisma.posDevice.findUnique({
      where: { id },
    });

    if (!device) {
      throw new NotFoundException('Dispositivo no encontrado');
    }

    if (device.status !== PosDeviceStatus.REVOKED) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'DEVICE_NOT_REVOKED',
        message: 'Revocá el equipo antes de archivarlo.',
      });
    }

    const updated = await this.prisma.posDevice.update({
      where: { id: device.id },
      data: {
        archivedAt: device.archivedAt || new Date(),
      },
    });

    await this.auditService.record({
      businessId: device.businessId,
      userId: actorUser?.sub || 'system-superadmin',
      userRole: actorUser?.role || 'SUPERADMIN',
      action: 'DEVICE_ARCHIVED',
      entityType: 'PosDevice',
      entityId: device.id,
      before: { archivedAt: device.archivedAt },
      after: { archivedAt: updated.archivedAt },
    });

    this.logger.log(
      `[archiveDevice] Dispositivo ${device.id} (${device.deviceId}) archivado en ${updated.archivedAt}`,
    );

    const { secretHash, ...safe } = updated;
    return safe;
  }

  /**
   * 297a - Desarchivar equipo (solo SUPERADMIN).
   * Vuelve a dejarlo visible con status REVOKED y archivedAt = null.
   * Idempotente.
   */
  async unarchiveDevice(id: string, actorUser?: JwtPayload) {
    const device = await this.prisma.posDevice.findUnique({
      where: { id },
    });

    if (!device) {
      throw new NotFoundException('Dispositivo no encontrado');
    }

    const updated = await this.prisma.posDevice.update({
      where: { id: device.id },
      data: {
        archivedAt: null,
      },
    });

    await this.auditService.record({
      businessId: device.businessId,
      userId: actorUser?.sub || 'system-superadmin',
      userRole: actorUser?.role || 'SUPERADMIN',
      action: 'DEVICE_UNARCHIVED',
      entityType: 'PosDevice',
      entityId: device.id,
      before: { archivedAt: device.archivedAt },
      after: { archivedAt: null },
    });

    this.logger.log(
      `[unarchiveDevice] Dispositivo ${device.id} (${device.deviceId}) desarchivado`,
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
        ...(dto.maxMobileDevices !== undefined && { maxMobileDevices: dto.maxMobileDevices }),
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
        archivedAt: null,
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

    const webAdminEnabled = (posSub as any)?.webAdminEnabled ?? true;

    return {
      webAdminEnabled,
      enabled,
      maxWebDevices,
      activeWebDevices,
      hasOpenShift: !!openShift,
    };
  }

  private pairFailedAttempts = new Map<string, { count: number; resetAt: number }>();

  private checkPairRateLimit(keys: string[]) {
    const now = Date.now();
    for (const key of keys) {
      if (!key) continue;
      const record = this.pairFailedAttempts.get(key);
      if (record && record.resetAt > now) {
        if (record.count >= 5) {
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              error: 'Too Many Requests',
              code: 'TOO_MANY_ATTEMPTS',
              message:
                'Demasiados intentos fallidos de vinculación. Esperá 10 minutos para reintentar.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    }
  }

  private recordPairFailure(keys: string[]) {
    const now = Date.now();
    for (const key of keys) {
      if (!key) continue;
      const record = this.pairFailedAttempts.get(key);
      if (!record || record.resetAt <= now) {
        this.pairFailedAttempts.set(key, { count: 1, resetAt: now + 10 * 60 * 1000 });
      } else {
        record.count += 1;
      }
    }
  }

  private clearPairFailures(keys: string[]) {
    for (const key of keys) {
      if (key) this.pairFailedAttempts.delete(key);
    }
  }

  /**
   * 277a - Genera un código de vinculación para app móvil (8 caracteres).
   * Solo ENCARGADO y SUPERADMIN.
   * Vence a los 10 minutos. Anula los anteriores sin usar de este negocio.
   */
  async createMobilePairingCode(businessId: string, userId: string) {
    const posSub = await this.prisma.businessProductSubscription.findUnique({
      where: {
        businessId_productType: {
          businessId,
          productType: BusinessProductType.POS,
        },
      },
    });

    const maxMobileDevices = (posSub as any)?.maxMobileDevices ?? 0;
    if (
      !posSub ||
      posSub.status !== BusinessProductStatus.ACTIVE ||
      maxMobileDevices <= 0
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MOBILE_APP_NOT_ENABLED',
        message: 'La app móvil no está activa para este negocio. Contactá a NEXOL.',
      });
    }

    const activeMobileDevices = await this.prisma.posDevice.count({
      where: {
        businessId,
        category: 'MOBILE',
        status: PosDeviceStatus.ACTIVE,
      },
    });

    if (activeMobileDevices >= maxMobileDevices) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'MOBILE_DEVICE_LIMIT',
        message: `Límite de teléfonos alcanzado (${activeMobileDevices}/${maxMobileDevices}). Pedile al encargado que libere un equipo o contactá a NEXOL para ampliar el cupo.`,
        maxMobileDevices,
        activeMobileDevices,
      });
    }

    // Anular códigos anteriores sin usar de este negocio
    await (this.prisma as any).posMobilePairingCode.updateMany({
      where: {
        businessId,
        isUsed: false,
      },
      data: {
        isUsed: true,
      },
    });

    // 8 caracteres: números y letras mayúsculas sin caracteres ambiguos (0/O, 1/I)
    const CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += CHARSET[crypto.randomInt(0, CHARSET.length)];
    }

    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

    await (this.prisma as any).posMobilePairingCode.create({
      data: {
        businessId,
        codeHash,
        expiresAt,
        createdBy: userId,
        isUsed: false,
      },
    });

    await this.auditService.record({
      businessId,
      userId,
      userRole: 'ENCARGADO',
      action: 'MOBILE_PAIRING_CODE_GENERATED',
      entityType: 'PosMobilePairingCode',
      reason: 'Código de vinculación generado para app móvil',
    });

    return { code, expiresAt };
  }

  /**
   * 277a - Vinculación de teléfono con código (sin sesión previa).
   * Valida código, cupo, registra/reactiva teléfono y genera secreto del teléfono.
   * Idempotente por deviceId + businessId.
   */
  async pairMobileDevice(dto: PairMobileDeviceDto, ipAddress?: string) {
    const cleanDeviceId = (dto.deviceId || '').trim();
    const cleanCode = (dto.code || '').trim().toUpperCase();
    const cleanName = (dto.deviceName || '').trim() || 'Móvil POS';
    const cleanPlatform = (dto.platform || '').trim().toLowerCase() || 'mobile-android';

    const limiterKeys: string[] = [];
    if (ipAddress) limiterKeys.push(`pair:ip:${ipAddress}`);
    if (cleanDeviceId) limiterKeys.push(`pair:device:${cleanDeviceId}`);

    this.checkPairRateLimit(limiterKeys);

    if (!cleanCode || !cleanDeviceId) {
      this.recordPairFailure(limiterKeys);
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PAIRING_CODE_INVALID',
        message: 'El código no es válido o ya venció. Pedile uno nuevo al encargado.',
      });
    }

    const codeHash = crypto.createHash('sha256').update(cleanCode).digest('hex');

    const pairingRecord = await (this.prisma as any).posMobilePairingCode.findFirst({
      where: {
        codeHash,
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!pairingRecord) {
      this.recordPairFailure(limiterKeys);
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PAIRING_CODE_INVALID',
        message: 'El código no es válido o ya venció. Pedile uno nuevo al encargado.',
      });
    }

    const businessId = pairingRecord.businessId;

    const result = await this.prisma.$transaction(
      async (tx: any) => {
        // 1. Marcar código como usado atómicamente
        const updatedCode = await tx.posMobilePairingCode.updateMany({
          where: {
            id: pairingRecord.id,
            isUsed: false,
            expiresAt: { gt: new Date() },
          },
          data: {
            isUsed: true,
            usedAt: new Date(),
            usedByDeviceId: cleanDeviceId,
          },
        });

        if (updatedCode.count === 0) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'PAIRING_CODE_INVALID',
            message: 'El código no es válido o ya venció. Pedile uno nuevo al encargado.',
          });
        }

        // 2. Validar suscripción POS y cupo móvil
        const posSub = await tx.businessProductSubscription.findUnique({
          where: {
            businessId_productType: {
              businessId,
              productType: BusinessProductType.POS,
            },
          },
        });

        const maxMobile = (posSub as any)?.maxMobileDevices ?? 0;
        if (
          !posSub ||
          posSub.status !== BusinessProductStatus.ACTIVE ||
          maxMobile <= 0
        ) {
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'MOBILE_APP_NOT_ENABLED',
            message: 'La app móvil no está activa para este negocio. Contactá a NEXOL.',
          });
        }

        // 3. Verificar si el teléfono ya está registrado y activo en este negocio
        const existingDevice = await tx.posDevice.findUnique({
          where: {
            businessId_deviceId: {
              businessId,
              deviceId: cleanDeviceId,
            },
          },
        });

        const isCurrentlyActiveMobile =
          existingDevice &&
          existingDevice.category === 'MOBILE' &&
          existingDevice.status === PosDeviceStatus.ACTIVE;

        if (!isCurrentlyActiveMobile) {
          const activeMobileDevices = await tx.posDevice.count({
            where: {
              businessId,
              category: 'MOBILE',
              status: PosDeviceStatus.ACTIVE,
            },
          });

          if (activeMobileDevices >= maxMobile) {
            throw new ForbiddenException({
              statusCode: 403,
              error: 'Forbidden',
              code: 'MOBILE_DEVICE_LIMIT',
              message: `Límite de teléfonos alcanzado (${activeMobileDevices}/${maxMobile}). Pedile al encargado que libere un equipo o contactá a NEXOL para ampliar el cupo.`,
            });
          }
        }

        // 4. Generar secreto de 256 bits y guardar solo su hash SHA-256
        const deviceSecret = crypto.randomBytes(32).toString('hex');
        const secretHash = crypto.createHash('sha256').update(deviceSecret).digest('hex');

        // 5. Upsert atómico del dispositivo móvil
        const device = await tx.posDevice.upsert({
          where: {
            businessId_deviceId: {
              businessId,
              deviceId: cleanDeviceId,
            },
          },
          update: {
            name: cleanName,
            category: 'MOBILE',
            platform: cleanPlatform,
            status: PosDeviceStatus.ACTIVE,
            secretHash,
            lastSeenAt: new Date(),
            archivedAt: null,
          },
          create: {
            businessId,
            deviceId: cleanDeviceId,
            name: cleanName,
            category: 'MOBILE',
            platform: cleanPlatform,
            status: PosDeviceStatus.ACTIVE,
            secretHash,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          },
        });

        const business = await tx.business.findUnique({
          where: { id: businessId },
          select: { name: true },
        });

        return {
          businessId,
          businessName: business?.name || '',
          deviceSecret,
          deviceId: device.id,
        };
      },
      { timeout: 15000 },
    );

    this.clearPairFailures(limiterKeys);

    await this.auditService.record({
      businessId,
      userId: pairingRecord.createdBy,
      userRole: 'SYSTEM',
      action: 'MOBILE_DEVICE_PAIRED',
      entityType: 'PosDevice',
      entityId: result.deviceId,
      reason: `Teléfono vinculado con código: deviceId=${cleanDeviceId}`,
      ipAddress,
    });

    return {
      businessId: result.businessId,
      businessName: result.businessName,
      deviceSecret: result.deviceSecret,
    };
  }
}
