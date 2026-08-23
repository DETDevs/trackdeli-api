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
    };
  }

  async create(dto: CreateOrderDto, createdBy: string, businessId: string): Promise<OrderResponseDto> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      throw new NotFoundException('Negocio no encontrado');
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
        deliveryFee: dto.deliveryFee || 0,
        status: OrderStatus.PENDIENTE,
        businessId,
        createdBy,
      },
      include: {
        deliveryUser: true,
        photos: true,
      },
    });

    this.logger.log(`[Orders] Pedido creado: id=${order.id}, cliente=${dto.customerName}, negocio=${businessId}, creadoPor=${createdBy}`);

    const repartidores = await this.prisma.user.findMany({
      where: { businessId, role: 'REPARTIDOR', isActive: true },
    });
    
    await Promise.allSettled(
      repartidores.map(r =>
        this.notificationsService.notifyNewOrderAvailable(r.id, order.id, order.customerName)
      )
    );

    return this.toResponseDto(order);
  }

  async findAllByBusiness(businessId: string, userId: string, role: UserRole, filters?: { status?: OrderStatus }): Promise<OrderResponseDto[]> {
    let whereClause: any = { businessId };

    if (role === UserRole.REPARTIDOR) {
      whereClause.OR = [
        { status: OrderStatus.PENDIENTE },
        { deliveryUserId: userId },
      ];
    }

    if (filters?.status) {
      whereClause.status = filters.status;
    }

    const orders = await this.prisma.order.findMany({
      where: whereClause,
      include: {
        deliveryUser: true,
        photos: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(orders.map(o => this.toResponseDto(o)));
  }

  async findOne(id: string, businessId: string): Promise<OrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        deliveryUser: true,
        photos: true,
      },
    });

    if (!order || order.businessId !== businessId) {
      throw new NotFoundException('Pedido no encontrado');
    }

    return this.toResponseDto(order);
  }

  async takeOrder(orderId: string, deliveryUserId: string, businessId: string): Promise<OrderResponseDto> {
    this.logger.log(`[Orders] Intento de tomar pedido: orderId=${orderId}, repartidor=${deliveryUserId}, negocio=${businessId}`);

    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        businessId,
        status: OrderStatus.PENDIENTE,
        deliveryUserId: null,
      },
      data: {
        status: OrderStatus.TOMADO,
        deliveryUserId,
        takenAt: new Date(),
      },
    });

    if (result.count === 0) {
      this.logger.warn(`[Orders] CONFLICT takeOrder: orderId=${orderId} ya fue tomado. Repartidor intentado=${deliveryUserId}`);
      throw new ConflictException('Pedido no disponible — ya fue tomado por otro repartidor');
    }

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

    this.logger.log(`[Orders] Pedido tomado exitosamente: orderId=${orderId}, asignado a=${deliveryUserId}, token=${token}`);
    this.trackingGateway.emitOrderStatusChange(orderId, OrderStatus.TOMADO);

    const orderData = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { deliveryUser: true },
    });

    if (orderData && orderData.deliveryUser) {
      const encargado = await this.prisma.user.findFirst({
        where: { businessId: orderData.businessId, role: 'ENCARGADO' },
      });
      if (encargado) {
        await this.notificationsService.notifyOrderTaken(
          encargado.id,
          orderId,
          orderData.deliveryUser.name,
          orderData.customerName,
        );
      }
    }

    return this.findOne(orderId, businessId);
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

  async updateStatus(orderId: string, dto: UpdateOrderStatusDto, userId: string, role: UserRole, businessId: string): Promise<OrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order || order.businessId !== businessId) {
      throw new NotFoundException('Pedido no encontrado');
    }

    if (role === UserRole.REPARTIDOR && order.deliveryUserId !== userId) {
      throw new ForbiddenException('No tienes permiso para actualizar este pedido');
    }

    this.logger.log(`[Orders] Cambio de estado: orderId=${orderId}, de=${order.status}, a=${dto.status}, usuario=${userId}, rol=${role}`);

    try {
      this.validateStateTransition(order.status, dto.status, role);
    } catch (e) {
      this.logger.warn(`[Orders] Transición inválida: orderId=${orderId}, de=${order.status}, a=${dto.status}, usuario=${userId}`);
      throw e;
    }

    const updateData: any = { status: dto.status };
    if (dto.status === OrderStatus.ENTREGADO) {
      updateData.deliveredAt = new Date();
    }
    
    // Notes or incidence logic goes here (create notification or incidence log in future)
    // For now we just update the status

    await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
    });

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
      OrderStatus.TOMADO,
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
      throw new BadRequestException('Transición de estado no permitida');
    }

    // Role specific transition checks
    if (next === OrderStatus.TOMADO && role !== UserRole.REPARTIDOR) {
      throw new ForbiddenException('Solo repartidores pueden tomar pedidos');
    }
  }
}
