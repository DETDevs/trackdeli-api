import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BusinessProductType, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PushService } from '../push/push.service';
import { JwtPayload } from '../../../common/types/jwt-payload.interface';
import { CreateRouteSellerDto } from './dto/create-route-seller.dto';
import { UpdateRouteSellerDto } from './dto/update-route-seller.dto';
import { UpdatePreventaSettingsDto } from './dto/update-preventa-settings.dto';

const DEFAULT_MAX_ROUTE_SELLERS = 4;

@Injectable()
export class PreventaService {
  private readonly logger = new Logger(PreventaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly pushService: PushService,
  ) {}

  private generateTempPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  private async getQuota(businessId: string): Promise<{ used: number; max: number }> {
    const [sub, used] = await Promise.all([
      this.prisma.businessProductSubscription.findUnique({
        where: {
          businessId_productType: {
            businessId,
            productType: BusinessProductType.PREVENTA,
          },
        },
        select: { maxRouteSellers: true },
      }),
      this.prisma.user.count({
        where: {
          businessId,
          role: UserRole.PREVENTISTA,
          isActive: true,
        },
      }),
    ]);

    const max = sub?.maxRouteSellers ?? DEFAULT_MAX_ROUTE_SELLERS;
    return { used, max };
  }

  private assertQuotaAvailable(used: number, max: number) {
    if (used >= max) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'ROUTE_SELLER_LIMIT_REACHED',
        message: `Llegaste al máximo de ${max} vendedores de tu plan.`,
      });
    }
  }

  async listSellers(businessId: string) {
    const [sellers, quota] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          businessId,
          role: UserRole.PREVENTISTA,
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      }),
      this.getQuota(businessId),
    ]);

    return {
      sellers,
      used: quota.used,
      max: quota.max,
    };
  }

  async createSeller(
    businessId: string,
    dto: CreateRouteSellerDto,
    actor: JwtPayload,
  ) {
    const quota = await this.getQuota(businessId);
    this.assertQuotaAvailable(quota.used, quota.max);

    const email = (dto.email || '').trim().toLowerCase();
    const name = (dto.name || '').trim();
    if (!name) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'SELLER_NAME_REQUIRED',
        message: 'El nombre del vendedor es obligatorio.',
      });
    }

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'EMAIL_ALREADY_IN_USE',
        message: 'Ya existe un usuario con ese correo electrónico.',
      });
    }

    const providedPassword = dto.password?.trim();
    const rawPassword = providedPassword || this.generateTempPassword();
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const seller = await this.prisma.user.create({
      data: {
        businessId,
        name,
        email,
        phone: dto.phone ? dto.phone.trim() : null,
        role: UserRole.PREVENTISTA,
        passwordHash,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    const nextQuota = await this.getQuota(businessId);
    this.logger.log(
      `[createSeller] actorId=${actor.sub} creó PREVENTISTA id=${seller.id} en businessId=${businessId} (${nextQuota.used}/${nextQuota.max})`,
    );

    return {
      seller,
      used: nextQuota.used,
      max: nextQuota.max,
      ...(providedPassword ? {} : { tempPassword: rawPassword }),
    };
  }

  async updateSeller(
    businessId: string,
    sellerId: string,
    dto: UpdateRouteSellerDto,
    actor: JwtPayload,
  ) {
    const existing = await this.prisma.user.findFirst({
      where: {
        id: sellerId,
        businessId,
        role: UserRole.PREVENTISTA,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
      },
    });

    if (!existing) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        code: 'ROUTE_SELLER_NOT_FOUND',
        message: 'Vendedor no encontrado en este negocio.',
      });
    }

    const updateData: any = {};

    if (dto.name !== undefined) {
      const cleanName = dto.name.trim();
      if (!cleanName) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'SELLER_NAME_REQUIRED',
          message: 'El nombre del vendedor no puede estar vacío.',
        });
      }
      updateData.name = cleanName;
    }

    if (dto.email !== undefined) {
      const cleanEmail = dto.email.trim().toLowerCase();
      if (cleanEmail !== existing.email) {
        const conflict = await this.prisma.user.findUnique({
          where: { email: cleanEmail },
          select: { id: true },
        });
        if (conflict && conflict.id !== existing.id) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'EMAIL_ALREADY_IN_USE',
            message: 'Ya existe un usuario con ese correo electrónico.',
          });
        }
        updateData.email = cleanEmail;
      }
    }

    if (dto.phone !== undefined) {
      updateData.phone = dto.phone ? dto.phone.trim() : null;
    }

    if (dto.password !== undefined) {
      const cleanPassword = dto.password.trim();
      if (cleanPassword.length < 6) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'PASSWORD_TOO_SHORT',
          message: 'La contraseña debe tener al menos 6 caracteres.',
        });
      }
      updateData.passwordHash = await bcrypt.hash(cleanPassword, 10);
    }

    if (dto.isActive !== undefined) {
      if (dto.isActive === true && !existing.isActive) {
        const quota = await this.getQuota(businessId);
        this.assertQuotaAvailable(quota.used, quota.max);
      }
      updateData.isActive = dto.isActive;
    }

    const seller = await this.prisma.user.update({
      where: { id: existing.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (dto.isActive === false && existing.isActive) {
      try {
        await this.pushService.deactivateTokensByUser(existing.id);
      } catch {}
    }

    const nextQuota = await this.getQuota(businessId);
    this.logger.log(
      `[updateSeller] actorId=${actor.sub} actualizó PREVENTISTA id=${seller.id} active=${seller.isActive} (${nextQuota.used}/${nextQuota.max})`,
    );

    return {
      seller,
      used: nextQuota.used,
      max: nextQuota.max,
    };
  }

  private async getOrCreateSettings(businessId: string) {
    return this.prisma.posPreventaSettings.upsert({
      where: { businessId },
      create: { businessId },
      update: {},
    });
  }

  async getSettings(businessId: string, userRole: UserRole) {
    const settings = await this.getOrCreateSettings(businessId);

    if (userRole === UserRole.PREVENTISTA) {
      return {
        defaultDeliveryDaysOffset: settings.defaultDeliveryDaysOffset,
        allowSellerPriceEdit: settings.allowSellerPriceEdit,
        allowSellerDiscounts: settings.allowSellerDiscounts,
        creditPolicyOnOverdue: settings.creditPolicyOnOverdue,
        creditPolicyOnLimitExceeded: settings.creditPolicyOnLimitExceeded,
        allowSellerCreditPayments: settings.allowSellerCreditPayments,
        allowSellerCreateCustomers: settings.allowSellerCreateCustomers,
        requireGpsOnVisit: settings.requireGpsOnVisit,
        preorderNumberPrefix: settings.preorderNumberPrefix,
      };
    }

    return settings;
  }

  async updateSettings(
    businessId: string,
    dto: UpdatePreventaSettingsDto,
    actor: JwtPayload,
  ) {
    const before = await this.getOrCreateSettings(businessId);
    const updateData: any = {};

    if (dto.defaultDeliveryDaysOffset !== undefined) {
      updateData.defaultDeliveryDaysOffset = dto.defaultDeliveryDaysOffset;
    }
    if (dto.allowSellerPriceEdit !== undefined) {
      updateData.allowSellerPriceEdit = dto.allowSellerPriceEdit;
    }
    if (dto.allowSellerDiscounts !== undefined) {
      updateData.allowSellerDiscounts = dto.allowSellerDiscounts;
    }
    if (dto.creditPolicyOnOverdue !== undefined) {
      updateData.creditPolicyOnOverdue = dto.creditPolicyOnOverdue;
    }
    if (dto.creditPolicyOnLimitExceeded !== undefined) {
      updateData.creditPolicyOnLimitExceeded = dto.creditPolicyOnLimitExceeded;
    }
    if (dto.allowSellerCreditPayments !== undefined) {
      updateData.allowSellerCreditPayments = dto.allowSellerCreditPayments;
    }
    if (dto.allowSellerCreateCustomers !== undefined) {
      updateData.allowSellerCreateCustomers = dto.allowSellerCreateCustomers;
    }
    if (dto.requireGpsOnVisit !== undefined) {
      updateData.requireGpsOnVisit = dto.requireGpsOnVisit;
    }
    if (dto.allowCreditDeliveryWithoutShift !== undefined) {
      updateData.allowCreditDeliveryWithoutShift = dto.allowCreditDeliveryWithoutShift;
    }
    if (dto.preorderNumberPrefix !== undefined) {
      const cleanPrefix = dto.preorderNumberPrefix.trim().toUpperCase();
      if (!cleanPrefix) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'INVALID_PREFIX',
          message: 'El prefijo del pedido no puede estar vacío.',
        });
      }
      updateData.preorderNumberPrefix = cleanPrefix;
    }
    if (dto.reservationExpireDays !== undefined) {
      updateData.reservationExpireDays = dto.reservationExpireDays;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.posPreventaSettings.update({
        where: { businessId },
        data: updateData,
      });

      await this.auditService.record(
        {
          businessId,
          userId: actor.sub,
          userRole: actor.role,
          action: 'CAMBIAR_CONFIG_PREVENTA',
          entityType: 'PosPreventaSettings',
          entityId: businessId,
          before,
          after: next,
        },
        tx,
      );

      return next;
    });

    return updated;
  }
}
