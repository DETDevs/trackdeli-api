import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { Order, OrderStatus, QuoteStatus, UserRole } from '@prisma/client';
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
    private readonly configService: ConfigService,
  ) {}

  private async toResponseDto(order: any): Promise<OrderResponseDto> {
    const trackingSession = await this.prisma.trackingSession.findUnique({
      where: { orderId: order.id },
    });

    const trackingBaseUrl =
      this.configService.get<string>('TRACKING_URL') ||
      'https://trackdeli-web-tracking.vercel.app';

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
      priceNegotiated: Boolean(order.priceNegotiated),
      deliveryUser: order.deliveryUser ? {
        id: order.deliveryUser.id,
        name: order.deliveryUser.name,
        phone: order.deliveryUser.phone,
      } : null,
      photos: order.photos || [],
      trackingToken: trackingSession ? trackingSession.token : null,
      trackingUrl: trackingSession
        ? `${trackingBaseUrl}/track/${trackingSession.token}`
        : null,
      createdAt: order.createdAt,
      takenAt: order.takenAt,
      deliveredAt: order.deliveredAt,
      business: order.business ? {
        id: order.business.id,
        name: order.business.name,
        latitude: order.business.latitude ? Number(order.business.latitude) : null,
        longitude: order.business.longitude ? Number(order.business.longitude) : null,
        logoUrl: order.business.logoUrl,
        whatsappNumber: (order.business as any).whatsappNumber ?? null,
        whatsappDisplay: (order.business as any).whatsappDisplay ?? null,
      } : undefined,
    };
  }

  async generateTrackingSession(orderId: string, tx?: any): Promise<string> {
    const prismaClient = tx || this.prisma;
    let trackingSession = await prismaClient.trackingSession.findUnique({
      where: { orderId },
    });

    if (!trackingSession) {
      const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h

      trackingSession = await prismaClient.trackingSession.create({
        data: {
          orderId,
          token,
          expiresAt,
        },
      });
      this.logger.log(`[Orders] Sesión de tracking generada: orderId=${orderId}, token=${token}`);
    }

    return trackingSession.token;
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
          { status: { in: [OrderStatus.PENDIENTE, OrderStatus.COTIZANDO] } },
          { deliveryUserId: userId },
        ];
      } else {
        whereClause.OR = [
          { status: { in: [OrderStatus.PENDIENTE, OrderStatus.COTIZANDO] }, businessId },
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
          select: {
            id: true,
            name: true,
            latitude: true,
            longitude: true,
            logoUrl: true,
            whatsappNumber: true,
            whatsappDisplay: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: (!businessId && role === UserRole.REPARTIDOR) ? 20 : undefined,
    });

    if (role === UserRole.REPARTIDOR && !businessId && filters?.latitude && filters?.longitude) {
      const radiusKm = 10;
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
          select: {
            id: true,
            name: true,
            latitude: true,
            longitude: true,
            logoUrl: true,
            whatsappNumber: true,
            whatsappDisplay: true,
          },
        },
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
          (order.status === OrderStatus.PENDIENTE || order.status === OrderStatus.COTIZANDO);
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
    
    await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
    });

    if (dto.status === OrderStatus.EN_CAMINO) {
      await this.generateTrackingSession(orderId);
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

    if (
      (current === OrderStatus.PENDIENTE && next === OrderStatus.COTIZANDO) ||
      (current === OrderStatus.COTIZANDO && next === OrderStatus.PENDIENTE) ||
      (current === OrderStatus.COTIZANDO && next === OrderStatus.ACEPTADO)
    ) {
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

    if (next === OrderStatus.ACEPTADO && role !== UserRole.REPARTIDOR) {
      throw new ForbiddenException('Solo repartidores pueden tomar pedidos');
    }
  }

  async getOrderQuotes(orderId: string, businessId: string | null, userId?: string, role?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (role === UserRole.ENCARGADO && order.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a las propuestas de este negocio');
    }

    if (role === UserRole.REPARTIDOR) {
      const myQuote = await this.prisma.orderQuote.findFirst({
        where: { orderId, riderId: userId, status: { not: QuoteStatus.CANCELLED } },
        include: {
          rider: {
            select: {
              id: true,
              name: true,
              phone: true,
              vehicleType: true,
              vehicleColor: true,
              vehiclePlate: true,
              profilePhotoUrl: true,
            },
          },
          messages: {
            orderBy: { createdAt: 'asc' },
            include: {
              sender: { select: { id: true, name: true, role: true } },
            },
          },
          order: {
            select: {
              id: true,
              status: true,
              customerName: true,
              destinationAddress: true,
              business: { select: { name: true } },
            },
          },
        },
      });
      if (!myQuote) throw new NotFoundException('No tenés propuesta en este pedido');
      return [myQuote];
    }

    return this.prisma.orderQuote.findMany({
      where: {
        orderId,
        status: { not: QuoteStatus.CANCELLED },
      },
      include: {
        rider: {
          select: {
            id: true,
            name: true,
            phone: true,
            vehicleType: true,
            vehicleColor: true,
            vehiclePlate: true,
            profilePhotoUrl: true,
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: { select: { id: true, name: true, role: true } },
          },
        },
      },
      orderBy: [{ distanceToBusinessKm: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async acceptQuote(orderId: string, quoteId: string, businessId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const quote = await tx.orderQuote.findUnique({
        where: { id: quoteId },
        include: { order: true, rider: true },
      });

      if (!quote || quote.orderId !== orderId) {
        throw new NotFoundException('Propuesta no encontrada para este pedido');
      }

      if (quote.order.businessId !== businessId) {
        throw new ForbiddenException('Sin acceso a esta propuesta');
      }

      if (
        quote.status !== QuoteStatus.PENDING &&
        quote.status !== QuoteStatus.NEGOTIATING
      ) {
        throw new BadRequestException('Esta propuesta ya no puede aceptarse');
      }

      const finalFee = quote.counterFee ?? quote.proposedFee;

      await tx.orderQuote.update({
        where: { id: quoteId },
        data: { status: QuoteStatus.ACCEPTED, finalFee },
      });

      await tx.orderQuote.updateMany({
        where: {
          orderId: quote.orderId,
          id: { not: quoteId },
          status: { in: [QuoteStatus.PENDING, QuoteStatus.NEGOTIATING] },
        },
        data: { status: QuoteStatus.REJECTED },
      });

      await tx.order.update({
        where: { id: quote.orderId },
        data: {
          status: OrderStatus.ACEPTADO,
          deliveryUserId: quote.riderId,
          deliveryFee: finalFee,
          priceNegotiated: true,
          takenAt: new Date(),
        },
      });

      const trackingToken = await this.generateTrackingSession(
        quote.orderId,
        tx,
      );

      const rejectedQuotes = await tx.orderQuote.findMany({
        where: { orderId: quote.orderId, status: QuoteStatus.REJECTED },
        select: { riderId: true },
      });

      return {
        quote,
        finalFee,
        trackingToken,
        rejectedRiderIds: rejectedQuotes.map((q) => q.riderId),
      };
    });

    await this.notificationsService.notifyUser(result.quote.riderId, {
      title: '✅ ¡Tu propuesta fue aceptada!',
      body: `Podés salir a recoger el pedido. Tarifa acordada: C$${result.finalFee}`,
      data: {
        type: 'QUOTE_ACCEPTED',
        orderId: result.quote.orderId,
        trackingToken: result.trackingToken,
      },
    });

    for (const riderId of result.rejectedRiderIds) {
      await this.notificationsService.notifyUser(riderId, {
        title: 'Pedido tomado por otro rider',
        body: 'Tu propuesta no fue seleccionada para este pedido',
        data: { type: 'QUOTE_REJECTED', orderId: result.quote.orderId },
      });
      this.trackingGateway.notifyRider(riderId, 'quote_rejected', {
        orderId: result.quote.orderId,
      });
    }

    this.trackingGateway.notifyBusiness(businessId, 'quote_accepted', {
      orderId: result.quote.orderId,
      riderId: result.quote.riderId,
      finalFee: result.finalFee,
    });

    this.trackingGateway.notifyRider(result.quote.riderId, 'your_quote_accepted', {
      orderId: result.quote.orderId,
      finalFee: result.finalFee,
      trackingToken: result.trackingToken,
    });

    this.trackingGateway.emitOrderStatusChange(
      result.quote.orderId,
      OrderStatus.ACEPTADO,
    );

    this.logger.log(
      `[acceptQuote] Propuesta ${quoteId} aceptada para pedido ${orderId} — rider=${result.quote.riderId} fee=C$${result.finalFee}`,
    );

    return {
      success: true,
      finalFee: result.finalFee,
      riderId: result.quote.riderId,
      trackingToken: result.trackingToken,
    };
  }

  async getQuoteMessages(
    orderId: string,
    quoteId: string,
    userId: string,
    role: UserRole,
    businessId: string | null,
  ) {
    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: quoteId },
      include: { order: true },
    });

    if (!quote || quote.orderId !== orderId) {
      throw new NotFoundException('Propuesta no encontrada para este pedido');
    }

    if (role === UserRole.REPARTIDOR && quote.riderId !== userId) {
      throw new ForbiddenException('Sin acceso a los mensajes de esta propuesta');
    }

    if (role === UserRole.ENCARGADO && quote.order.businessId !== businessId) {
      throw new ForbiddenException('Sin acceso a los mensajes de esta propuesta');
    }

    await this.prisma.orderMessage.updateMany({
      where: {
        quoteId,
        senderId: { not: userId },
        isRead: false,
      },
      data: { isRead: true },
    });

    return this.prisma.orderMessage.findMany({
      where: { quoteId },
      include: {
        sender: { select: { id: true, name: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async sendQuoteMessage(
    orderId: string,
    quoteId: string,
    userId: string,
    role: UserRole,
    businessId: string | null,
    dto: { message: string },
  ) {
    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: quoteId },
      include: { order: true, rider: true },
    });

    if (!quote || quote.orderId !== orderId) {
      throw new NotFoundException('Propuesta no encontrada para este pedido');
    }

    if (role === UserRole.REPARTIDOR && quote.riderId !== userId) {
      throw new ForbiddenException('Sin permiso para enviar mensajes en esta propuesta');
    }

    if (role === UserRole.ENCARGADO && quote.order.businessId !== businessId) {
      throw new ForbiddenException('Sin permiso para enviar mensajes en esta propuesta');
    }

    const message = await this.prisma.orderMessage.create({
      data: {
        orderId: quote.orderId,
        quoteId: quote.id,
        senderId: userId,
        senderRole: role,
        message: dto.message,
      },
      include: {
        sender: { select: { id: true, name: true, role: true } },
      },
    });

    if (role === UserRole.ENCARGADO) {
      this.trackingGateway.notifyRider(quote.riderId, 'new_message', {
        quoteId: quote.id,
        orderId: quote.orderId,
        message,
      });

      await this.notificationsService.notifyUser(quote.riderId, {
        title: '💬 Mensaje del negocio',
        body: dto.message,
        data: {
          type: 'NEW_MESSAGE',
          orderId: quote.orderId,
          quoteId: quote.id,
        },
      });
    } else {
      this.trackingGateway.notifyBusiness(quote.order.businessId, 'new_message', {
        quoteId: quote.id,
        orderId: quote.orderId,
        message,
      });

      await this.notificationsService.notifyBusiness(quote.order.businessId, {
        title: `💬 Mensaje de ${quote.rider.name}`,
        body: dto.message,
        data: {
          type: 'NEW_MESSAGE',
          orderId: quote.orderId,
          quoteId: quote.id,
        },
      });
    }

    return message;
  }

  async updateQuoteFee(
    orderId: string,
    quoteId: string,
    riderId: string,
    dto: { newFee?: number; proposedFee?: number; fee?: number; counterFee?: number; message?: string },
  ) {
    this.logger.log(
      `[updateQuoteFee] INCOMING REQUEST -> orderId=${orderId} quoteId=${quoteId} riderId=${riderId} body=${JSON.stringify(dto)}`,
    );

    const feeToSet = dto.newFee ?? dto.proposedFee ?? dto.fee ?? dto.counterFee;
    if (feeToSet === undefined || isNaN(feeToSet) || feeToSet < 0) {
      this.logger.warn(
        `[updateQuoteFee] ERROR 400: Tarifa no especificada o inválida en body=${JSON.stringify(dto)}`,
      );
      throw new BadRequestException(
        'Debe proporcionar un valor numérico válido para newFee, proposedFee o fee',
      );
    }

    const quote = await this.prisma.orderQuote.findUnique({
      where: { id: quoteId },
      include: { order: { select: { businessId: true } }, rider: true },
    });

    if (!quote || quote.orderId !== orderId) {
      this.logger.warn(
        `[updateQuoteFee] ERROR 404: Propuesta ${quoteId} no pertenece al pedido ${orderId} o no existe`,
      );
      throw new NotFoundException('Propuesta no encontrada para este pedido');
    }

    if (quote.riderId !== riderId) {
      this.logger.warn(
        `[updateQuoteFee] ERROR 403: quote.riderId=${quote.riderId} no coincide con usuario=${riderId}`,
      );
      throw new ForbiddenException('Sin acceso');
    }

    if (
      quote.status !== QuoteStatus.PENDING &&
      quote.status !== QuoteStatus.NEGOTIATING
    ) {
      this.logger.warn(
        `[updateQuoteFee] ERROR 400: Estado actual de la propuesta "${quote.status}" no permite cambios`,
      );
      throw new BadRequestException(`No podés modificar esta propuesta porque su estado es ${quote.status}`);
    }

    try {
      await this.prisma.orderQuote.update({
        where: { id: quoteId },
        data: {
          proposedFee: feeToSet,
          counterFee: null,
          status: QuoteStatus.NEGOTIATING,
        },
      });

      let messageRecord: any = null;
      if (dto.message) {
        messageRecord = await this.prisma.orderMessage.create({
          data: {
            orderId: quote.orderId,
            quoteId: quote.id,
            senderId: riderId,
            senderRole: UserRole.REPARTIDOR,
            message: dto.message,
          },
          include: {
            sender: { select: { id: true, name: true, role: true } },
          },
        });
      }

      this.trackingGateway.notifyBusiness(quote.order.businessId, 'quote_updated', {
        quoteId: quote.id,
        orderId: quote.orderId,
        riderId,
        riderName: quote.rider?.name ?? 'El repartidor',
        newFee: feeToSet,
        message: dto.message,
      });

      await this.notificationsService.notifyBusiness(quote.order.businessId, {
        title: '💰 Un rider actualizó su precio',
        body: `${quote.rider?.name ?? 'El repartidor'} propone C$${feeToSet}${dto.message ? ': ' + dto.message : ''}`,
        data: { type: 'QUOTE_UPDATED', orderId: quote.orderId, quoteId: quote.id },
      });

      this.logger.log(
        `[updateQuoteFee] OK: quoteId=${quoteId} orderId=${orderId} riderId=${riderId} newFee=C$${feeToSet}`,
      );

      return { success: true, newFee: feeToSet, message: messageRecord };
    } catch (err: any) {
      this.logger.error(`[updateQuoteFee] ERROR INESPERADO: ${err.message}`, err.stack);
      throw err;
    }
  }
}
