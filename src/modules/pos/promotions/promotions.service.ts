import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import {
  isPromotionActiveAt,
  parseTimeToMinutes,
  PROMOTION_CHANNELS,
  PROMOTION_SCOPES,
  PROMOTION_TYPES,
  toIntArray,
  toStringArray,
} from './promotions-engine.util';

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  public formatPromotion(p: any) {
    return {
      id: p.id,
      businessId: p.businessId,
      name: p.name,
      type: p.type,
      scope: p.scope,
      productIds: toStringArray(p.productIds),
      categoryIds: toStringArray(p.categoryIds),
      discountPct: p.discountPct != null ? Number(p.discountPct) : null,
      discountAmount: p.discountAmount != null ? Number(p.discountAmount) : null,
      buyQty: p.buyQty ?? null,
      payQty: p.payQty ?? null,
      minQty: p.minQty != null ? Number(p.minQty) : null,
      tierUnitPrice: p.tierUnitPrice != null ? Number(p.tierUnitPrice) : null,
      startsAt: p.startsAt ?? null,
      endsAt: p.endsAt ?? null,
      daysOfWeek: toIntArray(p.daysOfWeek),
      startTime: p.startTime ?? null,
      endTime: p.endTime ?? null,
      channels: toStringArray(p.channels),
      priority: Number(p.priority ?? 0),
      isActive: Boolean(p.isActive),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  private async validateAndNormalizePayload(
    businessId: string,
    merged: {
      name: string;
      type: string;
      scope: string;
      productIds: any;
      categoryIds: any;
      discountPct: any;
      discountAmount: any;
      buyQty: any;
      payQty: any;
      minQty: any;
      tierUnitPrice: any;
      startsAt: any;
      endsAt: any;
      daysOfWeek: any;
      startTime: any;
      endTime: any;
      channels: any;
      priority: any;
      isActive: any;
    },
  ) {
    const name = String(merged.name || '').trim();
    if (!name) {
      throw new BadRequestException('El nombre de la promoción es obligatorio.');
    }

    if (!PROMOTION_TYPES.includes(merged.type as any)) {
      throw new BadRequestException('Tipo de promoción no válido.');
    }
    if (!PROMOTION_SCOPES.includes(merged.scope as any)) {
      throw new BadRequestException('El alcance de la promoción debe ser PRODUCT o CATEGORY.');
    }

    let productIds: string[] = [];
    let categoryIds: string[] = [];

    if (merged.scope === 'PRODUCT') {
      productIds = Array.from(new Set(toStringArray(merged.productIds)));
      if (productIds.length === 0) {
        throw new BadRequestException(
          'Debés seleccionar al menos un producto para una promoción por producto.',
        );
      }
      const foundCount = await this.prisma.product.count({
        where: { id: { in: productIds }, businessId },
      });
      if (foundCount !== productIds.length) {
        throw new BadRequestException(
          'Uno o más productos seleccionados no existen en este negocio.',
        );
      }
    } else {
      categoryIds = Array.from(new Set(toStringArray(merged.categoryIds)));
      if (categoryIds.length === 0) {
        throw new BadRequestException(
          'Debés seleccionar al menos una categoría para una promoción por categoría.',
        );
      }
      const foundCount = await this.prisma.category.count({
        where: { id: { in: categoryIds }, businessId },
      });
      if (foundCount !== categoryIds.length) {
        throw new BadRequestException(
          'Una o más categorías seleccionadas no existen en este negocio.',
        );
      }
    }

    let discountPct: Prisma.Decimal | null = null;
    let discountAmount: Prisma.Decimal | null = null;
    let buyQty: number | null = null;
    let payQty: number | null = null;
    let minQty: Prisma.Decimal | null = null;
    let tierUnitPrice: Prisma.Decimal | null = null;

    switch (merged.type) {
      case 'PERCENT_DISCOUNT': {
        const pct = Number(merged.discountPct);
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
          throw new BadRequestException(
            'El porcentaje de descuento debe ser mayor a 0 y menor a 100.',
          );
        }
        discountPct = new Prisma.Decimal(Math.round(pct * 100) / 100);
        break;
      }
      case 'FIXED_DISCOUNT': {
        const amt = Number(merged.discountAmount);
        if (!Number.isFinite(amt) || amt <= 0) {
          throw new BadRequestException(
            'El monto fijo de descuento por unidad debe ser mayor a 0.',
          );
        }
        discountAmount = new Prisma.Decimal(Math.round(amt * 100) / 100);
        break;
      }
      case 'BUY_N_PAY_M': {
        const n = Number(merged.buyQty);
        const m = Number(merged.payQty);
        if (
          !Number.isInteger(n) ||
          !Number.isInteger(m) ||
          m < 1 ||
          n <= m
        ) {
          throw new BadRequestException(
            'En promociones NxM debés indicar cantidades enteras con buyQty > payQty >= 1.',
          );
        }
        buyQty = n;
        payQty = m;
        break;
      }
      case 'QTY_PRICE_TIER': {
        const mq = Number(merged.minQty);
        const tp =
          merged.tierUnitPrice !== null && merged.tierUnitPrice !== undefined
            ? Number(merged.tierUnitPrice)
            : NaN;
        if (!Number.isFinite(mq) || mq <= 0) {
          throw new BadRequestException(
            'La cantidad mínima para precio por cantidad debe ser mayor a 0.',
          );
        }
        if (!Number.isFinite(tp) || tp < 0) {
          throw new BadRequestException(
            'El precio por cantidad debe ser mayor o igual a 0.',
          );
        }
        minQty = new Prisma.Decimal(Math.round(mq * 1000) / 1000);
        tierUnitPrice = new Prisma.Decimal(Math.round(tp * 100) / 100);
        break;
      }
    }

    let startsAt: Date | null = null;
    let endsAt: Date | null = null;
    if (merged.startsAt) {
      startsAt = new Date(merged.startsAt);
      if (isNaN(startsAt.getTime())) {
        throw new BadRequestException('La fecha de inicio no es válida.');
      }
    }
    if (merged.endsAt) {
      endsAt = new Date(merged.endsAt);
      if (isNaN(endsAt.getTime())) {
        throw new BadRequestException('La fecha de fin no es válida.');
      }
    }
    if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la fecha de inicio.',
      );
    }

    const rawDays = Array.isArray(merged.daysOfWeek) ? merged.daysOfWeek : [];
    const daysSet = new Set<number>();
    for (const d of rawDays) {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) {
        throw new BadRequestException(
          'Los días de la semana deben ser enteros entre 0 (domingo) y 6 (sábado).',
        );
      }
      daysSet.add(n);
    }
    const daysOfWeek = Array.from(daysSet).sort((a, b) => a - b);

    const startTime = merged.startTime ? String(merged.startTime).trim() : null;
    const endTime = merged.endTime ? String(merged.endTime).trim() : null;
    if (startTime !== null && parseTimeToMinutes(startTime) === null) {
      throw new BadRequestException('La hora de inicio debe tener formato HH:mm.');
    }
    if (endTime !== null && parseTimeToMinutes(endTime) === null) {
      throw new BadRequestException('La hora de fin debe tener formato HH:mm.');
    }

    const rawChannels = toStringArray(merged.channels).map((c) => c.toUpperCase());
    for (const ch of rawChannels) {
      if (!PROMOTION_CHANNELS.includes(ch as any)) {
        throw new BadRequestException(
          `Canal "${ch}" no válido. Los canales permitidos son MOSTRADOR, DOMICILIO o PEDIDOSYA.`,
        );
      }
    }
    const channels = Array.from(new Set(rawChannels));

    const priority =
      merged.priority !== undefined && merged.priority !== null
        ? Number(merged.priority)
        : 0;
    if (!Number.isInteger(priority)) {
      throw new BadRequestException('La prioridad debe ser un número entero.');
    }

    return {
      name: name.substring(0, 150),
      type: merged.type,
      scope: merged.scope,
      productIds,
      categoryIds,
      discountPct,
      discountAmount,
      buyQty,
      payQty,
      minQty,
      tierUnitPrice,
      startsAt,
      endsAt,
      daysOfWeek,
      startTime,
      endTime,
      channels,
      priority,
      isActive: merged.isActive !== undefined ? Boolean(merged.isActive) : true,
    };
  }

  async findAll(
    businessId: string,
    filters?: {
      activeNow?: boolean;
      channel?: string;
      includeInactive?: boolean;
    },
    userRole?: string,
  ) {
    const canSeeInactive =
      userRole === UserRole.ENCARGADO || userRole === UserRole.SUPERADMIN;

    const where: Prisma.PosPromotionWhereInput = { businessId };
    if (filters?.activeNow) {
      where.isActive = true;
    } else if (!canSeeInactive || filters?.includeInactive === false) {
      where.isActive = true;
    }

    const rows = await this.prisma.posPromotion.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });

    const filtered = filters?.activeNow
      ? rows.filter((p) => isPromotionActiveAt(p, new Date(), filters.channel || null))
      : rows;

    return filtered.map((p) => this.formatPromotion(p));
  }

  async findOne(businessId: string, id: string) {
    const row = await this.prisma.posPromotion.findFirst({
      where: { id, businessId },
    });
    if (!row) {
      throw new NotFoundException('Promoción no encontrada.');
    }
    return this.formatPromotion(row);
  }

  async create(businessId: string, dto: CreatePromotionDto) {
    const data = await this.validateAndNormalizePayload(businessId, {
      name: dto.name,
      type: dto.type,
      scope: dto.scope,
      productIds: dto.productIds ?? [],
      categoryIds: dto.categoryIds ?? [],
      discountPct: dto.discountPct ?? null,
      discountAmount: dto.discountAmount ?? null,
      buyQty: dto.buyQty ?? null,
      payQty: dto.payQty ?? null,
      minQty: dto.minQty ?? null,
      tierUnitPrice: dto.tierUnitPrice ?? null,
      startsAt: dto.startsAt ?? null,
      endsAt: dto.endsAt ?? null,
      daysOfWeek: dto.daysOfWeek ?? [],
      startTime: dto.startTime ?? null,
      endTime: dto.endTime ?? null,
      channels: dto.channels ?? [],
      priority: dto.priority ?? 0,
      isActive: dto.isActive ?? true,
    });

    const created = await this.prisma.posPromotion.create({
      data: {
        businessId,
        ...data,
      },
    });
    return this.formatPromotion(created);
  }

  async update(businessId: string, id: string, dto: UpdatePromotionDto) {
    const existing = await this.prisma.posPromotion.findFirst({
      where: { id, businessId },
    });
    if (!existing) {
      throw new NotFoundException('Promoción no encontrada.');
    }

    const data = await this.validateAndNormalizePayload(businessId, {
      name: dto.name !== undefined ? dto.name : existing.name,
      type: dto.type !== undefined ? dto.type : existing.type,
      scope: dto.scope !== undefined ? dto.scope : existing.scope,
      productIds:
        dto.productIds !== undefined ? dto.productIds : existing.productIds,
      categoryIds:
        dto.categoryIds !== undefined ? dto.categoryIds : existing.categoryIds,
      discountPct:
        dto.discountPct !== undefined ? dto.discountPct : existing.discountPct,
      discountAmount:
        dto.discountAmount !== undefined
          ? dto.discountAmount
          : existing.discountAmount,
      buyQty: dto.buyQty !== undefined ? dto.buyQty : existing.buyQty,
      payQty: dto.payQty !== undefined ? dto.payQty : existing.payQty,
      minQty: dto.minQty !== undefined ? dto.minQty : existing.minQty,
      tierUnitPrice:
        dto.tierUnitPrice !== undefined
          ? dto.tierUnitPrice
          : existing.tierUnitPrice,
      startsAt: dto.startsAt !== undefined ? dto.startsAt : existing.startsAt,
      endsAt: dto.endsAt !== undefined ? dto.endsAt : existing.endsAt,
      daysOfWeek:
        dto.daysOfWeek !== undefined ? dto.daysOfWeek : existing.daysOfWeek,
      startTime:
        dto.startTime !== undefined ? dto.startTime : existing.startTime,
      endTime: dto.endTime !== undefined ? dto.endTime : existing.endTime,
      channels: dto.channels !== undefined ? dto.channels : existing.channels,
      priority: dto.priority !== undefined ? dto.priority : existing.priority,
      isActive: dto.isActive !== undefined ? dto.isActive : existing.isActive,
    });

    const updated = await this.prisma.posPromotion.update({
      where: { id },
      data,
    });
    return this.formatPromotion(updated);
  }

  async remove(businessId: string, id: string) {
    const existing = await this.prisma.posPromotion.findFirst({
      where: { id, businessId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Promoción no encontrada.');
    }

    const usageCount = await this.prisma.saleItem.count({
      where: { promotionId: id },
    });
    if (usageCount > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'PROMOTION_IN_USE',
        message: 'Ya se usó en ventas. Desactivala en vez de borrarla.',
      });
    }

    await this.prisma.posPromotion.delete({ where: { id } });
    return { deleted: true, id };
  }
}
