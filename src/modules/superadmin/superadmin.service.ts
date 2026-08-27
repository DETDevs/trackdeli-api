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
import { MembershipStatus, OrderStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

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

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
  ) {}

  // ==========================================
  // 1. NEGOCIOS
  // ==========================================

  async getBusinesses() {
    this.logger.log('[getBusinesses] Obteniendo lista de negocios con métricas');

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const businesses = await this.prisma.business.findMany({
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
          orderBy: { endDate: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return businesses.map((b) => {
      const ordersToday = b.orders.filter((o) => o.createdAt >= startOfDay).length;
      const ordersThisMonth = b.orders.filter((o) => o.createdAt >= startOfMonth).length;
      const activeOrders = b.orders.filter((o) =>
        ACTIVE_ORDER_STATUSES.includes(o.status),
      ).length;

      const latestMembership = b.memberships[0];
      let membershipStatus: 'ACTIVE' | 'EXPIRED' | 'NONE' = 'NONE';
      let endDate: Date | null = null;
      let daysLeft: number | null = null;

      if (latestMembership) {
        endDate = latestMembership.endDate;
        const isCurrentlyActive =
          latestMembership.status === MembershipStatus.ACTIVE &&
          latestMembership.startDate <= now &&
          latestMembership.endDate >= now;

        if (isCurrentlyActive) {
          membershipStatus = 'ACTIVE';
          daysLeft = Math.max(
            0,
            Math.ceil(
              (latestMembership.endDate.getTime() - now.getTime()) /
                (1000 * 60 * 60 * 24),
            ),
          );
        } else {
          membershipStatus = 'EXPIRED';
          daysLeft = 0;
        }
      }

      return {
        id: b.id,
        name: b.name,
        type: b.type,
        logoUrl: b.logoUrl,
        latitude: b.latitude,
        longitude: b.longitude,
        isActive: b.isActive,
        pricingModel: b.pricingModel,
        baseRate: b.baseRate,
        ratePerKm: b.ratePerKm,
        freeZoneKm: b.freeZoneKm,
        minRate: b.minRate,
        maxRate: b.maxRate,
        pricingZones: (b.pricingZones as any) || null,
        createdAt: b.createdAt,
        _count: {
          orders: b._count.orders,
          users: b._count.users,
        },
        ordersToday,
        ordersThisMonth,
        activeOrders,
        membership: {
          status: membershipStatus,
          endDate,
          daysLeft,
        },
      };
    });
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
      },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    // Repartidores que han trabajado con este negocio
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

    // Métricas del mes actual
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

    return {
      id: business.id,
      name: business.name,
      type: business.type,
      logoUrl: business.logoUrl,
      latitude: business.latitude,
      longitude: business.longitude,
      defaultGeofenceRadiusM: business.defaultGeofenceRadiusM,
      isActive: business.isActive,
      pricingModel: business.pricingModel,
      baseRate: business.baseRate,
      ratePerKm: business.ratePerKm,
      freeZoneKm: business.freeZoneKm,
      minRate: business.minRate,
      maxRate: business.maxRate,
      pricingZones: (business.pricingZones as any) || null,
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

  async createBusiness(dto: CreateBusinessSuperAdminDto) {
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

    const result = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: dto.name,
          type: dto.type || null,
          isActive: true,
        },
      });

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

      return { business, encargado };
    });

    this.logger.log(
      `[createBusiness] OK negocio creado id=${result.business.id}, encargado=${result.encargado.id} (email=${email})`,
    );

    return {
      business: {
        id: result.business.id,
        name: result.business.name,
        type: result.business.type,
        isActive: result.business.isActive,
        createdAt: result.business.createdAt,
      },
      encargado: {
        id: result.encargado.id,
        name: result.encargado.name,
        email: result.encargado.email,
        temporaryPassword: plainPassword,
        role: result.encargado.role,
        isActive: result.encargado.isActive,
      },
    };
  }

  // ==========================================
  // 2. REPARTIDORES
  // ==========================================

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
      // Si se va a desactivar, verificar que no tenga pedidos en curso
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

  // ==========================================
  // 3. MÉTRICAS GLOBALES
  // ==========================================

  async getGlobalMetrics() {
    this.logger.log('[getGlobalMetrics] Calculando dashboard de métricas globales');

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Totals
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

    // Today metrics
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

    // Last 30 Days metrics
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

    // Delivery duration calculation in minutes
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

    // Top businesses (last 30 days)
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

    // Top riders (last 30 days)
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

    // Fetch average ratings for top riders
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

    // Orders per day (last 30 days)
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

    // Status breakdown
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

  // ==========================================
  // 4. LOGS Y ACTIVIDAD DEL SISTEMA
  // ==========================================

  async getRecentLogs() {
    this.logger.log('[getRecentLogs] Obteniendo últimas 100 actividades del sistema');

    // 1. Órdenes recientes con cambios relevantes
    const recentOrders = await this.prisma.order.findMany({
      take: 60,
      orderBy: { createdAt: 'desc' },
      include: {
        business: { select: { name: true } },
        deliveryUser: { select: { name: true } },
      },
    });

    // 2. Repartidores registrados recientemente
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

    // 3. Negocios creados recientemente
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

    // Formatear órdenes
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

    // Formatear repartidores
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

    // Formatear negocios
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

    // Ordenar descendente por fecha y limitar a 100
    logs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return logs.slice(0, 100);
  }

  // ==========================================
  // 5. MEMBRESÍAS
  // ==========================================

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

    const membership = await this.prisma.membership.create({
      data: {
        businessId: dto.businessId,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        amount: dto.amount,
        currency: dto.currency || 'USD',
        paymentMethod: dto.paymentMethod || 'TRANSFERENCIA',
        paidAt: dto.paidAt ? new Date(dto.paidAt) : new Date(),
        notes: dto.notes,
        status: dto.status || MembershipStatus.ACTIVE,
        createdBy,
      },
      include: {
        business: {
          select: { id: true, name: true, logoUrl: true },
        },
      },
    });

    this.logger.log(`[createMembership] OK membresía creada id=${membership.id}`);
    return membership;
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
      },
    });

    this.logger.log(`[uploadPaymentProof] OK comprobante subido: ${proofUrl}`);

    return {
      url: proofUrl,
      membership: updated,
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
      },
      orderBy: { endDate: 'desc' },
    });

    return memberships;
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
      },
      orderBy: { endDate: 'asc' },
    });

    return expiring.map((m) => {
      const daysLeft = Math.max(
        0,
        Math.ceil((m.endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
      );
      return {
        ...m,
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
      },
    });

    this.logger.log(`[updateMembership] OK membresía actualizada id=${id}`);
    return updated;
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
      orderBy: { createdAt: 'desc' },
    });

    return memberships;
  }
}
