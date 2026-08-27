import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { Order, OrderStatus, UserRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { TrackingService } from '../tracking/tracking.service';
import { NotificationsService } from '../notifications/notifications.service';
import { calculateDeliveryFee } from '../../common/utils/pricing.util';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trackingGateway: TrackingGateway,
    private readonly trackingService: TrackingService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async toResponseDto(order: any): Promise<OrderResponseDto> {
    const trackingSession = await this.prisma.trackingSession.findUnique({
      where: { orderId: order.id },
    });

    return {
      id: order.id,
      businessId: order.businessId,
      status: order.status,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      destinationAddress: order.destinationAddress,
      destinationLat: order.destinationLat ? Number(order.destinationLat) : null,
      destinationLng: order.destinationLng ? Number(order.destinationLng) : null,
      geofenceRadiusM: order.geofenceRadiusM,
      description: order.description,
      deliveryPaymentStatus: order.deliveryPaymentStatus,
      deliveryFee: Number(order.deliveryFee),
      distanceKm: Number(order.distanceKm || 0),
      deliveryUser: order.deliveryUser ? {
        id: order.deliveryUser.id,
        name: order.deliveryUser.name,
        phone: order.deliveryUser.phone,
      } : null,
      photos: order.photos || [],
      trackingToken: trackingSession ? trackingSession.token : null,
      createdAt: order.createdAt,
      takenAt: order.takenAt,
      deliveredAt: order.deliveredAt,
      business: order.business ? {
        id: order.business.id,
        name: order.business.name,
        latitude: order.business.latitude ? Number(order.business.latitude) : null,
        longitude: order.business.longitude ? Number(order.business.longitude) : null,
        logoUrl: order.business.logoUrl,
      } : undefined,
    };
  }

  async calculateFee(destLat: number, destLng: number, businessId: string | null) {
    if (!businessId) {
      throw new BadRequestException('El usuario no tiene negocio asociado');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    const result = calculateDeliveryFee(
      business,
      destLat,
      destLng,
    );

    return {
      fee: result.fee,
      distanceKm: result.distanceKm,
      breakdown: result.breakdown,
      pricingModel: business.pricingModel,
      currency: 'NIO',
    };
  }

  async create(dto: CreateOrderDto, createdBy: string, businessId: string): Promise<OrderResponseDto> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
    }

    let deliveryFee = dto.deliveryFee;
    let distanceKm = 0;

    if (
      (deliveryFee === undefined || deliveryFee === null) &&
      dto.destinationLat &&
      dto.destinationLng
    ) {
      const pricing = calculateDeliveryFee(
        business,
        dto.destinationLat,
        dto.destinationLng,
      );
      deliveryFee = pricing.fee;
      distanceKm = pricing.distanceKm;

      this.logger.log(
        `[create] Tarifa calculada automáticamente: C$${deliveryFee} (${distanceKm} km) — ${pricing.breakdown}`,
      );
    } else if (dto.destinationLat && dto.destinationLng && business.latitude && business.longitude) {
      const pricing = calculateDeliveryFee(
        business,
        dto.destinationLat,
        dto.destinationLng,
      );
      distanceKm = pricing.distanceKm;
      deliveryFee = deliveryFee ?? 0;
    } else {
      deliveryFee = deliveryFee ?? 0;
    }

    const order = await this.prisma.order.create({
      data: {
        customerName: dto.customerName,
        customerPhone: dto.customerPhone,
        destinationAddress: dto.destinationAddress,
        destinationLat: dto.destinationLat,
        destinationLng: dto.destinationLng,
        geofenceRadiusM: business.defaultGeofenceRadiusM,
        description: dto.description,
        deliveryPaymentStatus: dto.deliveryPaymentStatus,
        deliveryFee,
        distanceKm,
        status: OrderStatus.PENDIENTE,
        businessId,
        createdBy,
      },
      include: {
        deliveryUser: true,
        photos: true,
      },
    });

    this.logger.log(`[create] OK pedido creado: id=${order.id}, cliente=${dto.customerName}, negocio=${businessId}, tarifa=C$${deliveryFee}`);

    const repartidores = await this.prisma.user.findMany({
      where: { businessId, role: 'REPARTIDOR', isActive: true },
    });
    
    this.logger.log(`[Orders] Notificando a ${repartidores.length} repartidores del nuevo pedido`);

    await Promise.allSettled(
      repartidores.map(r =>
        this.notificationsService.notifyNewOrderAvailable(r.id, order.id, order.customerName)
      )
    );

    this.trackingGateway.emitToOrder(order.id, 'new_order_created', {
      orderId: order.id,
      businessId: order.businessId,
      customerName: order.customerName,
      status: order.status,
    });

    this.trackingGateway.server
      .to(`business:${businessId}`)
      .emit('orders_updated', { businessId });

    return this.toResponseDto(order);
  }

  async findAllByBusiness(businessId: string | null, userId: string, role: UserRole, filters?: { status?: OrderStatus, latitude?: number, longitude?: number }): Promise<OrderResponseDto[]> {
    let whereClause: any = {};
    if (businessId) {
      whereClause.businessId = businessId;
    }

    if (role === UserRole.REPARTIDOR) {
      if (!businessId) {
        whereClause.OR = [
          { status: OrderStatus.PENDIENTE },
          { deliveryUserId: userId },
        ];
      } else {
        whereClause.OR = [
          { status: OrderStatus.PENDIENTE, businessId },
          { deliveryUserId: userId, businessId },
        ];
      }
    }

    if (filters?.status) {
      whereClause.status = filters.status;
    }

    let orders = await this.prisma.order.findMany({
      where: whereClause,
      include: {
        deliveryUser: true,
        photos: true,
        business: {
          select: { id: true, name: true, latitude: true, longitude: true, logoUrl: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: (!businessId && role === UserRole.REPARTIDOR) ? 20 : undefined,
    });

    if (role === UserRole.REPARTIDOR && !businessId && filters?.latitude && filters?.longitude) {
      const radiusKm = 10; // Defaulting to 10 for simplicity without messing up DI config if not there
      orders = orders.filter(order => {
        if (!order.business?.latitude || !order.business?.longitude) return true;
        const dist = this.trackingService.calculateDistance(
          Number(filters.latitude),
          Number(filters.longitude),
          Number(order.business.latitude),
          Number(order.business.longitude),
        );
        return dist <= radiusKm;
      });
    }

    const result = await Promise.all(orders.map(o => this.toResponseDto(o)));
    this.logger.log(`[findAll] userId=${userId}, role=${role}, businessId=${businessId} | OK - ${result.length} pedidos`);
    return result;
  }

  async findOne(id: string, businessId: string | null, userId?: string, role?: string): Promise<OrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        deliveryUser: true,
        photos: true,
        business: {
          select: { id: true, name: true, latitude: true, longitude: true, logoUrl: true }
        }
      },
    });

    if (!order) {
      this.logger.warn(`[findOne] WARN pedido no encontrado: orderId=${id}`);
      throw new NotFoundException('Pedido no encontrado');
    }

    if (role) {
      let canAccess = false;
      if (role === UserRole.REPARTIDOR) {
        canAccess = 
          (businessId !== null && order.businessId === businessId) ||
          (order.deliveryUserId === userId) ||
          (order.status === OrderStatus.PENDIENTE);
      } else if (role === UserRole.SUPERADMIN) {
        canAccess = true;
      } else {
        // ENCARGADO
        canAccess = (order.businessId === businessId);
      }

      if (!canAccess) {
        this.logger.warn(`[findOne] WARN acceso denegado: userId=${userId}, orderId=${id}, businessId=${businessId}`);
        throw new NotFoundException('Pedido no encontrado');
      }
    } else {
      // Legacy / internal behavior when called by takeOrder, cancelOrder, updateStatus, etc.
      if (businessId !== null && order.businessId !== businessId) {
        this.logger.warn(`[findOne] WARN acceso denegado (legacy): orderId=${id}, businessId=${businessId}`);
        throw new NotFoundException('Pedido no encontrado');
      }
    }

    return this.toResponseDto(order);
  }

  async takeOrder(orderId: string, deliveryUserId: string): Promise<OrderResponseDto> {
    this.logger.log(`[takeOrder] Intento de tomar pedido: orderId=${orderId}, repartidor=${deliveryUserId}`);

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { business: true },
      });

      if (!order) {
        throw new NotFoundException('Pedido no encontrado');
      }

      if (order.status !== OrderStatus.PENDIENTE) {
        this.logger.warn(`[takeOrder] CONFLICT orderId=${orderId} ya fue tomado. Repartidor intentado=${deliveryUserId}`);
        throw new ConflictException('Pedido no disponible — ya fue tomado por otro repartidor');
      }

      const rider = await tx.user.findUnique({ where: { id: deliveryUserId } });
      if (!rider || rider.role !== 'REPARTIDOR') {
        throw new ForbiddenException();
      }

      if (!rider.isAvailable) {
        throw new ConflictException('No estás disponible para tomar pedidos');
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.ACEPTADO,
          deliveryUserId,
          takenAt: new Date(),
        },
      });

      this.logger.log(`[takeOrder] OK pedido aceptado: orderId=${orderId}, repartidor=${deliveryUserId}`);
      this.trackingGateway.emitOrderStatusChange(orderId, OrderStatus.ACEPTADO);

      const encargado = await tx.user.findFirst({
        where: { businessId: order.businessId, role: 'ENCARGADO' },
      });
      if (encargado) {
        await this.notificationsService.notifyOrderTaken(
          encargado.id,
          orderId,
          rider.name,
          order.customerName,
        );
      }

      return this.findOne(orderId, order.businessId);
    });
  }

  async cancelOrder(id: string, businessId: string): Promise<OrderResponseDto> {
    await this.prisma.order.update({
      where: {
        id,
        businessId,
      },
      data: { status: OrderStatus.CANCELADO },
    });

    this.trackingGateway.emitOrderStatusChange(id, OrderStatus.CANCELADO);
    
    await this.trackingService.cleanupGeofenceFlag(id);
    await this.trackingService.cleanupOrderRedisKeys(id);

    return this.findOne(id, businessId);
  }

  async updateStatus(orderId: string, dto: UpdateOrderStatusDto, userId: string, role: UserRole, businessId: string | null): Promise<OrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    const canAccess =
      (role === UserRole.SUPERADMIN) ||
      (businessId !== null && order?.businessId === businessId) ||
      (order?.deliveryUserId === userId) ||
      (order?.status === OrderStatus.PENDIENTE);

    if (!order || !canAccess) {
      throw new NotFoundException('Pedido no encontrado o no tienes permiso');
    }

    if (role === UserRole.REPARTIDOR && order.deliveryUserId !== userId && order.status !== OrderStatus.PENDIENTE) {
      this.logger.warn(`[updateStatus] WARN acceso denegado: userId=${userId}, orderId=${orderId}`);
      throw new ForbiddenException('No tienes permiso para actualizar este pedido');
    }

    this.logger.log(`[updateStatus] Cambio de estado: orderId=${orderId}, de=${order.status}, a=${dto.status}, userId=${userId}`);

    try {
      this.validateStateTransition(order.status, dto.status, role);
    } catch (e) {
      this.logger.warn(`[Orders] Transición inválida: orderId=${orderId}, de=${order.status}, a=${dto.status}, usuario=${userId}`);
      throw e;
    }

    const updateData: any = { status: dto.status };
    if (dto.status === OrderStatus.ENTREGADO) {
      updateData.deliveredAt = new Date();
    } else if (dto.status === OrderStatus.EN_EL_NEGOCIO) {
      updateData.arrivedAtBusinessAt = new Date();
    } else if (dto.status === OrderStatus.EN_CAMINO) {
      updateData.pickedUpAt = new Date();
    }
    
    // Notes or incidence logic goes here (create notification or incidence log in future)
    // For now we just update the status

    await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
    });

    if (dto.status === OrderStatus.EN_CAMINO) {
      const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 12);

      await this.prisma.trackingSession.create({
        data: {
          orderId,
          token,
          expiresAt,
        },
      });
      this.logger.log(`[Orders] Sesión de tracking generada para pedido en camino: orderId=${orderId}, token=${token}`);
    }

    this.trackingGateway.emitOrderStatusChange(orderId, dto.status);

    const encargado = await this.prisma.user.findFirst({
      where: { businessId: order.businessId, role: 'ENCARGADO' },
    });

    if (dto.status === OrderStatus.ENTREGADO || dto.status === OrderStatus.CANCELADO) {
      await this.trackingService.cleanupGeofenceFlag(orderId);
      await this.trackingService.cleanupOrderRedisKeys(orderId);
      
      if (dto.status === OrderStatus.ENTREGADO) {
        this.logger.log(`[Orders] Pedido ENTREGADO: orderId=${orderId}, repartidor=${userId}, cliente=${order.customerName}`);
        if (encargado) {
          await this.notificationsService.notifyOrderDelivered(
            encargado.id,
            orderId,
            order.customerName,
          );
        }
      }
    } else if (dto.status === OrderStatus.EN_CAMINO_AL_NEGOCIO && encargado) {
      const rider = await this.prisma.user.findUnique({ where: { id: userId } });
      await this.notificationsService.notifyOrderOnWayToBusiness(encargado.id, orderId, rider?.name || 'Repartidor');
    } else if (dto.status === OrderStatus.EN_EL_NEGOCIO && encargado) {
      const rider = await this.prisma.user.findUnique({ where: { id: userId } });
      await this.notificationsService.notifyOrderAtBusiness(encargado.id, orderId, rider?.name || 'Repartidor');
    } else if (dto.status === OrderStatus.EN_CAMINO && encargado) {
      await this.notificationsService.notifyOrderOnWay(encargado.id, orderId, order.customerName);
    }

    if (dto.status === OrderStatus.INCIDENCIA) {
      this.logger.warn(`[Orders] INCIDENCIA reportada: orderId=${orderId}, repartidor=${userId}, notas=${(dto as any).notes}`);
      if (encargado) {
        await this.notificationsService.notifyOrderIncident(
          encargado.id,
          orderId,
          order.customerName,
          (dto as any).notes,
        );
      }
    }

    return this.findOne(orderId, businessId);
  }

  private validateStateTransition(current: OrderStatus, next: OrderStatus, role: UserRole) {
    if (current === next) {
      return; // Permite idempotencia
    }
    if (next === OrderStatus.CANCELADO) {
      if (role !== UserRole.ENCARGADO && role !== UserRole.SUPERADMIN) {
        throw new ForbiddenException('Solo encargados pueden cancelar pedidos');
      }
      return;
    }

    if (next === OrderStatus.INCIDENCIA) {
      if (role !== UserRole.REPARTIDOR) {
        throw new ForbiddenException('Solo repartidores pueden reportar incidencias');
      }
      return;
    }

    const flow: OrderStatus[] = [
      OrderStatus.PENDIENTE,
      OrderStatus.ACEPTADO,
      OrderStatus.EN_CAMINO_AL_NEGOCIO,
      OrderStatus.EN_EL_NEGOCIO,
      OrderStatus.EN_CAMINO,
      OrderStatus.CERCA_DEL_DESTINO,
      OrderStatus.VERIFICANDO_ENTREGA,
      OrderStatus.ENTREGADO,
      OrderStatus.CERRADO,
    ];

    const currentIndex = flow.indexOf(current);
    const nextIndex = flow.indexOf(next);

    if (nextIndex === -1) {
      throw new BadRequestException('Estado inválido');
    }

    // Cerrado es solo sistema (ejemplo, despues de calificar)
    if (next === OrderStatus.CERRADO) {
       throw new ForbiddenException('No se puede cerrar manualmente');
    }

    if (nextIndex !== currentIndex + 1) {
      if (current === OrderStatus.EN_CAMINO && next === OrderStatus.VERIFICANDO_ENTREGA) {
        return;
      }
      this.logger.warn(`[updateStatus] WARN transición no permitida: ${current} → ${next}`);
      throw new BadRequestException('Transición de estado no permitida');
    }

    // Role specific transition checks
    if (next === OrderStatus.ACEPTADO && role !== UserRole.REPARTIDOR) {
      throw new ForbiddenException('Solo repartidores pueden tomar pedidos');
    }
  }
}

