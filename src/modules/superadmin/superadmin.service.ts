import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { CreateBusinessSuperAdminDto } from './dto/create-business-superadmin.dto';
import { OrdersMetricsQueryDto } from './dto/orders-metrics-query.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import { MembershipsQueryDto } from './dto/memberships-query.dto';
import { UpdateBusinessDto } from '../businesses/dto/update-business.dto';
import { DeleteBusinessDto } from './dto/delete-business.dto';
import { BusinessType, MembershipStatus, OrderStatus, Prisma, UserRole, BusinessProductType, BusinessProductStatus, BusinessProductAction, PosVertical, PaymentMethod, PosDeviceStatus } from '@prisma/client';
import { AuditService } from '../pos/audit/audit.service';
import { UpdateDeviceDto } from '../pos/devices/dto/update-device.dto';
import { UpdatePosSubscriptionDto } from '../pos/devices/dto/update-pos-subscription.dto';
import { getSalonLabels } from '../pos/salon/salon-profile.util';
import { JwtPayload } from '../../common/types/jwt-payload.interface';
import * as bcrypt from 'bcrypt';
import {
  calculateDueDate,
  calculateGraceEndsAt,
  computeBusinessMembershipBilling,
  createManaguaDate,
  getManaguaDateParts,
  parseManaguaDate,
  toManaguaDateString,
  isOperationallyActive,
  DerivedMembershipStatus,
} from './utils/membership-billing.util';
import { BusinessesQueryDto } from './dto/businesses-query.dto';

function generateBusinessCredentials(businessName: string): {
  email: string;
  password: string;
} {
  const cleanName = businessName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 15);

  const randomNum = Math.floor(Math.random() * 900) + 100;
  const email = `${cleanName}@trackdeli.com`;
  const password = `${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}#${randomNum}`;

  return { email, password };
}

export const DEFAULT_POS_MONTHLY_FEE = 40.00;

const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDIENTE,
  OrderStatus.ACEPTADO,
  OrderStatus.EN_CAMINO_AL_NEGOCIO,
  OrderStatus.EN_EL_NEGOCIO,
  OrderStatus.EN_CAMINO,
  OrderStatus.CERCA_DEL_DESTINO,
  OrderStatus.VERIFICANDO_ENTREGA,
  OrderStatus.INCIDENCIA,
];

import { UserQuotaService, BASE_USER_LIMIT } from '../users/user-quota.service';

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly userQuotaService: UserQuotaService,
    private readonly auditService: AuditService,
  ) { }

  private async fetchEnrichedBusinesses(now: Date = new Date()) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [businesses, deviceStats, userStats, saleStats] = await Promise.all([
      this.prisma.business.findMany({
        include: {
          _count: {
            select: {
              orders: true,
              users: {
                where: { role: UserRole.ENCARGADO },
              },
            },
          },
          orders: {
            select: {
              id: true,
              status: true,
              createdAt: true,
            },
          },
          memberships: {
            orderBy: [{ endDate: 'desc' }, { startDate: 'desc' }],
          },
          productSubscriptions: {
            select: {
              id: true,
              productType: true,
              status: true,
              posVertical: true,
              posMonthlyFee: true,
              maxDevices: true,
              carteraMonthlyFee: true,
              citasMonthlyFee: true,
              deliveryMonthlyFee: true,
              autoRenew: true,
              renewalCanceledAt: true,
              backofficeTier: true,
              trialHours: true,
              trialStartedAt: true,
              trialEndsAt: true,
              webBillingEnabled: true,
              webBillingMonthlyUsd: true,
            },
          },
          industry: {
            select: { id: true, code: true, name: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.$queryRawUnsafe<Array<{
        businessId: string;
        lastSeenAt: Date | null;
        activeDesktopDevices: number;
        activeDevices: number;
      }>>(`
        SELECT "businessId",
               MAX("lastSeenAt") as "lastSeenAt",
               COUNT(CASE WHEN "status" = 'ACTIVE' AND "category" = 'DESKTOP' THEN 1 END)::INTEGER as "activeDesktopDevices",
               COUNT(CASE WHEN "status" = 'ACTIVE' THEN 1 END)::INTEGER as "activeDevices"
        FROM "pos_devices"
        GROUP BY "businessId"
      `),
      this.prisma.$queryRawUnsafe<Array<{
        businessId: string;
        activeUsers: number;
      }>>(`
        SELECT "businessId",
               COUNT(*)::INTEGER as "activeUsers"
        FROM "users"
        WHERE "isActive" = true
        GROUP BY "businessId"
      `),
      this.prisma.$queryRawUnsafe<Array<{
        businessId: string;
        lastSaleAt: Date | null;
      }>>(`
        SELECT "businessId",
               MAX(COALESCE("occurredAt", "createdAt")) as "lastSaleAt"
        FROM "pos_sales"
        WHERE "status" = 'COMPLETED'
        GROUP BY "businessId"
      `),
    ]);

    const deviceMap = new Map<string, any>(deviceStats.map((d) => [d.businessId, d]));
    const userMap = new Map<string, number>(userStats.map((u) => [u.businessId, u.activeUsers]));
    const saleMap = new Map<string, Date | null>(saleStats.map((s) => [s.businessId, s.lastSaleAt]));

    return businesses.map((b) => {
      const ordersToday = b.orders.filter((o) => o.createdAt >= startOfDay).length;
      const ordersThisMonth = b.orders.filter((o) => o.createdAt >= startOfMonth).length;
      const activeOrders = b.orders.filter((o) =>
        ACTIVE_ORDER_STATUSES.includes(o.status),
      ).length;

      const billing = computeBusinessMembershipBilling(b, b.memberships, now);

      const deliverySub = (b.productSubscriptions as any[])?.find(
        (s: any) => s.productType === 'DELIVERY',
      );
      const hasDeliveryContracted = deliverySub?.status === 'ACTIVE';

      const posSub = (b.productSubscriptions as any[])?.find(
        (s: any) => s.productType === 'POS',
      );

      const isTrial = Boolean(
        posSub &&
          (
            (posSub.trialHours !== null && posSub.trialStartedAt === null) ||
            (posSub.trialEndsAt !== null && new Date(posSub.trialEndsAt) > now)
          ) &&
          (b.memberships.length === 0 || !b.memberships.some((m) => m.paidAt && m.status === MembershipStatus.ACTIVE)),
      );

      let monthlyAmount = 0;
      const activeMem = b.memberships.find(
        (m) => m.status === MembershipStatus.ACTIVE && Number(m.amount) > 0,
      );
      if (activeMem) {
        const durationDays =
          (activeMem.endDate.getTime() - activeMem.startDate.getTime()) /
          (1000 * 60 * 60 * 24);
        if (durationDays > 300) {
          monthlyAmount = Math.round((Number(activeMem.amount) / 12) * 100) / 100;
        } else {
          monthlyAmount = Number(activeMem.amount);
        }
      } else {
        for (const sub of b.productSubscriptions as any[]) {
          if (sub.status === 'ACTIVE') {
            if (sub.productType === 'POS') {
              monthlyAmount += Number(sub.posMonthlyFee || 0);
              if (sub.webBillingEnabled && sub.webBillingMonthlyUsd) {
                monthlyAmount += Number(sub.webBillingMonthlyUsd);
              }
            } else if (sub.productType === 'DELIVERY') {
              monthlyAmount += Number(sub.deliveryMonthlyFee || 0);
            } else if (sub.productType === 'CARTERA_COBRO') {
              monthlyAmount += Number(sub.carteraMonthlyFee || 0);
            } else if (sub.productType === 'CITAS') {
              monthlyAmount += Number(sub.citasMonthlyFee || 0);
            }
          }
        }
      }
      monthlyAmount = Math.round(monthlyAmount * 100) / 100;

      const products = (b.productSubscriptions as any[]).map((s) => {
        let fee = 0;
        if (s.productType === 'POS') {
          fee = Number(s.posMonthlyFee || 0) + (s.webBillingEnabled && s.webBillingMonthlyUsd ? Number(s.webBillingMonthlyUsd) : 0);
        } else if (s.productType === 'DELIVERY') {
          fee = Number(s.deliveryMonthlyFee || 0);
        } else if (s.productType === 'CARTERA_COBRO') {
          fee = Number(s.carteraMonthlyFee || 0);
        } else if (s.productType === 'CITAS') {
          fee = Number(s.citasMonthlyFee || 0);
        }

        const name =
          s.productType === 'DELIVERY'
            ? 'Delivery'
            : s.productType === 'POS'
            ? 'POS'
            : s.productType === 'CARTERA_COBRO'
            ? 'Cartera de Cobro'
            : s.productType === 'CITAS'
            ? 'Citas'
            : s.productType;

        return {
          id: s.id,
          type: s.productType,
          status: s.status,
          name,
          fee,
        };
      });

      const dev = deviceMap.get(b.id);
      const devices = {
        active: dev?.activeDesktopDevices || dev?.activeDevices || 0,
        allowed: posSub?.maxDevices ?? null,
      };

      const users = {
        active: userMap.get(b.id) || 0,
        limit: BASE_USER_LIMIT + (b.extraUserSlots || 0),
      };

      const lastSeenAt = dev?.lastSeenAt ? new Date(dev.lastSeenAt).toISOString() : null;
      const rawLastSale = saleMap.get(b.id);
      const lastSaleAt = rawLastSale ? new Date(rawLastSale).toISOString() : null;

      return {
        id: b.id,
        name: b.name,
        slug: b.slug,
        type: b.type,
        logoUrl: b.logoUrl,
        latitude: b.latitude,
        longitude: b.longitude,
        isActive: b.isActive,
        posAddress: b.posAddress,
        posPhone: b.posPhone,
        currency: b.currency,
        businessType: b.businessType,
        commissionRate: b.commissionRate,
        altCommissionRate: b.altCommissionRate,
        altCommissionDistanceKm: b.altCommissionDistanceKm,
        dispatchTimeoutMin: b.dispatchTimeoutMin,
        pricingModel: b.pricingModel,
        baseRate: b.baseRate,
        ratePerKm: b.ratePerKm,
        freeZoneKm: b.freeZoneKm,
        minRate: b.minRate,
        maxRate: b.maxRate,
        pricingZones: (b as any).pricingZones ?? null,
        whatsappNumber: (b as any).whatsappNumber ?? null,
        whatsappDisplay: (b as any).whatsappDisplay ?? null,
        industryId: b.industryId,
        industry: b.industry,
        usesVariants: b.usesVariants,
        tracksBatches: b.tracksBatches,
        posVertical: b.posVertical,
        salonProfile: b.salonProfile,
        maxDevices: posSub?.maxDevices ?? null,
        trialHours: posSub?.trialHours ?? null,
        trialStartedAt: posSub?.trialStartedAt ?? null,
        trialEndsAt: posSub?.trialEndsAt ?? null,
        createdAt: b.createdAt,
        _count: {
          orders: b._count.orders,
          users: b._count.users,
        },
        ordersToday,
        ordersThisMonth,
        activeOrders,
        billing_anchor_day: billing.billing_anchor_day,
        current_period_start: billing.current_period_start,
        due_date: billing.due_date,
        grace_ends_at: billing.grace_ends_at,
        membership_status: billing.membership_status,
        days_until_due: billing.days_until_due,
        membership: {
          status: billing.membership_status,
          billing_anchor_day: billing.billing_anchor_day,
          current_period_start: billing.current_period_start,
          due_date: billing.due_date,
          grace_ends_at: billing.grace_ends_at,
          days_until_due: billing.days_until_due,
          daysLeft: billing.days_until_due,
          endDate: billing.due_date_date,
        },
        productSubscriptions: b.productSubscriptions,
        hasPOS: b.hasPOS,
        hasTrackDeli: hasDeliveryContracted,
        hasCarteraCobro: b.hasCarteraCobro,
        hasCitas: b.hasCitas,

        // Nuevos campos 178a
        monthly_amount: monthlyAmount,
        is_trial: isTrial,
        products,
        devices,
        users,
        last_seen_at: lastSeenAt,
        last_sale_at: lastSaleAt,
      };
    });
  }

  async getSummary() {
    this.logger.log('[getSummary] Calculando resumen de cobros y negocios');

    const now = new Date();
    const nowParts = getManaguaDateParts(now);
    const startOfMonthManagua = createManaguaDate(
      nowParts.year,
      nowParts.month,
      1,
      0,
      0,
      0,
      0,
    );

    const enriched = await this.fetchEnrichedBusinesses(now);

    // MRR: suma de tarifa mensual de negocios activos no en prueba cuyo estado no sea VENCIDO ni NOT_CONTRACTED
    let mrr = 0;
    for (const b of enriched) {
      if (
        b.isActive &&
        !b.is_trial &&
        b.membership_status !== 'VENCIDO' &&
        b.membership_status !== 'NOT_CONTRACTED'
      ) {
        mrr += b.monthly_amount;
      }
    }
    mrr = Math.round(mrr * 100) / 100;

    // due_next_7_days: membresías que vencen en los próximos 7 días (incluye hoy: days_until_due >= 0 && <= 7)
    let dueNext7DaysCount = 0;
    let dueNext7DaysAmount = 0;
    for (const b of enriched) {
      if (
        b.isActive &&
        !b.is_trial &&
        b.days_until_due !== null &&
        b.days_until_due >= 0 &&
        b.days_until_due <= 7
      ) {
        dueNext7DaysCount++;
        dueNext7DaysAmount += b.monthly_amount;
      }
    }
    dueNext7DaysAmount = Math.round(dueNext7DaysAmount * 100) / 100;

    // in_grace: cantidad y monto de negocios EN_GRACIA
    let inGraceCount = 0;
    let inGraceAmount = 0;
    for (const b of enriched) {
      if (b.isActive && b.membership_status === 'EN_GRACIA') {
        inGraceCount++;
        inGraceAmount += b.monthly_amount;
      }
    }
    inGraceAmount = Math.round(inGraceAmount * 100) / 100;

    // overdue: cantidad y monto de negocios VENCIDO
    let overdueCount = 0;
    let overdueAmount = 0;
    for (const b of enriched) {
      if (b.isActive && b.membership_status === 'VENCIDO') {
        overdueCount++;
        overdueAmount += b.monthly_amount;
      }
    }
    overdueAmount = Math.round(overdueAmount * 100) / 100;

    // active_businesses: total activos y new_this_month
    const activeBiz = enriched.filter((b) => b.isActive);
    const newThisMonth = activeBiz.filter((b) => b.createdAt >= startOfMonthManagua).length;

    // trials: cantidad de negocios en prueba
    const trialsCount = enriched.filter((b) => b.isActive && b.is_trial).length;

    // by_type: cantidad de negocios por tipo de negocio/vertical
    const byType: Record<string, number> = {};
    for (const b of activeBiz) {
      const key = b.posVertical || b.type || (b.industry as any)?.name || 'OTROS';
      byType[key] = (byType[key] || 0) + 1;
    }

    // pending_collections: lista ordenada por urgencia (VENCIDO, EN_GRACIA, POR_VENCER, luego los demás)
    const priorityMap: Record<string, number> = {
      VENCIDO: 1,
      EN_GRACIA: 2,
      POR_VENCER: 3,
      NOT_CONTRACTED: 4,
      VIGENTE: 5,
    };
    const pendingCollections = enriched
      .filter((b) =>
        b.isActive &&
        ['VENCIDO', 'EN_GRACIA', 'POR_VENCER'].includes(b.membership_status),
      )
      .sort((a, b) => {
        const diff = (priorityMap[a.membership_status] || 9) - (priorityMap[b.membership_status] || 9);
        if (diff !== 0) return diff;
        return (a.days_until_due ?? 0) - (b.days_until_due ?? 0);
      })
      .map((b) => ({
        id: b.id,
        name: b.name,
        status: b.membership_status,
        due_date: b.due_date,
        days_until_due: b.days_until_due,
        amount: b.monthly_amount,
      }));

    // recent_payments: últimos 10 pagos registrados
    const recentMemberships = await this.prisma.membership.findMany({
      where: {
        status: { not: MembershipStatus.CANCELLED },
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      include: {
        business: {
          select: { id: true, name: true },
        },
      },
    });

    const recentPayments = recentMemberships.map((m) => ({
      id: m.id,
      business_id: m.businessId,
      business_name: m.business?.name || 'Desconocido',
      amount: Number(m.amount),
      currency: m.currency,
      payment_method: m.paymentMethod,
      payment_proof_url: m.paymentProofUrl || null,
      paid_at: m.paidAt ? m.paidAt.toISOString() : m.createdAt.toISOString(),
      period: `${toManaguaDateString(m.startDate)} — ${toManaguaDateString(m.endDate)}`,
    }));

    // inactive_adoption: negocios activos sin actividad en 7 días según señal real (last_sale)
    const inactiveAdoptionList: Array<{
      id: string;
      name: string;
      signal: 'last_sale';
      last_activity_at: string | null;
      days_inactive: number;
    }> = [];
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    for (const b of activeBiz) {
      if (b.membership_status === 'VENCIDO') continue;
      if (b.last_sale_at) {
        const saleDate = new Date(b.last_sale_at);
        if (saleDate < sevenDaysAgo) {
          const daysInactive = Math.max(0, Math.floor((now.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24)));
          inactiveAdoptionList.push({
            id: b.id,
            name: b.name,
            signal: 'last_sale',
            last_activity_at: b.last_sale_at,
            days_inactive: daysInactive,
          });
        }
      } else {
        const createdDaysAgo = Math.max(0, Math.floor((now.getTime() - b.createdAt.getTime()) / (1000 * 60 * 60 * 24)));
        if (createdDaysAgo >= 7) {
          inactiveAdoptionList.push({
            id: b.id,
            name: b.name,
            signal: 'last_sale',
            last_activity_at: null,
            days_inactive: createdDaysAgo,
          });
        }
      }
    }
    inactiveAdoptionList.sort((a, b) => b.days_inactive - a.days_inactive);

    // delivery: opcional si existe al menos un negocio con Delivery activo
    const deliveryBizCount = activeBiz.filter((b) =>
      b.productSubscriptions.some(
        (s: any) => s.productType === 'DELIVERY' && s.status === 'ACTIVE',
      ),
    ).length;

    let deliverySummary = null;
    if (deliveryBizCount > 0) {
      const ridersActive = await this.prisma.user.count({
        where: { role: UserRole.REPARTIDOR, isActive: true, isAvailable: true },
      });
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const ordersToday = await this.prisma.order.count({
        where: { createdAt: { gte: startOfDay } },
      });
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const [created30, delivered30] = await Promise.all([
        this.prisma.order.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
        this.prisma.order.count({
          where: { status: OrderStatus.ENTREGADO, createdAt: { gte: thirtyDaysAgo } },
        }),
      ]);
      const deliveryRate30 = created30 > 0 ? Number(((delivered30 / created30) * 100).toFixed(1)) : 0;

      deliverySummary = {
        active_businesses_count: deliveryBizCount,
        active_riders: ridersActive,
        orders_today: ordersToday,
        delivery_rate_30d: deliveryRate30,
      };
    }

    return {
      mrr,
      due_next_7_days: {
        count: dueNext7DaysCount,
        amount: dueNext7DaysAmount,
      },
      in_grace: {
        count: inGraceCount,
        amount: inGraceAmount,
      },
      overdue: {
        count: overdueCount,
        amount: overdueAmount,
      },
      active_businesses: {
        total: activeBiz.length,
        new_this_month: newThisMonth,
      },
      trials: trialsCount,
      by_type: byType,
      pending_collections: pendingCollections,
      recent_payments: recentPayments,
      inactive_adoption: {
        signal: 'last_sale' as const,
        businesses: inactiveAdoptionList,
      },
      delivery: deliverySummary,
    };
  }

  async getBusinesses(queryOrDate?: BusinessesQueryDto | Date) {
    this.logger.log('[getBusinesses] Obteniendo lista de negocios con métricas');

    let query: BusinessesQueryDto | undefined;
    let simulatedDate: Date | undefined;
    if (queryOrDate instanceof Date) {
      simulatedDate = queryOrDate;
    } else if (queryOrDate) {
      query = queryOrDate;
    }

    const now = simulatedDate ? new Date(simulatedDate) : new Date();
    const all = await this.fetchEnrichedBusinesses(now);

    const counters = {
      all: all.length,
      activo: all.filter(
        (b) => b.isActive && (isOperationallyActive(b.membership_status) || b.is_trial),
      ).length,
      por_vencer: all.filter((b) => b.isActive && b.membership_status === 'POR_VENCER').length,
      en_gracia: all.filter((b) => b.isActive && b.membership_status === 'EN_GRACIA').length,
      vencido: all.filter((b) => b.isActive && b.membership_status === 'VENCIDO').length,
      prueba: all.filter((b) => b.isActive && b.is_trial).length,
      inactivo: all.filter((b) => !b.isActive).length,
    };

    let filtered = [...all];

    // Filtro por status
    if (query?.status) {
      const s = query.status.toLowerCase().trim();
      if (s === 'por_vencer') {
        filtered = filtered.filter((b) => b.isActive && b.membership_status === 'POR_VENCER');
      } else if (s === 'en_gracia') {
        filtered = filtered.filter((b) => b.isActive && b.membership_status === 'EN_GRACIA');
      } else if (s === 'vencido') {
        filtered = filtered.filter((b) => b.isActive && b.membership_status === 'VENCIDO');
      } else if (s === 'prueba') {
        filtered = filtered.filter((b) => b.isActive && b.is_trial);
      } else if (s === 'inactivo') {
        filtered = filtered.filter((b) => !b.isActive);
      } else if (s === 'activo') {
        filtered = filtered.filter(
          (b) => b.isActive && (isOperationallyActive(b.membership_status) || b.is_trial),
        );
      }
    }

    // Filtro por búsqueda
    if (query?.search) {
      const q = query.search.toLowerCase().trim();
      filtered = filtered.filter((b) => {
        const name = (b.name || '').toLowerCase();
        const slug = (b.slug || '').toLowerCase();
        const phone = (b.posPhone || '').toLowerCase();
        const address = (b.posAddress || '').toLowerCase();
        const id = (b.id || '').toLowerCase();
        return (
          name.includes(q) ||
          slug.includes(q) ||
          phone.includes(q) ||
          address.includes(q) ||
          id.includes(q)
        );
      });
    }

    // Filtro por tipo/vertical
    if (query?.type) {
      const t = query.type.toLowerCase().trim();
      filtered = filtered.filter((b) => {
        const bType = (b.type || '').toLowerCase();
        const bVertical = (b.posVertical || '').toLowerCase();
        const indCode = ((b.industry as any)?.code || '').toLowerCase();
        const indName = ((b.industry as any)?.name || '').toLowerCase();
        return (
          bType.includes(t) ||
          bVertical.includes(t) ||
          indCode.includes(t) ||
          indName.includes(t)
        );
      });
    }

    // Ordenamiento (por defecto due_date asc)
    const sortBy = query?.sortBy || 'due_date';
    const isDesc = query?.order?.toLowerCase() === 'desc';

    filtered.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'due_date') {
        if (!a.due_date && !b.due_date) cmp = 0;
        else if (!a.due_date) cmp = 1;
        else if (!b.due_date) cmp = -1;
        else cmp = a.due_date.localeCompare(b.due_date);
      } else if (sortBy === 'name') {
        cmp = (a.name || '').localeCompare(b.name || '');
      } else if (sortBy === 'createdAt') {
        cmp = a.createdAt.getTime() - b.createdAt.getTime();
      } else if (sortBy === 'monthly_amount') {
        cmp = a.monthly_amount - b.monthly_amount;
      } else if (sortBy === 'last_seen_at') {
        if (!a.last_seen_at && !b.last_seen_at) cmp = 0;
        else if (!a.last_seen_at) cmp = 1;
        else if (!b.last_seen_at) cmp = -1;
        else cmp = a.last_seen_at.localeCompare(b.last_seen_at);
      } else if (sortBy === 'last_sale_at') {
        if (!a.last_sale_at && !b.last_sale_at) cmp = 0;
        else if (!a.last_sale_at) cmp = 1;
        else if (!b.last_sale_at) cmp = -1;
        else cmp = a.last_sale_at.localeCompare(b.last_sale_at);
      }

      if (cmp === 0) {
        cmp = (a.name || '').localeCompare(b.name || '');
      }

      return isDesc ? -cmp : cmp;
    });

    if (query?.format === 'array') {
      return filtered;
    }

    return {
      data: filtered,
      counters,
    };
  }

  async getBusinessById(id: string) {
    this.logger.log(`[getBusinessById] Obteniendo detalle de negocio id=${id}`);

    const business = await this.prisma.business.findUnique({
      where: { id },
      include: {
        users: {
          where: { role: UserRole.ENCARGADO },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isActive: true,
            createdAt: true,
          },
        },
        orders: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            deliveryUser: {
              select: {
                id: true,
                name: true,
                phone: true,
                vehicleType: true,
              },
            },
          },
        },
        memberships: {
          include: { paymentProducts: true },
          orderBy: { endDate: 'desc' },
        },
        productSubscriptions: true,
        industry: {
          select: { id: true, code: true, name: true },
        },
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const ordersWithRiders = await this.prisma.order.findMany({
      where: {
        businessId: id,
        deliveryUserId: { not: null },
      },
      select: {
        deliveryUser: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            vehicleType: true,
            vehiclePlate: true,
            profilePhotoUrl: true,
          },
        },
      },
      distinct: ['deliveryUserId'],
    });

    const riders = ordersWithRiders
      .map((o) => o.deliveryUser)
      .filter((u): u is NonNullable<typeof u> => u !== null);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyOrders = await this.prisma.order.findMany({
      where: {
        businessId: id,
        createdAt: { gte: startOfMonth },
      },
      select: {
        status: true,
        deliveryFee: true,
      },
    });

    const ordersCreatedMonth = monthlyOrders.length;
    const ordersDeliveredMonth = monthlyOrders.filter(
      (o) => o.status === OrderStatus.ENTREGADO,
    ).length;
    const ordersCancelledMonth = monthlyOrders.filter(
      (o) => o.status === OrderStatus.CANCELADO,
    ).length;
    const deliveryRateMonth =
      ordersCreatedMonth > 0
        ? Number(((ordersDeliveredMonth / ordersCreatedMonth) * 100).toFixed(1))
        : 0;

    const activeCoveredSubIds = new Set<string>();
    for (const m of (business as any).memberships || []) {
      if (m.status === MembershipStatus.CANCELLED) continue;
      const anchor =
        business.billingAnchorDay ?? getManaguaDateParts(m.startDate).day;
      const dueDate = calculateDueDate(m.startDate, anchor);
      const graceEndsAt = calculateGraceEndsAt(dueDate);
      if (now < graceEndsAt) {
        for (const pp of m.paymentProducts || []) {
          activeCoveredSubIds.add(pp.businessProductSubscriptionId);
        }
      }
    }

    const billing = computeBusinessMembershipBilling(
      business,
      (business as any).memberships || [],
      now,
    );

    const resolvedProductSubscriptions = business.productSubscriptions.map((sub) => {
      const isRiders = business.businessType === BusinessType.EMPRESA_RIDERS;
      const isMembership = sub.productType !== BusinessProductType.DELIVERY || !isRiders;
      if (isMembership && sub.status === BusinessProductStatus.ACTIVE && !activeCoveredSubIds.has(sub.id)) {
        return {
          ...sub,
          status: BusinessProductStatus.INACTIVE,
        };
      }
      return sub;
    });

    const hasPOSActive = resolvedProductSubscriptions.some(
      (s) => s.productType === BusinessProductType.POS && s.status === BusinessProductStatus.ACTIVE,
    );
    const hasTrackDeliActive = resolvedProductSubscriptions.some(
      (s) => s.productType === BusinessProductType.DELIVERY && s.status === BusinessProductStatus.ACTIVE,
    );
    const hasCarteraActive = resolvedProductSubscriptions.some(
      (s) => s.productType === BusinessProductType.CARTERA_COBRO && s.status === BusinessProductStatus.ACTIVE,
    );
    const hasCitasActive = resolvedProductSubscriptions.some(
      (s) => s.productType === BusinessProductType.CITAS && s.status === BusinessProductStatus.ACTIVE,
    );

    const posSub = resolvedProductSubscriptions.find(
      (s) => s.productType === BusinessProductType.POS,
    );
    const maxDevices = posSub?.maxDevices ?? null;
    const activeDevices = await this.prisma.posDevice.count({
      where: { businessId: id, status: PosDeviceStatus.ACTIVE, category: 'DESKTOP' },
    });

    const userUsage = await this.userQuotaService.getUsage(id);

    return {
      id: business.id,
      name: business.name,
      type: business.type,
      logoUrl: business.logoUrl,
      latitude: business.latitude,
      longitude: business.longitude,
      defaultGeofenceRadiusM: business.defaultGeofenceRadiusM,
      isActive: business.isActive,
      posAddress: business.posAddress,
      posPhone: business.posPhone,
      currency: business.currency,
      businessType: business.businessType,
      commissionRate: business.commissionRate,
      altCommissionRate: business.altCommissionRate,
      altCommissionDistanceKm: business.altCommissionDistanceKm,
      dispatchTimeoutMin: business.dispatchTimeoutMin,
      pricingModel: business.pricingModel,
      baseRate: business.baseRate,
      ratePerKm: business.ratePerKm,
      freeZoneKm: business.freeZoneKm,
      minRate: business.minRate,
      maxRate: business.maxRate,
      pricingZones: (business as any).pricingZones ?? null,
      whatsappNumber: (business as any).whatsappNumber ?? null,
      whatsappDisplay: (business as any).whatsappDisplay ?? null,
      industryId: business.industryId,
      industry: business.industry,
      usesVariants: business.usesVariants,
      tracksBatches: business.tracksBatches,
      posVertical: business.posVertical,
      salonProfile: business.salonProfile,
      createdAt: business.createdAt,
      encargados: business.users,
      riders,
      recentOrders: business.orders,
      monthlyMetrics: {
        ordersCreated: ordersCreatedMonth,
        ordersDelivered: ordersDeliveredMonth,
        ordersCancelled: ordersCancelledMonth,
        deliveryRate: deliveryRateMonth,
      },
      productSubscriptions: resolvedProductSubscriptions,
      hasPOS: hasPOSActive,
      hasTrackDeli: hasTrackDeliActive,
      hasCarteraCobro: hasCarteraActive,
      hasCitas: hasCitasActive,
      maxDevices,
      backofficeTier: (posSub as any)?.backofficeTier ?? 'BASIC',
      trialHours: (posSub as any)?.trialHours ?? null,
      trialStartedAt: (posSub as any)?.trialStartedAt ?? null,
      trialEndsAt: (posSub as any)?.trialEndsAt ?? null,
      activeDevices,
      userUsage,
      billing_anchor_day: billing.billing_anchor_day,
      current_period_start: billing.current_period_start,
      due_date: billing.due_date,
      grace_ends_at: billing.grace_ends_at,
      membership_status: billing.membership_status,
      days_until_due: billing.days_until_due,
      membership: {
        status: billing.membership_status,
        billing_anchor_day: billing.billing_anchor_day,
        current_period_start: billing.current_period_start,
        due_date: billing.due_date,
        grace_ends_at: billing.grace_ends_at,
        days_until_due: billing.days_until_due,
        daysLeft: billing.days_until_due,
        endDate: billing.due_date_date,
      },
    };
  }

  async toggleBusiness(id: string) {
    this.logger.log(`[toggleBusiness] Cambiando estado de negocio id=${id}`);

    const business = await this.prisma.business.findUnique({
      where: { id },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const newStatus = !business.isActive;

    const updated = await this.prisma.business.update({
      where: { id },
      data: { isActive: newStatus },
    });

    if (!newStatus) {
      this.logger.warn(
        `[toggleBusiness] Negocio id=${id} desactivado. Verificando pedidos activos...`,
      );
      const activeOrdersCount = await this.prisma.order.count({
        where: {
          businessId: id,
          status: { in: ACTIVE_ORDER_STATUSES },
        },
      });
      if (activeOrdersCount > 0) {
        this.logger.warn(
          `[toggleBusiness] Negocio id=${id} tiene ${activeOrdersCount} pedidos activos en curso.`,
        );
      }
    }

    this.logger.log(
      `[toggleBusiness] OK businessId=${id}, isActive=${updated.isActive}`,
    );

    return {
      id: updated.id,
      name: updated.name,
      isActive: updated.isActive,
    };
  }

  async createBusiness(dto: CreateBusinessSuperAdminDto, createdBy: string = 'system-superadmin') {
    this.logger.log(`[createBusiness] Creando negocio '${dto.name}'`);

    let email = dto.encargado?.email;
    let plainPassword = dto.encargado?.password;
    let encargadoName = dto.encargado?.name || `Encargado ${dto.name}`;

    if (!email || !plainPassword) {
      const generated = generateBusinessCredentials(dto.name);
      email = email || generated.email;
      plainPassword = plainPassword || generated.password;
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException(`El correo '${email}' ya está registrado`);
    }

    const passwordHash = await bcrypt.hash(plainPassword, 10);
    const now = new Date();
    const isRiders = dto.businessType === BusinessType.EMPRESA_RIDERS;
    const hasDelivery = dto.hasDelivery ?? false;
    const hasPOS = dto.hasPOS ?? false;
    const hasCarteraCobro = dto.hasCarteraCobro ?? false;
    const hasCitas = dto.hasCitas ?? false;

    const webAdminEnabled = dto.webAdminEnabled !== undefined ? dto.webAdminEnabled : true;
    let webBillingEnabled = dto.webBillingEnabled !== undefined ? dto.webBillingEnabled : false;
    const maxWebDevices = dto.maxWebDevices !== undefined ? dto.maxWebDevices : 2;
    const webBillingMonthlyUsd =
      dto.webBillingMonthlyUsd !== undefined && dto.webBillingMonthlyUsd !== null
        ? Number(dto.webBillingMonthlyUsd)
        : null;

    if (hasPOS) {
      if (webBillingEnabled && !webAdminEnabled) {
        throw new BadRequestException(
          'La facturación web requiere que el acceso a la web admin esté habilitado',
        );
      }
      if (!webAdminEnabled) {
        webBillingEnabled = false;
      }
      if (webBillingMonthlyUsd !== null && webBillingMonthlyUsd < 0) {
        throw new BadRequestException(
          'La tarifa mensual de facturación web no puede ser negativa',
        );
      }
      if (maxWebDevices !== null && maxWebDevices < 0) {
        throw new BadRequestException('maxWebDevices no puede ser negativo');
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let targetIndustry: any = null;
      if (dto.industryId) {
        targetIndustry = await tx.industry.findUnique({
          where: { id: dto.industryId },
          include: { fieldTemplates: { orderBy: { order: 'asc' } } },
        });
        if (!targetIndustry) {
          throw new NotFoundException(`La industria con ID '${dto.industryId}' no existe`);
        }
      } else {
        targetIndustry = await tx.industry.findUnique({
          where: { code: 'general' },
          include: { fieldTemplates: { orderBy: { order: 'asc' } } },
        });
      }

      const resolvedPosVertical = dto.posVertical || targetIndustry?.posVertical || PosVertical.RESTAURANTE;

      const isTallerIndustry =
        targetIndustry?.code === 'taller' ||
        targetIndustry?.name?.toLowerCase().includes('taller') ||
        dto.type?.toLowerCase().includes('taller');

      const resolvedSalonProfile =
        dto.salonProfile || (isTallerIndustry ? 'TALLER' : 'RESTAURANTE');

      const business = await tx.business.create({
        data: {
          name: dto.name,
          type: dto.type || null,
          industryId: targetIndustry?.id || null,
          usesVariants: targetIndustry?.usesVariants ?? false,
          tracksBatches: dto.tracksBatches !== undefined ? dto.tracksBatches : (targetIndustry?.tracksBatches || targetIndustry?.code === 'farmacia' || false),
          businessType: dto.businessType || BusinessType.NEGOCIO,
          commissionRate: dto.commissionRate ?? 0.15,
          altCommissionRate: dto.altCommissionRate ?? 0.12,
          altCommissionDistanceKm: dto.altCommissionDistanceKm ?? 40,
          dispatchTimeoutMin: dto.dispatchTimeoutMin ?? 3,
          whatsappNumber: dto.whatsappNumber || null,
          whatsappDisplay: dto.whatsappDisplay || null,
          isActive: true,
          hasTrackDeli: hasDelivery,
          hasPOS: hasPOS,
          hasCarteraCobro: hasCarteraCobro,
          hasCitas: hasCitas,
          posVertical: resolvedPosVertical,
          salonProfile: resolvedSalonProfile,
        },
      });

      if (targetIndustry?.fieldTemplates && targetIndustry.fieldTemplates.length > 0) {
        for (const tmpl of targetIndustry.fieldTemplates) {
          await tx.productFieldDefinition.create({
            data: {
              businessId: business.id,
              key: tmpl.key,
              label: tmpl.label,
              dataType: tmpl.dataType,
              required: tmpl.required,
              options: tmpl.options as any,
              order: tmpl.order,
              searchable: tmpl.searchable,
              showInPos: tmpl.showInPos,
              isActive: true,
            },
          });
        }
      }

      const encargado = await tx.user.create({
        data: {
          name: encargadoName,
          email,
          passwordHash,
          role: UserRole.ENCARGADO,
          businessId: business.id,
          isActive: true,
        },
      });

      // 1. Activar subscripciones seleccionadas y registrar items para Membresía
      const membershipPaymentProducts: Array<{
        businessProductSubscriptionId: string;
        amountAttributed: number | null;
        productType: BusinessProductType;
      }> = [];

      // A) DELIVERY
      if (hasDelivery) {
        const deliveryFee = !isRiders
          ? (dto.deliveryMonthlyFee !== undefined && dto.deliveryMonthlyFee !== null
              ? Number(dto.deliveryMonthlyFee)
              : 35.00)
          : null;

        const deliverySub = await tx.businessProductSubscription.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.DELIVERY,
            status: BusinessProductStatus.ACTIVE,
            commissionRate: isRiders ? new Prisma.Decimal(dto.commissionRate ?? 0.15) : null,
            altCommissionRate: isRiders ? new Prisma.Decimal(dto.altCommissionRate ?? 0.12) : null,
            altCommissionDistanceKm: isRiders ? new Prisma.Decimal(dto.altCommissionDistanceKm ?? 40) : null,
            dispatchTimeoutMin: isRiders ? (dto.dispatchTimeoutMin ?? 3) : null,
            deliveryMonthlyFee: deliveryFee !== null ? new Prisma.Decimal(deliveryFee) : null,
            activatedAt: now,
            activatedBy: createdBy,
          },
        });

        await tx.businessProductAuditLog.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.DELIVERY,
            action: BusinessProductAction.ACTIVATED,
            performedBy: createdBy,
            reason: 'Activación inicial al crear negocio',
            metadata: {
              deliveryMonthlyFee: deliveryFee,
              businessType: business.businessType,
            },
          },
        });

        if (!isRiders) {
          membershipPaymentProducts.push({
            businessProductSubscriptionId: deliverySub.id,
            amountAttributed: deliveryFee,
            productType: BusinessProductType.DELIVERY,
          });
        }
      }

      // B) POS
      if (hasPOS) {
        const posFee = dto.posMonthlyFee !== undefined && dto.posMonthlyFee !== null
          ? Number(dto.posMonthlyFee)
          : DEFAULT_POS_MONTHLY_FEE;
        const posVertical = resolvedPosVertical;

        const maxDevices = dto.maxDevices !== undefined ? dto.maxDevices : 1;

        const posSub = await tx.businessProductSubscription.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.POS,
            status: BusinessProductStatus.ACTIVE,
            posVertical,
            posMonthlyFee: new Prisma.Decimal(posFee),
            maxDevices,
            webAdminEnabled,
            webBillingEnabled,
            maxWebDevices,
            webBillingMonthlyUsd: webBillingMonthlyUsd !== null ? new Prisma.Decimal(webBillingMonthlyUsd) : null,
            backofficeTier: 'BASIC',
            trialHours: dto.trialHours !== undefined ? dto.trialHours : null,
            activatedAt: now,
            activatedBy: createdBy,
          } as any,
        });

        await tx.businessProductAuditLog.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.POS,
            action: BusinessProductAction.ACTIVATED,
            performedBy: createdBy,
            reason: 'Activación inicial al crear negocio',
            metadata: {
              posVertical,
              posMonthlyFee: posFee,
              maxDevices,
              webAdminEnabled,
              webBillingEnabled,
              maxWebDevices,
              webBillingMonthlyUsd,
            },
          },
        });

        membershipPaymentProducts.push({
          businessProductSubscriptionId: posSub.id,
          amountAttributed: posFee,
          productType: BusinessProductType.POS,
        });
      }

      // C) CARTERA_COBRO
      if (hasCarteraCobro) {
        const carteraFee = dto.carteraMonthlyFee !== undefined && dto.carteraMonthlyFee !== null
          ? Number(dto.carteraMonthlyFee)
          : 30;

        const carteraSub = await tx.businessProductSubscription.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.CARTERA_COBRO,
            status: BusinessProductStatus.ACTIVE,
            carteraMonthlyFee: new Prisma.Decimal(carteraFee),
            activatedAt: now,
            activatedBy: createdBy,
          },
        });

        await tx.businessProductAuditLog.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.CARTERA_COBRO,
            action: BusinessProductAction.ACTIVATED,
            performedBy: createdBy,
            reason: 'Activación inicial al crear negocio',
            metadata: {
              carteraMonthlyFee: carteraFee,
            },
          },
        });

        membershipPaymentProducts.push({
          businessProductSubscriptionId: carteraSub.id,
          amountAttributed: carteraFee,
          productType: BusinessProductType.CARTERA_COBRO,
        });
      }

      // D) CITAS
      if (hasCitas) {
        const citasFee = dto.citasMonthlyFee !== undefined && dto.citasMonthlyFee !== null
          ? Number(dto.citasMonthlyFee)
          : 25.00;

        const citasSub = await tx.businessProductSubscription.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.CITAS,
            status: BusinessProductStatus.ACTIVE,
            citasMonthlyFee: new Prisma.Decimal(citasFee),
            activatedAt: now,
            activatedBy: createdBy,
          },
        });

        await tx.businessProductAuditLog.create({
          data: {
            businessId: business.id,
            productType: BusinessProductType.CITAS,
            action: BusinessProductAction.ACTIVATED,
            performedBy: createdBy,
            reason: 'Activación inicial al crear negocio',
            metadata: {
              citasMonthlyFee: citasFee,
            },
          },
        });

        membershipPaymentProducts.push({
          businessProductSubscriptionId: citasSub.id,
          amountAttributed: citasFee,
          productType: BusinessProductType.CITAS,
        });
      }

      // Asegurar que existan los 4 registros de suscripción para el negocio (INACTIVE si no se seleccionaron)
      for (const prodType of [BusinessProductType.DELIVERY, BusinessProductType.POS, BusinessProductType.CARTERA_COBRO, BusinessProductType.CITAS]) {
        const exists = await tx.businessProductSubscription.findUnique({
          where: { businessId_productType: { businessId: business.id, productType: prodType } },
        });
        if (!exists) {
          await tx.businessProductSubscription.create({
            data: {
              businessId: business.id,
              productType: prodType,
              status: BusinessProductStatus.INACTIVE,
              posVertical: prodType === BusinessProductType.POS ? PosVertical.RESTAURANTE : null,
              maxDevices: prodType === BusinessProductType.POS ? (dto.maxDevices !== undefined ? dto.maxDevices : 1) : null,
            },
          });
        }
      }

      // 2. Registro automático de Membresía si hay al menos un producto de membresía
      let membership = null;
      if (membershipPaymentProducts.length > 0) {
        const totalAmount = membershipPaymentProducts.reduce(
          (acc, p) => acc + (p.amountAttributed || 0),
          0,
        );

        const nowParts = getManaguaDateParts(now);
        const anchorDay = business.billingAnchorDay ?? nowParts.day;
        const startDate = createManaguaDate(nowParts.year, nowParts.month, nowParts.day, 0, 0, 0, 0);
        const endDate = calculateDueDate(startDate, anchorDay);

        membership = await tx.membership.create({
          data: {
            businessId: business.id,
            startDate,
            endDate,
            amount: totalAmount,
            currency: 'USD',
            paymentMethod: PaymentMethod.OTRO,
            paidAt: now,
            notes: 'Alta inicial del negocio y activación de productos',
            status: MembershipStatus.ACTIVE,
            createdBy,
            paymentProducts: {
              create: membershipPaymentProducts.map((item) => ({
                businessProductSubscriptionId: item.businessProductSubscriptionId,
                amountAttributed:
                  item.amountAttributed !== null
                    ? new Prisma.Decimal(item.amountAttributed)
                    : null,
              })),
            },
          },
          include: {
            paymentProducts: {
              include: {
                businessProductSubscription: {
                  select: { id: true, productType: true, status: true },
                },
              },
            },
          },
        });

        await tx.business.update({
          where: { id: business.id },
          data: { billingAnchorDay: anchorDay },
        });

        this.logger.log(
          `[createBusiness] Membresía inicial creada id=${membership.id}, monto=$${totalAmount}, productos=${membershipPaymentProducts.length}`,
        );
      }

      return { business, encargado, membership };
    });

    this.logger.log(
      `[createBusiness] OK negocio creado id=${result.business.id}, encargado=${result.encargado.id} (email=${email})`,
    );

    return {
      business: {
        id: result.business.id,
        name: result.business.name,
        type: result.business.type,
        businessType: result.business.businessType,
        commissionRate: result.business.commissionRate,
        altCommissionRate: result.business.altCommissionRate,
        altCommissionDistanceKm: result.business.altCommissionDistanceKm,
        dispatchTimeoutMin: result.business.dispatchTimeoutMin,
        isActive: result.business.isActive,
        createdAt: result.business.createdAt,
        salonProfile: result.business.salonProfile,
        maxDevices: dto.maxDevices !== undefined ? dto.maxDevices : 1,
        webAdminEnabled: hasPOS ? webAdminEnabled : false,
        webBillingEnabled: hasPOS ? webBillingEnabled : false,
        maxWebDevices: hasPOS ? maxWebDevices : null,
        webBillingMonthlyUsd: hasPOS ? webBillingMonthlyUsd : null,
        trialHours: dto.trialHours !== undefined ? dto.trialHours : null,
      },
      encargado: {
        id: result.encargado.id,
        name: result.encargado.name,
        email: result.encargado.email,
        temporaryPassword: plainPassword,
        role: result.encargado.role,
        isActive: result.encargado.isActive,
      },
      membership: result.membership ? this.formatMembershipWithProducts(result.membership, result.business.billingAnchorDay ?? undefined) : null,
    };
  }

  async updateBusiness(id: string, dto: UpdateBusinessDto) {
    this.logger.log(`[updateBusiness] Actualizando negocio id=${id}`);
    const business = await this.prisma.business.findUnique({
      where: { id },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    let targetIndustry: any = null;
    let updatePosVertical = dto.posVertical;

    if (dto.industryId !== undefined && dto.industryId !== business.industryId) {
      if (dto.industryId !== null) {
        targetIndustry = await this.prisma.industry.findUnique({
          where: { id: dto.industryId },
          include: { fieldTemplates: { orderBy: { order: 'asc' } } },
        });
        if (!targetIndustry) {
          throw new NotFoundException(`La industria '${dto.industryId}' no existe`);
        }

        // Si no se proporcionó posVertical explícitamente, tomamos el de la industria
        if (updatePosVertical === undefined) {
          updatePosVertical = targetIndustry.posVertical;
        }

        const activeCount = await this.prisma.productFieldDefinition.count({
          where: { businessId: id, isActive: true },
        });
        const existingKeys = (
          await this.prisma.productFieldDefinition.findMany({
            where: { businessId: id },
            select: { key: true },
          })
        ).map((f) => f.key);

        let remainingSlots = 15 - activeCount;
        for (const tmpl of targetIndustry.fieldTemplates) {
          if (!existingKeys.includes(tmpl.key) && remainingSlots > 0) {
            await this.prisma.productFieldDefinition.create({
              data: {
                businessId: id,
                key: tmpl.key,
                label: tmpl.label,
                dataType: tmpl.dataType,
                required: tmpl.required,
                options: tmpl.options as any,
                order: tmpl.order,
                searchable: tmpl.searchable,
                showInPos: tmpl.showInPos,
                isActive: true,
              },
            });
            remainingSlots--;
          }
        }
      } else {
        // Si se quita la industria, se podría opcionalmente resetear usesVariants/tracksBatches
        // pero por ahora lo dejamos intacto.
      }
    }

    const addressToUpdate = dto.posAddress !== undefined ? dto.posAddress : dto.address;
    const phoneToUpdate = dto.posPhone !== undefined ? dto.posPhone : dto.phone;
    const logoToUpdate = dto.logoUrl !== undefined ? dto.logoUrl : dto.logo;

    if (dto.tracksBatches === false) {
      const activeBatchesCount = await this.prisma.productBatch.count({
        where: { businessId: id, quantity: { gt: 0 } },
      });
      if (activeBatchesCount > 0 && dto.confirm !== true) {
        throw new BadRequestException(
          'El negocio tiene lotes con existencias activas. Para desactivar el control de lotes confirme la acción.',
        );
      }
    }

    const updated = await this.prisma.business.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.industryId !== undefined && { industryId: dto.industryId }),
        ...(logoToUpdate !== undefined && { logoUrl: logoToUpdate }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
        ...(dto.defaultGeofenceRadiusM !== undefined && { defaultGeofenceRadiusM: dto.defaultGeofenceRadiusM }),
        ...(dto.pricingModel !== undefined && { pricingModel: dto.pricingModel }),
        ...(dto.baseRate !== undefined && { baseRate: dto.baseRate }),
        ...(dto.ratePerKm !== undefined && { ratePerKm: dto.ratePerKm }),
        ...(dto.freeZoneKm !== undefined && { freeZoneKm: dto.freeZoneKm }),
        ...(dto.minRate !== undefined && { minRate: dto.minRate }),
        ...(dto.maxRate !== undefined && { maxRate: dto.maxRate }),
        ...(dto.whatsappNumber !== undefined && { whatsappNumber: dto.whatsappNumber }),
        ...(dto.whatsappDisplay !== undefined && { whatsappDisplay: dto.whatsappDisplay }),
        ...(dto.businessType !== undefined && { businessType: dto.businessType }),
        ...(dto.commissionRate !== undefined && { commissionRate: dto.commissionRate }),
        ...(dto.altCommissionRate !== undefined && { altCommissionRate: dto.altCommissionRate }),
        ...(dto.altCommissionDistanceKm !== undefined && { altCommissionDistanceKm: dto.altCommissionDistanceKm }),
        ...(dto.dispatchTimeoutMin !== undefined && { dispatchTimeoutMin: dto.dispatchTimeoutMin }),
        ...(updatePosVertical !== undefined && { posVertical: updatePosVertical }),
        ...(targetIndustry !== null && { usesVariants: targetIndustry.usesVariants }),
        ...(targetIndustry !== null && { tracksBatches: targetIndustry.tracksBatches }),
        ...(dto.tracksBatches !== undefined && { tracksBatches: dto.tracksBatches }),
        ...(addressToUpdate !== undefined && { posAddress: addressToUpdate }),
        ...(phoneToUpdate !== undefined && { posPhone: phoneToUpdate }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    if (updatePosVertical !== undefined) {
      await this.prisma.businessProductSubscription.updateMany({
        where: { businessId: id, productType: BusinessProductType.POS },
        data: { posVertical: updatePosVertical },
      });
    }

    this.logger.log(`[updateBusiness] OK negocio actualizado id=${id}, businessType=${updated.businessType}`);
    return updated;
  }

  async getRiders() {
    this.logger.log('[getRiders] Obteniendo lista de repartidores independientes');

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const riders = await this.prisma.user.findMany({
      where: {
        role: UserRole.REPARTIDOR,
        businessId: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        vehicleType: true,
        vehiclePlate: true,
        vehicleColor: true,
        profilePhotoUrl: true,
        isAvailable: true,
        isActive: true,
        createdAt: true,
        currentLatitude: true,
        currentLongitude: true,
        lastLocationAt: true,
        deliveredOrders: {
          where: { status: OrderStatus.ENTREGADO },
          select: {
            id: true,
            deliveredAt: true,
            rating: {
              select: { stars: true },
            },
          },
          orderBy: { deliveredAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return riders.map((r) => {
      const totalDeliveries = r.deliveredOrders.length;
      const deliveriesToday = r.deliveredOrders.filter(
        (o) => o.deliveredAt && o.deliveredAt >= startOfDay,
      ).length;

      const ratings = r.deliveredOrders
        .map((o) => o.rating?.stars)
        .filter((s): s is number => typeof s === 'number');

      const averageRating =
        ratings.length > 0
          ? Number(
            (ratings.reduce((acc, curr) => acc + curr, 0) / ratings.length).toFixed(
              1,
            ),
          )
          : null;

      const lastDeliveryAt = r.deliveredOrders[0]?.deliveredAt || null;

      const { deliveredOrders, ...riderData } = r;

      return {
        ...riderData,
        totalDeliveries,
        deliveriesToday,
        averageRating,
        lastDeliveryAt,
      };
    });
  }

  async toggleRider(id: string) {
    this.logger.log(`[toggleRider] Cambiando estado de repartidor id=${id}`);

    const rider = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!rider || rider.role !== UserRole.REPARTIDOR) {
      throw new NotFoundException('Repartidor no encontrado');
    }

    const newStatus = !rider.isActive;

    if (!newStatus) {

      const activeOrder = await this.prisma.order.findFirst({
        where: {
          deliveryUserId: id,
          status: { in: ACTIVE_ORDER_STATUSES },
        },
      });

      if (activeOrder) {
        throw new ConflictException(
          'No se puede desactivar el repartidor porque tiene pedidos activos en curso',
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: { isActive: newStatus },
    });

    this.logger.log(`[toggleRider] OK riderId=${id}, isActive=${updated.isActive}`);

    return {
      id: updated.id,
      name: updated.name,
      isActive: updated.isActive,
    };
  }

  async getActiveRiders() {
    this.logger.log('[getActiveRiders] Obteniendo repartidores activos en tiempo real');

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const riders = await this.prisma.user.findMany({
      where: {
        role: UserRole.REPARTIDOR,
        isActive: true,
        isAvailable: true,
        lastLocationAt: { gte: fiveMinutesAgo },
      },
      select: {
        id: true,
        name: true,
        vehicleType: true,
        currentLatitude: true,
        currentLongitude: true,
        lastLocationAt: true,
        deliveredOrders: {
          where: {
            status: { in: ACTIVE_ORDER_STATUSES },
          },
          select: {
            id: true,
            status: true,
            customerName: true,
            business: {
              select: { name: true },
            },
          },
          take: 1,
        },
      },
    });

    return riders.map((r) => ({
      id: r.id,
      name: r.name,
      vehicleType: r.vehicleType,
      currentLatitude: r.currentLatitude,
      currentLongitude: r.currentLongitude,
      lastLocationAt: r.lastLocationAt,
      currentOrder: r.deliveredOrders[0]
        ? {
          id: r.deliveredOrders[0].id,
          status: r.deliveredOrders[0].status,
          customerName: r.deliveredOrders[0].customerName,
          businessName: r.deliveredOrders[0].business.name,
        }
        : null,
    }));
  }

  async getGlobalMetrics() {
    this.logger.log('[getGlobalMetrics] Calculando dashboard de métricas globales');

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      businessesTotal,
      businessesActive,
      ridersTotal,
      ridersActive,
      ordersAllTime,
    ] = await Promise.all([
      this.prisma.business.count(),
      this.prisma.business.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { role: UserRole.REPARTIDOR } }),
      this.prisma.user.count({
        where: {
          role: UserRole.REPARTIDOR,
          isActive: true,
          isAvailable: true,
        },
      }),
      this.prisma.order.count(),
    ]);

    const [
      ordersCreatedToday,
      ordersDeliveredToday,
      ordersCancelledToday,
      ordersActiveToday,
      newRidersToday,
    ] = await Promise.all([
      this.prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.order.count({
        where: {
          status: OrderStatus.ENTREGADO,
          deliveredAt: { gte: startOfDay },
        },
      }),
      this.prisma.order.count({
        where: {
          status: OrderStatus.CANCELADO,
          createdAt: { gte: startOfDay },
        },
      }),
      this.prisma.order.count({
        where: { status: { in: ACTIVE_ORDER_STATUSES } },
      }),
      this.prisma.user.count({
        where: {
          role: UserRole.REPARTIDOR,
          createdAt: { gte: startOfDay },
        },
      }),
    ]);

    const last30DaysOrders = await this.prisma.order.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: {
        id: true,
        status: true,
        createdAt: true,
        takenAt: true,
        deliveredAt: true,
        businessId: true,
        business: { select: { name: true } },
        deliveryUserId: true,
        deliveryUser: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const ordersCreated30 = last30DaysOrders.length;
    const ordersDelivered30 = last30DaysOrders.filter(
      (o) => o.status === OrderStatus.ENTREGADO,
    ).length;
    const ordersCancelled30 = last30DaysOrders.filter(
      (o) => o.status === OrderStatus.CANCELADO,
    ).length;

    const deliveryRate30 =
      ordersCreated30 > 0
        ? Number(((ordersDelivered30 / ordersCreated30) * 100).toFixed(1))
        : 0;

    const deliveredWithTimes = last30DaysOrders.filter(
      (o) => o.status === OrderStatus.ENTREGADO && o.deliveredAt,
    );

    let avgDeliveryTimeMinutes = 0;
    if (deliveredWithTimes.length > 0) {
      const totalMinutes = deliveredWithTimes.reduce((sum, o) => {
        const startTime = o.takenAt ? o.takenAt.getTime() : o.createdAt.getTime();
        const diffMs = o.deliveredAt!.getTime() - startTime;
        return sum + Math.max(0, diffMs / (1000 * 60));
      }, 0);
      avgDeliveryTimeMinutes = Math.round(totalMinutes / deliveredWithTimes.length);
    }

    const businessOrderCountMap: Record<
      string,
      { id: string; name: string; ordersCount: number }
    > = {};
    for (const o of last30DaysOrders) {
      if (!businessOrderCountMap[o.businessId]) {
        businessOrderCountMap[o.businessId] = {
          id: o.businessId,
          name: o.business.name,
          ordersCount: 0,
        };
      }
      businessOrderCountMap[o.businessId].ordersCount++;
    }
    const topBusinesses = Object.values(businessOrderCountMap)
      .sort((a, b) => b.ordersCount - a.ordersCount)
      .slice(0, 5);

    const riderDeliveriesMap: Record<
      string,
      { id: string; name: string; deliveriesCount: number }
    > = {};
    for (const o of last30DaysOrders) {
      if (o.status === OrderStatus.ENTREGADO && o.deliveryUserId && o.deliveryUser) {
        if (!riderDeliveriesMap[o.deliveryUserId]) {
          riderDeliveriesMap[o.deliveryUserId] = {
            id: o.deliveryUserId,
            name: o.deliveryUser.name,
            deliveriesCount: 0,
          };
        }
        riderDeliveriesMap[o.deliveryUserId].deliveriesCount++;
      }
    }

    const topRidersList = Object.values(riderDeliveriesMap)
      .sort((a, b) => b.deliveriesCount - a.deliveriesCount)
      .slice(0, 5);

    const topRiders = await Promise.all(
      topRidersList.map(async (r) => {
        const ratingAgg = await this.prisma.rating.aggregate({
          where: { order: { deliveryUserId: r.id } },
          _avg: { stars: true },
        });
        return {
          ...r,
          averageRating: ratingAgg._avg.stars
            ? Number(ratingAgg._avg.stars.toFixed(1))
            : null,
        };
      }),
    );

    const ordersPerDayMap: Record<string, { created: number; delivered: number }> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      ordersPerDayMap[dateStr] = { created: 0, delivered: 0 };
    }

    for (const o of last30DaysOrders) {
      const createdDateStr = o.createdAt.toISOString().split('T')[0];
      if (ordersPerDayMap[createdDateStr]) {
        ordersPerDayMap[createdDateStr].created++;
      }
      if (o.status === OrderStatus.ENTREGADO && o.deliveredAt) {
        const deliveredDateStr = o.deliveredAt.toISOString().split('T')[0];
        if (ordersPerDayMap[deliveredDateStr]) {
          ordersPerDayMap[deliveredDateStr].delivered++;
        }
      }
    }

    const ordersPerDay = Object.entries(ordersPerDayMap).map(([date, counts]) => ({
      date,
      created: counts.created,
      delivered: counts.delivered,
    }));

    return {
      totals: {
        businesses: businessesTotal,
        businessesActive,
        riders: ridersTotal,
        ridersActive,
        ordersAllTime,
      },
      today: {
        ordersCreated: ordersCreatedToday,
        ordersDelivered: ordersDeliveredToday,
        ordersCancelled: ordersCancelledToday,
        ordersActive: ordersActiveToday,
        newRiders: newRidersToday,
      },
      last30Days: {
        ordersCreated: ordersCreated30,
        ordersDelivered: ordersDelivered30,
        ordersCancelled: ordersCancelled30,
        deliveryRate: deliveryRate30,
        avgDeliveryTimeMinutes,
      },
      topBusinesses,
      topRiders,
      ordersPerDay,
    };
  }

  async getOrdersMetrics(query: OrdersMetricsQueryDto) {
    this.logger.log(`[getOrdersMetrics] Filtros: ${JSON.stringify(query)}`);

    const where: any = {};

    if (query.businessId) {
      where.businessId = query.businessId;
    }

    if (query.riderId) {
      where.deliveryUserId = query.riderId;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) {
        where.createdAt.gte = new Date(query.from);
      }
      if (query.to) {
        const toDate = new Date(query.to);
        toDate.setHours(23, 59, 59, 999);
        where.createdAt.lte = toDate;
      }
    }

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: {
          business: { select: { id: true, name: true } },
          deliveryUser: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    let totalDeliveryFees = 0;

    for (const o of orders) {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
      totalDeliveryFees += Number(o.deliveryFee || 0);
    }

    return {
      total,
      statusCounts,
      totalDeliveryFees: Number(totalDeliveryFees.toFixed(2)),
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        destinationAddress: o.destinationAddress,
        deliveryFee: Number(o.deliveryFee),
        businessId: o.businessId,
        businessName: o.business.name,
        deliveryUserId: o.deliveryUserId,
        riderName: o.deliveryUser?.name || null,
        createdAt: o.createdAt,
        takenAt: o.takenAt,
        deliveredAt: o.deliveredAt,
      })),
    };
  }

  async getRecentLogs() {
    this.logger.log('[getRecentLogs] Obteniendo últimas 100 actividades del sistema');

    const recentOrders = await this.prisma.order.findMany({
      take: 60,
      orderBy: { createdAt: 'desc' },
      include: {
        business: { select: { name: true } },
        deliveryUser: { select: { name: true } },
      },
    });

    const recentRiders = await this.prisma.user.findMany({
      where: { role: UserRole.REPARTIDOR },
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
      },
    });

    const recentBusinesses = await this.prisma.business.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
      },
    });

    const logs: Array<{
      id: string;
      type:
      | 'ORDER_CREATED'
      | 'ORDER_DELIVERED'
      | 'ORDER_CANCELLED'
      | 'RIDER_REGISTERED'
      | 'BUSINESS_CREATED'
      | 'INCIDENCIA';
      description: string;
      businessName: string | null;
      riderName: string | null;
      orderId: string | null;
      createdAt: Date;
    }> = [];

    for (const o of recentOrders) {
      if (o.status === OrderStatus.ENTREGADO && o.deliveredAt) {
        logs.push({
          id: `log-delivered-${o.id}`,
          type: 'ORDER_DELIVERED',
          description: `${o.deliveryUser?.name || 'Repartidor'} entregó pedido de ${o.customerName} en ${o.business.name}`,
          businessName: o.business.name,
          riderName: o.deliveryUser?.name || null,
          orderId: o.id,
          createdAt: o.deliveredAt,
        });
      } else if (o.status === OrderStatus.CANCELADO) {
        logs.push({
          id: `log-cancelled-${o.id}`,
          type: 'ORDER_CANCELLED',
          description: `Pedido de ${o.customerName} en ${o.business.name} fue cancelado`,
          businessName: o.business.name,
          riderName: o.deliveryUser?.name || null,
          orderId: o.id,
          createdAt: o.createdAt,
        });
      } else if (o.status === OrderStatus.INCIDENCIA) {
        logs.push({
          id: `log-incidencia-${o.id}`,
          type: 'INCIDENCIA',
          description: `Incidencia reportada en pedido de ${o.customerName} (${o.business.name})`,
          businessName: o.business.name,
          riderName: o.deliveryUser?.name || null,
          orderId: o.id,
          createdAt: o.createdAt,
        });
      } else {
        logs.push({
          id: `log-created-${o.id}`,
          type: 'ORDER_CREATED',
          description: `Nuevo pedido creado para ${o.customerName} en ${o.business.name}`,
          businessName: o.business.name,
          riderName: o.deliveryUser?.name || null,
          orderId: o.id,
          createdAt: o.createdAt,
        });
      }
    }

    for (const r of recentRiders) {
      logs.push({
        id: `log-rider-${r.id}`,
        type: 'RIDER_REGISTERED',
        description: `Nuevo repartidor registrado: ${r.name}`,
        businessName: null,
        riderName: r.name,
        orderId: null,
        createdAt: r.createdAt,
      });
    }

    for (const b of recentBusinesses) {
      logs.push({
        id: `log-biz-${b.id}`,
        type: 'BUSINESS_CREATED',
        description: `Nuevo negocio registrado: ${b.name}`,
        businessName: b.name,
        riderName: null,
        orderId: null,
        createdAt: b.createdAt,
      });
    }

    logs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return logs.slice(0, 100);
  }

  private formatMembershipWithProducts(membership: any, anchorDay?: number) {
    const paymentProducts = membership.paymentProducts || [];
    const products = paymentProducts.map((pp: any) => {
      const type = pp.businessProductSubscription?.productType;
      const name =
        type === 'DELIVERY'
          ? 'Delivery'
          : type === 'POS'
          ? 'POS'
          : type === 'CARTERA_COBRO'
          ? 'Cartera de Cobro'
          : type || 'Desconocido';

      return {
        id: pp.id,
        businessProductSubscriptionId: pp.businessProductSubscriptionId,
        productType: type,
        name,
        amountAttributed:
          pp.amountAttributed !== null && pp.amountAttributed !== undefined
            ? Number(pp.amountAttributed)
            : null,
      };
    });

    const anchor =
      anchorDay ??
      membership.business?.billingAnchorDay ??
      (membership.paidAt
        ? getManaguaDateParts(new Date(membership.paidAt)).day
        : membership.startDate
        ? getManaguaDateParts(new Date(membership.startDate)).day
        : 1);
    const startDate = membership.startDate
      ? new Date(membership.startDate)
      : new Date();
    const dueDate = calculateDueDate(startDate, anchor);
    const graceEndsAt = calculateGraceEndsAt(dueDate);

    return {
      ...membership,
      isUnitemized: products.length === 0,
      products,
      billing_anchor_day: anchor,
      current_period_start: toManaguaDateString(startDate),
      due_date: toManaguaDateString(dueDate),
      grace_ends_at: graceEndsAt.toISOString(),
    };
  }

  async createMembership(dto: CreateMembershipDto, createdBy: string) {
    this.logger.log(
      `[createMembership] Registrando membresía para negocio=${dto.businessId}, monto=${dto.amount} ${dto.currency || 'USD'}`,
    );

    const business = await this.prisma.business.findUnique({
      where: { id: dto.businessId },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    let anchorDay = business.billingAnchorDay;
    if (!anchorDay) {
      const oldest = await this.prisma.membership.findFirst({
        where: { businessId: dto.businessId },
        orderBy: { startDate: 'asc' },
      });
      const anchorSource = oldest
        ? (oldest.paidAt ?? oldest.startDate)
        : (parseManaguaDate(dto.paidAt) || parseManaguaDate(dto.startDate) || new Date());
      anchorDay = getManaguaDateParts(anchorSource).day;
    }

    // Regla 2: Un pago tardío NO mueve el ancla. Si paga el 12 de noviembre, el nuevo período sigue siendo 10 nov -> 10 dic.
    const latest = await this.prisma.membership.findFirst({
      where: { businessId: dto.businessId },
      orderBy: { endDate: 'desc' },
    });

    let newStartDate: Date;
    let newEndDate: Date;

    if (latest) {
      const prevDue = calculateDueDate(latest.startDate, anchorDay);
      newStartDate = prevDue;
      newEndDate = calculateDueDate(newStartDate, anchorDay);
    } else {
      const paidDate =
        parseManaguaDate(dto.paidAt) ||
        parseManaguaDate(dto.startDate) ||
        new Date();
      const pParts = getManaguaDateParts(paidDate);
      newStartDate = createManaguaDate(pParts.year, pParts.month, pParts.day, 0, 0, 0, 0);
      newEndDate = calculateDueDate(newStartDate, anchorDay);
    }

    // Normalizar lista de productos
    const productItems: Array<{ businessProductSubscriptionId: string; amountAttributed?: number }> = [];

    if (Array.isArray(dto.products) && dto.products.length > 0) {
      for (const p of dto.products) {
        if (p.businessProductSubscriptionId) {
          productItems.push({
            businessProductSubscriptionId: p.businessProductSubscriptionId,
            amountAttributed: p.amountAttributed !== undefined ? p.amountAttributed : undefined,
          });
        }
      }
    } else {
      const rawIds = dto.businessProductSubscriptionIds || dto.businessProductSubscriptionId || [];
      for (const id of rawIds) {
        if (id && !productItems.some((item) => item.businessProductSubscriptionId === id)) {
          productItems.push({ businessProductSubscriptionId: id });
        }
      }
    }

    // Validar que todas las suscripciones pertenezcan al negocio
    if (productItems.length > 0) {
      const subIds = productItems.map((p) => p.businessProductSubscriptionId);
      const validSubs = await this.prisma.businessProductSubscription.findMany({
        where: {
          id: { in: subIds },
          businessId: dto.businessId,
        },
      });

      if (validSubs.length !== subIds.length) {
        throw new BadRequestException(
          'Una o más suscripciones de producto no existen o no pertenecen a este negocio.',
        );
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.create({
        data: {
          businessId: dto.businessId,
          startDate: newStartDate,
          endDate: newEndDate,
          amount: dto.amount,
          currency: dto.currency || 'USD',
          paymentMethod: dto.paymentMethod || 'TRANSFERENCIA',
          paidAt: parseManaguaDate(dto.paidAt) || new Date(),
          notes: dto.notes,
          status: dto.status || MembershipStatus.ACTIVE,
          createdBy,
          paymentProducts: productItems.length > 0
            ? {
                create: productItems.map((item) => ({
                  businessProductSubscriptionId: item.businessProductSubscriptionId,
                  amountAttributed:
                    item.amountAttributed !== undefined && item.amountAttributed !== null
                      ? new Prisma.Decimal(item.amountAttributed)
                      : null,
                })),
              }
            : undefined,
        },
        include: {
          business: {
            select: { id: true, name: true, logoUrl: true, billingAnchorDay: true },
          },
          paymentProducts: {
            include: {
              businessProductSubscription: {
                select: { id: true, productType: true, status: true },
              },
            },
          },
        },
      });

      if (!business.billingAnchorDay) {
        await tx.business.update({
          where: { id: dto.businessId },
          data: { billingAnchorDay: anchorDay },
        });
      }

      // Si la membresía está ACTIVE y no ha vencido su período de gracia, activar productos
      const now = new Date();
      const dueDate = calculateDueDate(membership.startDate, anchorDay);
      const graceEndsAt = calculateGraceEndsAt(dueDate);

      if (membership.status === MembershipStatus.ACTIVE && now < graceEndsAt) {
        for (const item of productItems) {
          const sub = await tx.businessProductSubscription.findUnique({
            where: { id: item.businessProductSubscriptionId },
          });

          if (sub) {
            await tx.businessProductSubscription.update({
              where: { id: sub.id },
              data: {
                status: BusinessProductStatus.ACTIVE,
                activatedAt: now,
                deactivatedAt: null,
                deactivatedBy: null,
                autoRenew: true,
                renewalCanceledAt: null,
              },
            });

            await tx.businessProductAuditLog.create({
              data: {
                businessId: dto.businessId,
                productType: sub.productType,
                action: BusinessProductAction.ACTIVATED,
                performedBy: createdBy,
                reason: 'Activación automática por registro de pago de membresía',
                metadata: {
                  membershipId: membership.id,
                  amountAttributed: item.amountAttributed,
                },
              },
            });

            if (sub.productType === BusinessProductType.POS) {
              await tx.business.update({ where: { id: dto.businessId }, data: { hasPOS: true } });
            } else if (sub.productType === BusinessProductType.CARTERA_COBRO) {
              await tx.business.update({ where: { id: dto.businessId }, data: { hasCarteraCobro: true } });
            } else if (sub.productType === BusinessProductType.CITAS) {
              await tx.business.update({ where: { id: dto.businessId }, data: { hasCitas: true } });
            } else if (sub.productType === BusinessProductType.DELIVERY) {
              await tx.business.update({ where: { id: dto.businessId }, data: { hasTrackDeli: true } });
            }
          }
        }
      }

      return membership;
    });

    this.logger.log(`[createMembership] OK membresía creada id=${result.id} (productos: ${productItems.length})`);
    return this.formatMembershipWithProducts(result, anchorDay);
  }

  async uploadPaymentProof(id: string, file: Express.Multer.File) {
    this.logger.log(`[uploadPaymentProof] Subiendo comprobante para membresía id=${id}`);

    const membership = await this.prisma.membership.findUnique({
      where: { id },
    });

    if (!membership) {
      throw new NotFoundException('Membresía no encontrada');
    }

    if (!file) {
      throw new BadRequestException('Archivo de comprobante no proporcionado');
    }

    const proofUrl = await this.uploadService.uploadPhoto(file, `memberships/${id}`);

    const updated = await this.prisma.membership.update({
      where: { id },
      data: { paymentProofUrl: proofUrl },
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true },
        },
        paymentProducts: {
          include: {
            businessProductSubscription: {
              select: { id: true, productType: true, status: true },
            },
          },
        },
      },
    });

    this.logger.log(`[uploadPaymentProof] OK comprobante subido: ${proofUrl}`);

    return {
      url: proofUrl,
      membership: this.formatMembershipWithProducts(updated),
    };
  }

  async getMemberships(query: MembershipsQueryDto) {
    this.logger.log(`[getMemberships] Filtros: ${JSON.stringify(query)}`);

    const where: any = {};

    if (query.businessId) {
      where.businessId = query.businessId;
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.expiringSoon === 'true' || query.expiringSoon === (true as any)) {
      const now = new Date();
      const inFiveDays = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
      where.status = MembershipStatus.ACTIVE;
      where.endDate = {
        gte: now,
        lte: inFiveDays,
      };
    }

    const memberships = await this.prisma.membership.findMany({
      where,
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true },
        },
        paymentProducts: {
          include: {
            businessProductSubscription: {
              select: { id: true, productType: true, status: true },
            },
          },
        },
      },
      orderBy: { endDate: 'desc' },
    });

    return memberships.map((m) => this.formatMembershipWithProducts(m));
  }

  async getExpiringMemberships() {
    this.logger.log('[getExpiringMemberships] Obteniendo membresías que vencen en 7 días');

    const now = new Date();
    const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const expiring = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
        endDate: {
          gte: now,
          lte: inSevenDays,
        },
      },
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true },
        },
        paymentProducts: {
          include: {
            businessProductSubscription: {
              select: { id: true, productType: true, status: true },
            },
          },
        },
      },
      orderBy: { endDate: 'asc' },
    });

    return expiring.map((m) => {
      const daysLeft = Math.max(
        0,
        Math.ceil((m.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      );
      const formatted = this.formatMembershipWithProducts(m);
      return {
        ...formatted,
        daysLeft,
      };
    });
  }

  async updateMembership(id: string, dto: UpdateMembershipDto) {
    this.logger.log(`[updateMembership] Actualizando membresía id=${id}`);

    const membership = await this.prisma.membership.findUnique({
      where: { id },
    });

    if (!membership) {
      throw new NotFoundException('Membresía no encontrada');
    }

    const updated = await this.prisma.membership.update({
      where: { id },
      data: {
        ...(dto.startDate !== undefined && { startDate: new Date(dto.startDate) }),
        ...(dto.endDate !== undefined && { endDate: new Date(dto.endDate) }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.paymentMethod !== undefined && { paymentMethod: dto.paymentMethod }),
        ...(dto.paidAt !== undefined && { paidAt: new Date(dto.paidAt) }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true },
        },
        paymentProducts: {
          include: {
            businessProductSubscription: {
              select: { id: true, productType: true, status: true },
            },
          },
        },
      },
    });

    this.logger.log(`[updateMembership] OK membresía actualizada id=${id}`);
    return this.formatMembershipWithProducts(updated);
  }

  async getBusinessMemberships(businessId: string) {
    this.logger.log(`[getBusinessMemberships] Obteniendo historial para businessId=${businessId}`);

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const memberships = await this.prisma.membership.findMany({
      where: { businessId },
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true, billingAnchorDay: true, createdAt: true },
        },
        paymentProducts: {
          include: {
            businessProductSubscription: {
              select: { id: true, productType: true, status: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return memberships.map((m) =>
      this.formatMembershipWithProducts(m, business.billingAnchorDay ?? undefined),
    );
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleExpiredMembershipsCron() {
    await this.reconcileExpiredMemberships();
  }

  async reconcileExpiredMemberships(targetDate: Date = new Date()): Promise<{ expiredMembershipsCount: number; deactivatedProductsCount: number }> {
    this.logger.log(`[reconcileExpiredMemberships] Verificando membresías vencidas a las ${targetDate.toISOString()}`);

    const activeMemberships = await this.prisma.membership.findMany({
      where: {
        status: MembershipStatus.ACTIVE,
      },
      include: {
        paymentProducts: true,
        business: {
          select: {
            id: true,
            createdAt: true,
            billingAnchorDay: true,
          },
        },
      },
    });

    const expiredMemberships = activeMemberships.filter((m) => {
      const anchor =
        m.business?.billingAnchorDay ?? getManaguaDateParts(m.startDate).day;
      const dueDate = calculateDueDate(m.startDate, anchor);
      const graceEndsAt = calculateGraceEndsAt(dueDate);
      return targetDate >= graceEndsAt;
    });

    if (expiredMemberships.length === 0) {
      return { expiredMembershipsCount: 0, deactivatedProductsCount: 0 };
    }

    const expiredIds = expiredMemberships.map((m) => m.id);
    await this.prisma.membership.updateMany({
      where: { id: { in: expiredIds } },
      data: { status: MembershipStatus.EXPIRED },
    });

    let deactivatedProductsCount = 0;
    const affectedSubscriptionIds = new Set<string>();
    for (const m of expiredMemberships) {
      for (const p of m.paymentProducts) {
        affectedSubscriptionIds.add(p.businessProductSubscriptionId);
      }
    }

    for (const subId of affectedSubscriptionIds) {
      const sub = await this.prisma.businessProductSubscription.findUnique({
        where: { id: subId },
        include: { business: { select: { id: true, businessType: true } } },
      });

      if (!sub || sub.status !== BusinessProductStatus.ACTIVE) continue;

      if (sub.productType === BusinessProductType.DELIVERY && sub.business.businessType === BusinessType.EMPRESA_RIDERS) {
        continue;
      }

      const hasOtherCoverage = await this.prisma.membershipPaymentProduct.findFirst({
        where: {
          businessProductSubscriptionId: subId,
          membershipPayment: {
            status: MembershipStatus.ACTIVE,
            startDate: { lte: targetDate },
            endDate: { gte: targetDate },
          },
        },
      });

      if (!hasOtherCoverage) {
        await this.prisma.businessProductSubscription.update({
          where: { id: subId },
          data: {
            status: BusinessProductStatus.INACTIVE,
            deactivatedAt: targetDate,
          },
        });

        await this.prisma.businessProductAuditLog.create({
          data: {
            businessId: sub.businessId,
            productType: sub.productType,
            action: BusinessProductAction.DEACTIVATED,
            performedBy: 'system-auto-expiration',
            reason: 'Expiración automática por membresía vencida',
            metadata: {
              expiredAt: targetDate,
              subId,
            },
          },
        });

        if (sub.productType === BusinessProductType.POS) {
          await this.prisma.business.update({ where: { id: sub.businessId }, data: { hasPOS: false } });
        } else if (sub.productType === BusinessProductType.CARTERA_COBRO) {
          await this.prisma.business.update({ where: { id: sub.businessId }, data: { hasCarteraCobro: false } });
        } else if (sub.productType === BusinessProductType.CITAS) {
          await this.prisma.business.update({ where: { id: sub.businessId }, data: { hasCitas: false } });
        } else if (sub.productType === BusinessProductType.DELIVERY) {
          await this.prisma.business.update({ where: { id: sub.businessId }, data: { hasTrackDeli: false } });
        }

        deactivatedProductsCount++;
      }
    }

    this.logger.log(`[reconcileExpiredMemberships] Completado: ${expiredMemberships.length} membresías expiradas, ${deactivatedProductsCount} productos desactivados.`);
    return {
      expiredMembershipsCount: expiredMemberships.length,
      deactivatedProductsCount,
    };
  }
  async updateUserQuota(id: string, extraUserSlots: number) {
    if (typeof extraUserSlots !== 'number' || extraUserSlots < 0) {
      throw new BadRequestException('El número de cupos extra debe ser un entero positivo o cero');
    }
    
    await this.prisma.business.update({
      where: { id },
      data: { extraUserSlots },
    });
    
    this.logger.log(`[updateUserQuota] Se actualizaron los cupos extra del negocio ${id} a ${extraUserSlots}`);
    return this.userQuotaService.getUsage(id);
  }

  async getBusinessDevices(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }
    const devices = await this.prisma.posDevice.findMany({
      where: { businessId },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    });
    return devices.map(({ secretHash, ...d }) => d);
  }

  async updateBusinessDevice(
    businessId: string,
    deviceIdOrId: string,
    dto: UpdateDeviceDto,
    actorUser?: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

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
      userId: actorUser?.sub || 'system-superadmin',
      userRole: actorUser?.role || 'SUPERADMIN',
      action,
      entityType: 'PosDevice',
      entityId: device.id,
      before: { status: device.status, name: device.name },
      after: { status: updated.status, name: updated.name },
    });

    this.logger.log(
      `[updateBusinessDevice] Dispositivo ${device.id} (${device.deviceId}) actualizado: status=${updated.status}, name="${updated.name}"`,
    );

    const { secretHash, ...safe } = updated;
    return safe;
  }

  async getBusinessWebDevices(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }
    const devices = await this.prisma.posDevice.findMany({
      where: { businessId, category: 'WEB' },
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

  async updateBusinessWebDevice(
    businessId: string,
    deviceIdOrId: string,
    dto: UpdateDeviceDto,
    actorUser?: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

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
      data: {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.name !== undefined && { name: dto.name.trim() }),
      },
    });

    let action = 'WEB_DEVICE_UPDATED';
    if (dto.status && dto.status !== device.status) {
      action = dto.status === PosDeviceStatus.REVOKED ? 'WEB_DEVICE_REVOKED' : 'WEB_DEVICE_ACTIVATED';
    }

    await this.auditService.record({
      businessId,
      userId: actorUser?.sub || 'system-superadmin',
      userRole: actorUser?.role || 'SUPERADMIN',
      action,
      entityType: 'PosDevice',
      entityId: device.id,
      before: { status: device.status, name: device.name },
      after: { status: updated.status, name: updated.name },
    });

    this.logger.log(
      `[updateBusinessWebDevice] Dispositivo web ${device.id} (${device.deviceId}) actualizado: status=${updated.status}, name="${updated.name}"`,
    );

    const { secretHash, ...safe } = updated;
    return safe;
  }

  async updatePosSubscription(
    businessId: string,
    dto: UpdatePosSubscriptionDto,
    actorUser?: JwtPayload,
  ) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, salonProfile: true },
    });
    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

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

    let updatedSub = sub;
    if (dto.maxDevices !== undefined) {
      updatedSub = await this.prisma.businessProductSubscription.update({
        where: { id: sub.id },
        data: {
          maxDevices: dto.maxDevices,
        },
      });

      await this.auditService.record({
        businessId,
        userId: actorUser?.sub || 'system-superadmin',
        userRole: actorUser?.role || 'SUPERADMIN',
        action: 'DEVICE_LIMIT_CHANGED',
        entityType: 'BusinessProductSubscription',
        entityId: sub.id,
        before: { maxDevices: sub.maxDevices },
        after: { maxDevices: updatedSub.maxDevices },
      });

      this.logger.log(
        `[updatePosSubscription] Límite maxDevices de businessId=${businessId} cambiado de ${sub.maxDevices} a ${updatedSub.maxDevices}`,
      );
    }

    if (
      dto.webAdminEnabled !== undefined ||
      dto.webBillingEnabled !== undefined ||
      dto.maxWebDevices !== undefined ||
      dto.webBillingMonthlyUsd !== undefined
    ) {
      if (
        dto.webBillingMonthlyUsd !== undefined &&
        dto.webBillingMonthlyUsd !== null &&
        Number(dto.webBillingMonthlyUsd) < 0
      ) {
        throw new BadRequestException(
          'La tarifa mensual de facturación web no puede ser negativa',
        );
      }
      if (
        dto.maxWebDevices !== undefined &&
        dto.maxWebDevices !== null &&
        dto.maxWebDevices < 0
      ) {
        throw new BadRequestException('maxWebDevices no puede ser negativo');
      }

      const prevWebAdmin = (updatedSub as any).webAdminEnabled ?? true;
      const prevWebBilling = updatedSub.webBillingEnabled;
      const prevMaxWebDevices = updatedSub.maxWebDevices;
      const prevWebBillingMonthlyUsd =
        (updatedSub as any).webBillingMonthlyUsd !== null &&
        (updatedSub as any).webBillingMonthlyUsd !== undefined
          ? Number((updatedSub as any).webBillingMonthlyUsd)
          : null;

      const targetWebAdmin =
        dto.webAdminEnabled !== undefined ? dto.webAdminEnabled : prevWebAdmin;
      let targetWebBilling =
        dto.webBillingEnabled !== undefined ? dto.webBillingEnabled : prevWebBilling;

      // Regla: webBillingEnabled = true exige webAdminEnabled = true
      if (dto.webBillingEnabled === true && !targetWebAdmin) {
        throw new BadRequestException(
          'La facturación web requiere que el acceso a la web admin esté habilitado',
        );
      }

      // Si se apaga webAdminEnabled, también queda apagado webBillingEnabled
      if (!targetWebAdmin) {
        targetWebBilling = false;
      }

      const dataToUpdate: any = {};
      if (dto.webAdminEnabled !== undefined) dataToUpdate.webAdminEnabled = targetWebAdmin;
      if (targetWebBilling !== prevWebBilling || dto.webBillingEnabled !== undefined) {
        dataToUpdate.webBillingEnabled = targetWebBilling;
      }
      if (dto.maxWebDevices !== undefined) dataToUpdate.maxWebDevices = dto.maxWebDevices;
      if (dto.webBillingMonthlyUsd !== undefined) {
        dataToUpdate.webBillingMonthlyUsd =
          dto.webBillingMonthlyUsd !== null
            ? new Prisma.Decimal(dto.webBillingMonthlyUsd)
            : null;
      }

      updatedSub = await this.prisma.businessProductSubscription.update({
        where: { id: sub.id },
        data: dataToUpdate,
      });

      const nextWebBillingMonthlyUsd =
        (updatedSub as any).webBillingMonthlyUsd !== null &&
        (updatedSub as any).webBillingMonthlyUsd !== undefined
          ? Number((updatedSub as any).webBillingMonthlyUsd)
          : null;

      await this.auditService.record({
        businessId,
        userId: actorUser?.sub || 'system-superadmin',
        userRole: actorUser?.role || 'SUPERADMIN',
        action: 'WEB_BILLING_SETTINGS_CHANGED',
        entityType: 'BusinessProductSubscription',
        entityId: sub.id,
        before: {
          webAdminEnabled: prevWebAdmin,
          webBillingEnabled: prevWebBilling,
          maxWebDevices: prevMaxWebDevices,
          webBillingMonthlyUsd: prevWebBillingMonthlyUsd,
        },
        after: {
          webAdminEnabled: updatedSub.webAdminEnabled,
          webBillingEnabled: updatedSub.webBillingEnabled,
          maxWebDevices: updatedSub.maxWebDevices,
          webBillingMonthlyUsd: nextWebBillingMonthlyUsd,
        },
      });

      this.logger.log(
        `[updatePosSubscription] Configuración web admin/billing de businessId=${businessId} cambiada: webAdminEnabled=${updatedSub.webAdminEnabled}, webBillingEnabled=${updatedSub.webBillingEnabled}, maxWebDevices=${updatedSub.maxWebDevices}, webBillingMonthlyUsd=${nextWebBillingMonthlyUsd}`,
      );
    }

    let updatedSalonProfile = business.salonProfile;
    if (dto.salonProfile !== undefined) {
      const newProfile = dto.salonProfile || 'RESTAURANTE';
      const updatedBusiness = await this.prisma.business.update({
        where: { id: businessId },
        data: { salonProfile: newProfile },
        select: { salonProfile: true },
      });
      updatedSalonProfile = updatedBusiness.salonProfile;

      await this.auditService.record({
        businessId,
        userId: actorUser?.sub || 'system-superadmin',
        userRole: actorUser?.role || 'SUPERADMIN',
        action: 'SALON_PROFILE_CHANGED',
        entityType: 'Business',
        entityId: businessId,
        before: { salonProfile: business.salonProfile },
        after: { salonProfile: updatedSalonProfile },
        reason: `Perfil de Salón actualizado a ${updatedSalonProfile}`,
      });

      this.logger.log(
        `[updatePosSubscription] salonProfile de businessId=${businessId} cambiado de ${business.salonProfile} a ${updatedSalonProfile}`,
      );
    }

    if (dto.backofficeTier !== undefined) {
      const newTier = dto.backofficeTier || 'BASIC';
      const beforeTier = (sub as any).backofficeTier || 'BASIC';
      updatedSub = await this.prisma.businessProductSubscription.update({
        where: { id: sub.id },
        data: {
          backofficeTier: newTier,
        } as any,
      });

      await this.auditService.record({
        businessId,
        userId: actorUser?.sub || 'system-superadmin',
        userRole: actorUser?.role || 'SUPERADMIN',
        action: 'BACKOFFICE_TIER_CHANGED',
        entityType: 'BusinessProductSubscription',
        entityId: sub.id,
        before: { backofficeTier: beforeTier },
        after: { backofficeTier: newTier },
        reason: `Nivel de Backoffice actualizado a ${newTier}`,
      });

      this.logger.log(
        `[updatePosSubscription] backofficeTier de businessId=${businessId} cambiado de ${beforeTier} a ${newTier}`,
      );
    }

    if (dto.trialHours !== undefined) {
      if (dto.trialHours === null) {
        const prevHours = (updatedSub as any).trialHours;
        const prevStarted = (updatedSub as any).trialStartedAt;
        const prevEnds = (updatedSub as any).trialEndsAt;

        updatedSub = await this.prisma.businessProductSubscription.update({
          where: { id: sub.id },
          data: {
            trialHours: null,
            trialStartedAt: null,
            trialEndsAt: null,
          } as any,
        });

        await this.auditService.record({
          businessId,
          userId: actorUser?.sub || 'system-superadmin',
          userRole: actorUser?.role || 'SUPERADMIN',
          action: 'TRIAL_REMOVED',
          entityType: 'BusinessProductSubscription',
          entityId: sub.id,
          before: { trialHours: prevHours, trialStartedAt: prevStarted, trialEndsAt: prevEnds },
          after: { trialHours: null, trialStartedAt: null, trialEndsAt: null },
          reason: 'Prueba POS desactivada para el negocio',
        });

        this.logger.log(`[updatePosSubscription] trial removido para businessId=${businessId}`);
      } else {
        const prevHours = (updatedSub as any).trialHours;
        const newHours = dto.trialHours;

        updatedSub = await this.prisma.businessProductSubscription.update({
          where: { id: sub.id },
          data: {
            trialHours: newHours,
          } as any,
        });

        await this.auditService.record({
          businessId,
          userId: actorUser?.sub || 'system-superadmin',
          userRole: actorUser?.role || 'SUPERADMIN',
          action: 'TRIAL_HOURS_CHANGED',
          entityType: 'BusinessProductSubscription',
          entityId: sub.id,
          before: { trialHours: prevHours },
          after: { trialHours: newHours },
          reason: `Horas de prueba POS actualizadas a ${newHours}h`,
        });

        this.logger.log(
          `[updatePosSubscription] trialHours de businessId=${businessId} cambiado de ${prevHours} a ${newHours}`,
        );
      }
    }

    if (dto.trialAction) {
      const now = new Date();

      if (dto.trialAction === 'extend') {
        const hoursToAdd = dto.extendHours && dto.extendHours >= 1 ? dto.extendHours : ((updatedSub as any).trialHours || 6);
        let baseTime: Date;
        if ((updatedSub as any).trialEndsAt) {
          const currentEnd = new Date((updatedSub as any).trialEndsAt);
          baseTime = currentEnd > now ? currentEnd : now;
        } else {
          baseTime = now;
        }
        const newEndsAt = new Date(baseTime.getTime() + hoursToAdd * 60 * 60 * 1000);
        const prevEndsAt = (updatedSub as any).trialEndsAt;

        updatedSub = await this.prisma.businessProductSubscription.update({
          where: { id: sub.id },
          data: {
            trialEndsAt: newEndsAt,
            trialStartedAt: (updatedSub as any).trialStartedAt || now,
          } as any,
        });

        await this.auditService.record({
          businessId,
          userId: actorUser?.sub || 'system-superadmin',
          userRole: actorUser?.role || 'SUPERADMIN',
          action: 'TRIAL_EXTENDED',
          entityType: 'BusinessProductSubscription',
          entityId: sub.id,
          before: { trialEndsAt: prevEndsAt },
          after: { trialEndsAt: newEndsAt, hoursAdded: hoursToAdd },
          reason: `Prueba POS extendida en ${hoursToAdd}h adicionales`,
        });

        this.logger.log(
          `[updatePosSubscription] trial de businessId=${businessId} extendido +${hoursToAdd}h hasta ${newEndsAt.toISOString()}`,
        );
      } else if (dto.trialAction === 'reset') {
        const prevStarted = (updatedSub as any).trialStartedAt;
        const prevEnds = (updatedSub as any).trialEndsAt;

        updatedSub = await this.prisma.businessProductSubscription.update({
          where: { id: sub.id },
          data: {
            trialStartedAt: null,
            trialEndsAt: null,
          } as any,
        });

        await this.auditService.record({
          businessId,
          userId: actorUser?.sub || 'system-superadmin',
          userRole: actorUser?.role || 'SUPERADMIN',
          action: 'TRIAL_RESET',
          entityType: 'BusinessProductSubscription',
          entityId: sub.id,
          before: { trialStartedAt: prevStarted, trialEndsAt: prevEnds },
          after: { trialStartedAt: null, trialEndsAt: null },
          reason: 'Reloj de prueba POS reiniciado (arrancará en el próximo login en desktop-win)',
        });

        this.logger.log(`[updatePosSubscription] trial reiniciado para businessId=${businessId}`);
      } else if (dto.trialAction === 'terminate') {
        const prevEnds = (updatedSub as any).trialEndsAt;
        const terminatedAt = now;

        updatedSub = await this.prisma.businessProductSubscription.update({
          where: { id: sub.id },
          data: {
            trialEndsAt: terminatedAt,
          } as any,
        });

        await this.auditService.record({
          businessId,
          userId: actorUser?.sub || 'system-superadmin',
          userRole: actorUser?.role || 'SUPERADMIN',
          action: 'TRIAL_TERMINATED',
          entityType: 'BusinessProductSubscription',
          entityId: sub.id,
          before: { trialEndsAt: prevEnds },
          after: { trialEndsAt: terminatedAt },
          reason: 'Prueba POS terminada inmediatamente por el SuperAdmin',
        });

        this.logger.log(`[updatePosSubscription] trial terminado inmediatamente para businessId=${businessId}`);
      }
    }

    return {
      ...updatedSub,
      salonProfile: updatedSalonProfile,
      salonLabels: getSalonLabels(updatedSalonProfile),
      backofficeTier: (updatedSub as any).backofficeTier ?? 'BASIC',
      trialHours: (updatedSub as any).trialHours ?? null,
      trialStartedAt: (updatedSub as any).trialStartedAt ?? null,
      trialEndsAt: (updatedSub as any).trialEndsAt ?? null,
    };
  }

  /**
   * 168a - Inspección dinámica del grafo de foreign keys y columnas de negocio.
   * Recorre la estructura real de Postgres de hijos a padres con ordenamiento topológico.
   */
  private async getDynamicSchemaInfo(client: Prisma.TransactionClient | PrismaService) {
    const bizCols = await client.$queryRawUnsafe<
      Array<{ table_name: string; column_name: string }>
    >(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (lower(column_name) = 'businessid' OR lower(column_name) = 'business_id')
    `);
    const bizColMap = new Map<string, string>();
    for (const row of bizCols) {
      bizColMap.set(row.table_name, row.column_name);
    }

    const fks = await client.$queryRawUnsafe<
      Array<{
        child_table: string;
        child_col: string;
        parent_table: string;
        parent_col: string;
      }>
    >(`
      SELECT DISTINCT
        tc.table_name AS child_table,
        kcu.column_name AS child_col,
        ccu.table_name AS parent_table,
        ccu.column_name AS parent_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `);

    const parentToChildren = new Map<string, typeof fks>();
    const childToParents = new Map<string, typeof fks>();

    for (const fk of fks) {
      if (!parentToChildren.has(fk.parent_table)) parentToChildren.set(fk.parent_table, []);
      parentToChildren.get(fk.parent_table)!.push(fk);

      if (!childToParents.has(fk.child_table)) childToParents.set(fk.child_table, []);
      childToParents.get(fk.child_table)!.push(fk);
    }

    const descendants = new Set<string>();
    const maxDepth = 15;

    const traverse = (table: string, depth: number, currentPath: string[]) => {
      if (depth > maxDepth) return;
      if (currentPath.includes(table)) {
        this.logger.warn(
          `[getDynamicSchemaInfo] Ciclo detectado en FK: ${[...currentPath, table].join(' -> ')}`,
        );
        return;
      }
      const children = parentToChildren.get(table) || [];
      for (const edge of children) {
        descendants.add(edge.child_table);
        traverse(edge.child_table, depth + 1, [...currentPath, table]);
      }
    };

    traverse('businesses', 1, []);

    // Tablas con business_id / businessId sin FK
    for (const [table] of bizColMap.entries()) {
      if (table !== 'businesses') {
        descendants.add(table);
      }
    }

    // Ordenamiento topológico: hijos antes que padres para evitar violaciones de FK
    const inDegree = new Map<string, number>();
    const adj = new Map<string, Set<string>>();

    for (const t of descendants) {
      inDegree.set(t, 0);
      adj.set(t, new Set());
    }

    for (const fk of fks) {
      const child = fk.child_table;
      const parent = fk.parent_table;
      if (descendants.has(child) && descendants.has(parent) && child !== parent) {
        if (!adj.get(child)!.has(parent)) {
          adj.get(child)!.add(parent);
        }
      }
    }

    for (const [, parents] of adj.entries()) {
      for (const p of parents) {
        inDegree.set(p, (inDegree.get(p) || 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [t, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(t);
    }

    const deleteOrder: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      deleteOrder.push(node);

      for (const parent of adj.get(node) || []) {
        const newDeg = inDegree.get(parent)! - 1;
        inDegree.set(parent, newDeg);
        if (newDeg === 0) queue.push(parent);
      }
    }

    for (const t of descendants) {
      if (!deleteOrder.includes(t)) {
        deleteOrder.push(t);
      }
    }

    return { bizColMap, childToParents, deleteOrder };
  }

  /**
   * 168a - Generador dinámico de cláusula WHERE parametrizada ($1 = businessId)
   */
  private buildDynamicWhereClause(
    table: string,
    bizColMap: Map<string, string>,
    childToParents: Map<string, any[]>,
    depth = 0,
    visited = new Set<string>(),
  ): string | null {
    if (depth > 15 || visited.has(table)) return null;
    visited.add(table);

    if (bizColMap.has(table) && table !== 'businesses') {
      const col = bizColMap.get(table)!;
      return `"${col}" = $1`;
    }

    const outgoingFks = childToParents.get(table) || [];
    const conditions: string[] = [];

    for (const fk of outgoingFks) {
      if (fk.parent_table === 'businesses') {
        conditions.push(`"${fk.child_col}" = $1`);
      } else {
        const parentCondition = this.buildDynamicWhereClause(
          fk.parent_table,
          bizColMap,
          childToParents,
          depth + 1,
          new Set(visited),
        );
        if (parentCondition) {
          conditions.push(
            `"${fk.child_col}" IN (SELECT "${fk.parent_col}" FROM "${fk.parent_table}" WHERE ${parentCondition})`,
          );
        }
      }
    }

    if (conditions.length === 0) return null;
    return conditions.join(' OR ');
  }

  /**
   * 168a - Vista previa de borrado (sin borrar nada).
   * GET /superadmin/businesses/:id/deletion-preview
   */
  async getBusinessDeletionPreview(id: string) {
    this.logger.log(`[getBusinessDeletionPreview] Obteniendo vista previa de borrado para id=${id}`);
    const business = await this.prisma.business.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        type: true,
        isActive: true,
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    // Verificar si algún usuario tiene rol SUPERADMIN
    const superAdminUser = await this.prisma.user.findFirst({
      where: { businessId: id, role: UserRole.SUPERADMIN },
      select: { id: true, email: true },
    });

    const blockedReason = superAdminUser
      ? 'El negocio contiene usuarios con rol SUPERADMIN y está protegido contra eliminación'
      : null;

    // Suscripciones y membresías
    const subs = await this.prisma.businessProductSubscription.findMany({
      where: { businessId: id },
      select: { productType: true, status: true },
    });

    const activeMembership = await this.prisma.membership.findFirst({
      where: { businessId: id, status: MembershipStatus.ACTIVE },
      select: { id: true },
    });

    const hasActiveSubscription =
      subs.some((s) => s.status === BusinessProductStatus.ACTIVE) || !!activeMembership;

    const subscriptions = subs.map((s) => ({
      product: s.productType,
      status: s.status,
    }));

    // Conteos dinámicos en exactamente el mismo orden que el borrado real
    const { bizColMap, childToParents, deleteOrder } = await this.getDynamicSchemaInfo(this.prisma);
    const counts: Record<string, number> = {};

    for (const table of deleteOrder) {
      const where = this.buildDynamicWhereClause(table, bizColMap, childToParents);
      if (!where) continue;

      const res = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM "${table}" WHERE ${where}`,
        id,
      );
      const rowCount = res[0]?.count || 0;
      if (rowCount > 0) {
        counts[table] = rowCount;
        if (table === 'pos_sales') counts['sales'] = rowCount;
        if (table === 'pos_products') counts['products'] = rowCount;
      }
    }

    return {
      business: {
        id: business.id,
        name: business.name,
        type: business.type,
        isActive: business.isActive,
      },
      counts,
      hasActiveSubscription,
      subscriptions,
      blockedReason,
    };
  }

  /**
   * 168a - Eliminar definitivamente un negocio.
   * DELETE /superadmin/businesses/:id
   */
  async deleteBusiness(id: string, dto: DeleteBusinessDto, adminUserId: string) {
    this.logger.log(`[deleteBusiness] Solicitud de eliminación definitiva para negocio id=${id}`);

    const business = await this.prisma.business.findUnique({
      where: { id },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    // 1. Confirmación de nombre exacta (ignorando mayúsculas y espacios extremos)
    const expectedName = business.name.trim().toLowerCase();
    const providedName = dto?.confirmName?.trim()?.toLowerCase() || '';

    if (providedName !== expectedName) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'El nombre de confirmación no coincide con el nombre del negocio',
        code: 'CONFIRMATION_MISMATCH',
      });
    }

    // 2. Proteger si algún usuario del negocio tiene rol SUPERADMIN
    const superAdminUser = await this.prisma.user.findFirst({
      where: { businessId: id, role: UserRole.SUPERADMIN },
      select: { id: true, email: true },
    });

    if (superAdminUser) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'El negocio contiene usuarios con rol SUPERADMIN y no puede ser eliminado',
        code: 'BUSINESS_PROTECTED',
      });
    }

    // 3. Recolectar URLs de archivos externos antes de eliminarlos
    const externalFileUrls: string[] = [];
    if (business.logoUrl) externalFileUrls.push(business.logoUrl);

    try {
      const productImgs = await this.prisma.product.findMany({
        where: { businessId: id, imageUrl: { not: null } },
        select: { imageUrl: true },
      });
      for (const p of productImgs) {
        if (p.imageUrl) externalFileUrls.push(p.imageUrl);
      }

      const membershipProofs = await this.prisma.membership.findMany({
        where: { businessId: id, paymentProofUrl: { not: null } },
        select: { paymentProofUrl: true },
      });
      for (const m of membershipProofs) {
        if (m.paymentProofUrl) externalFileUrls.push(m.paymentProofUrl);
      }

      const userPhotos = await this.prisma.user.findMany({
        where: { businessId: id },
        select: { profilePhotoUrl: true, vehiclePhotoUrl: true },
      });
      for (const u of userPhotos) {
        if (u.profilePhotoUrl) externalFileUrls.push(u.profilePhotoUrl);
        if (u.vehiclePhotoUrl) externalFileUrls.push(u.vehiclePhotoUrl);
      }

      const orderFiles = await this.prisma.order.findMany({
        where: { businessId: id },
        select: {
          deliveryConfirmationUrl: true,
          signatureUrl: true,
          photos: { select: { photoUrl: true } },
        },
      });
      for (const o of orderFiles) {
        if (o.deliveryConfirmationUrl) externalFileUrls.push(o.deliveryConfirmationUrl);
        if (o.signatureUrl) externalFileUrls.push(o.signatureUrl);
        for (const ph of o.photos) {
          if (ph.photoUrl) externalFileUrls.push(ph.photoUrl);
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `[deleteBusiness] Error recolectando URLs de archivos externos: ${err.message}`,
      );
    }

    // 4. Borrado atómico en una sola transacción
    const counts: Record<string, number> = {};

    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);

        const { bizColMap, childToParents, deleteOrder } = await this.getDynamicSchemaInfo(tx);

        for (const table of deleteOrder) {
          const where = this.buildDynamicWhereClause(table, bizColMap, childToParents);
          if (!where) continue;

          const countRes = await tx.$queryRawUnsafe<Array<{ count: number }>>(
            `SELECT COUNT(*)::int AS count FROM "${table}" WHERE ${where}`,
            id,
          );
          const rowCount = countRes[0]?.count || 0;
          if (rowCount > 0) {
            counts[table] = rowCount;
            if (table === 'pos_sales') counts['sales'] = rowCount;
            if (table === 'pos_products') counts['products'] = rowCount;
            await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${where}`, id);
          }
        }

        await tx.$executeRawUnsafe(`DELETE FROM "businesses" WHERE id = $1`, id);
        counts['businesses'] = 1;
      },
      { timeout: 60000 },
    );

    // 5. Borrado de archivos externos post-transacción (un fallo no revierte el borrado)
    for (const fileUrl of externalFileUrls) {
      try {
        await this.uploadService.deletePhoto(fileUrl);
      } catch (fileErr: any) {
        this.logger.warn(
          `[deleteBusiness] No se pudo borrar archivo externo ${fileUrl}: ${fileErr.message}`,
        );
      }
    }

    // 6. Bitácora estructurada
    this.logger.warn(
      `[deleteBusiness] Negocio eliminado definitivamente: ${JSON.stringify({
        businessId: business.id,
        businessName: business.name,
        deletedBySuperadminId: adminUserId,
        counts,
        timestamp: new Date().toISOString(),
      })}`,
    );

    return {
      deleted: true,
      counts,
    };
  }
}
