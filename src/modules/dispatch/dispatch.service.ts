import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { haversineDistance } from '../../common/utils/pricing.util';
import { BusinessProductType, DispatchStatus, OrderStatus, UserRole } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import {
  ACTIVE_ORDER_STATUSES,
  MAX_ACTIVE_ORDERS_ERROR_MESSAGE,
  MAX_ACTIVE_ORDERS_PER_RIDER,
} from '../../common/constants/orders.constants';
import { BusinessProductsService } from '../business-products/business-products.service';

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly trackingGateway: TrackingGateway,
    private readonly businessProductsService: BusinessProductsService,
  ) {}

  async dispatchOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { business: true },
    });

    if (!order) {
      this.logger.warn(`[dispatchOrder] Pedido no encontrado: orderId=${orderId}`);
      return;
    }

    const isDeliveryActive = await this.businessProductsService.isActive(
      order.businessId,
      BusinessProductType.DELIVERY,
    );
    if (!isDeliveryActive) {
      this.logger.warn(
        `[dispatchOrder] Producto DELIVERY inactivo para negocio — orderId=${orderId} businessId=${order.businessId}. Despacho cancelado/omitido.`,
      );
      return;
    }

    if (!order.business?.latitude || !order.business?.longitude) {
      this.logger.warn(`[dispatchOrder] Negocio sin ubicación configurada — orderId=${orderId}. Queda en PENDIENTE.`);
      return;
    }

    await this.dispatchToNextRider(order, 1);
  }

  async dispatchToNextRider(order: any, attempt: number): Promise<void> {

    const triedDispatches = await this.prisma.orderDispatch.findMany({
      where: { orderId: order.id },
      select: { riderId: true },
    });
    const triedRiderIds = triedDispatches.map((d) => d.riderId);

    const whereRider: any = {
      role: UserRole.REPARTIDOR,
      isActive: true,
      isAvailable: true,
      id: { notIn: triedRiderIds },
      deliveredOrders: {
        none: {
          status: { in: ACTIVE_ORDER_STATUSES },
        },
      },
    };

    if (order.business?.businessType === 'EMPRESA_RIDERS') {
      whereRider.businessId = order.businessId;
    }

    let riders = await this.prisma.user.findMany({
      where: {
        ...whereRider,
        lastLocationAt: {
          gte: new Date(Date.now() - 30 * 60 * 1000),
        },
      },
      select: {
        id: true,
        name: true,
        currentLatitude: true,
        currentLongitude: true,
      },
    });

    if (riders.length === 0) {
      riders = await this.prisma.user.findMany({
        where: whereRider,
        select: {
          id: true,
          name: true,
          currentLatitude: true,
          currentLongitude: true,
        },
      });
    }

    if (riders.length === 0) {
      this.logger.warn(`[dispatch] Sin riders disponibles — orderId=${order.id} attempt=${attempt}`);
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PENDIENTE },
      });

      this.trackingGateway.emitOrderStatusChange(order.id, OrderStatus.PENDIENTE);
      this.trackingGateway.notifyBusiness(order.businessId, 'no_riders_available', {
        orderId: order.id,
        attempt,
      });

      await this.notificationsService.notifyBusiness(order.businessId, {
        title: '⚠️ Sin repartidores disponibles',
        body: 'No hay repartidores cerca para este pedido. Revisalo en el panel.',
        data: { type: 'NO_RIDERS', orderId: order.id },
      });
      return;
    }

    const bizLat = Number(order.business.latitude);
    const bizLng = Number(order.business.longitude);

    const ridersWithDistance = riders
      .filter((r) => r.currentLatitude && r.currentLongitude)
      .map((r) => ({
        ...r,
        distance: haversineDistance(
          Number(r.currentLatitude),
          Number(r.currentLongitude),
          bizLat,
          bizLng,
        ),
      }))
      .sort((a, b) => a.distance - b.distance);

    const targetRider = ridersWithDistance[0] ?? riders[0];

    const timeoutMinutes = order.business.dispatchTimeoutMin || 3;
    const timeoutAt = new Date(Date.now() + timeoutMinutes * 60 * 1000);

    const dispatch = await this.prisma.orderDispatch.create({
      data: {
        orderId: order.id,
        riderId: targetRider.id,
        attempt,
        status: DispatchStatus.SENT,
        timeoutAt,
      },
    });

    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.OFERTADO },
    });

    this.trackingGateway.emitOrderStatusChange(order.id, OrderStatus.OFERTADO);

    await this.notificationsService.sendAndSave(
      targetRider.id,
      order.id,
      'ORDER_DISPATCHED',
      '🛵 ¡Nuevo pedido para vos!',
      `Tenés ${timeoutMinutes} minutos para aceptar o rechazar`,
      {
        type: 'ORDER_DISPATCHED',
        orderId: order.id,
        dispatchId: dispatch.id,
        timeoutAt: timeoutAt.toISOString(),
      },
    );

    this.trackingGateway.notifyRider(targetRider.id, 'order_dispatched', {
      orderId: order.id,
      dispatchId: dispatch.id,
      attempt,
      timeoutAt: timeoutAt.toISOString(),
      customerName: order.customerName,
      destinationAddress: order.destinationAddress,
      deliveryFee: Number(order.deliveryFee),
    });

    this.logger.log(
      `[dispatch] orderId=${order.id} → riderId=${targetRider.id} (${targetRider.name}) attempt=${attempt} timeout=${timeoutMinutes}min`,
    );

    setTimeout(async () => {
      try {
        await this.handleTimeout(order.id, targetRider.id, attempt);
      } catch (err: any) {
        this.logger.error(`[handleTimeout] Error procesando timeout: ${err.message}`, err.stack);
      }
    }, timeoutMinutes * 60 * 1000);
  }

  @Cron('*/30 * * * * *')
  async reconcileExpiredDispatches(): Promise<void> {
    try {
      const expiredDispatches = await this.prisma.orderDispatch.findMany({
        where: {
          status: DispatchStatus.SENT,
          timeoutAt: { lte: new Date() },
        },
        include: { order: true },
      });

      if (expiredDispatches.length > 0) {
        this.logger.warn(
          `[reconcileExpiredDispatches] Detectados ${expiredDispatches.length} despachos vencidos pendientes de reconciliación`,
        );
      }

      for (const d of expiredDispatches) {
        await this.handleTimeout(d.orderId, d.riderId, d.attempt);
      }
    } catch (err: any) {
      this.logger.error(
        `[reconcileExpiredDispatches] Error al reconciliar despachos: ${err.message}`,
        err.stack,
      );
    }
  }

  async handleTimeout(orderId: string, riderId: string, attempt: number): Promise<void> {
    const dispatch = await this.prisma.orderDispatch.findFirst({
      where: { orderId, riderId, attempt, status: DispatchStatus.SENT },
    });

    if (!dispatch) {
      return;
    }

    const updateResult = await this.prisma.orderDispatch.updateMany({
      where: { id: dispatch.id, status: DispatchStatus.SENT },
      data: { status: DispatchStatus.TIMEOUT, respondedAt: new Date() },
    });

    if (updateResult.count === 0) {
      return;
    }

    this.logger.warn(`[dispatch] TIMEOUT orderId=${orderId} riderId=${riderId} attempt=${attempt}`);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { business: true },
    });

    if (order && order.status === OrderStatus.OFERTADO) {
      await this.dispatchToNextRider(order, attempt + 1);
    }
  }

  async acceptDispatch(orderId: string, riderId: string) {
    return this.prisma.$transaction(async (tx) => {

      const dispatch = await tx.orderDispatch.findFirst({
        where: { orderId, riderId },
        orderBy: { sentAt: 'desc' },
      });

      if (!dispatch) {

        const activeOtherDispatch = await tx.orderDispatch.findFirst({
          where: { orderId, status: DispatchStatus.SENT },
        });
        if (activeOtherDispatch) {
          throw new BadRequestException('Esta oferta fue asignada a otro repartidor.');
        }
        throw new BadRequestException('No tenés una oferta de pedido pendiente de respuesta.');
      }

      const currentOrder = await tx.order.findUnique({
        where: { id: orderId },
        include: { business: true, deliveryUser: true },
      });
      if (!currentOrder) {
        throw new NotFoundException('Pedido no encontrado.');
      }

      if (dispatch.status === DispatchStatus.ACCEPTED && currentOrder.deliveryUserId === riderId) {
        this.logger.log(`[dispatch] Reintento idempotente exitoso: orderId=${orderId} ya asignado a riderId=${riderId}`);
        return currentOrder;
      }

      const isPastTimeout = new Date().getTime() > dispatch.timeoutAt.getTime() + 10000;
      if (dispatch.status === DispatchStatus.TIMEOUT || isPastTimeout) {
        throw new BadRequestException('El tiempo para responder a la oferta expiró.');
      }

      if (dispatch.status === DispatchStatus.REJECTED) {
        throw new BadRequestException('Ya habías rechazado esta oferta.');
      }

      if (dispatch.status === DispatchStatus.ACCEPTED) {
        throw new BadRequestException('Esta oferta ya fue aceptada.');
      }

      if (dispatch.status !== DispatchStatus.SENT) {
        throw new BadRequestException(`La oferta ya no está disponible (${dispatch.status}).`);
      }

      if (currentOrder.status === OrderStatus.CANCELADO) {
        throw new BadRequestException('El pedido fue cancelado.');
      }
      if (currentOrder.deliveryUserId && currentOrder.deliveryUserId !== riderId) {
        throw new BadRequestException('El pedido ya fue tomado por otro repartidor.');
      }

      const activeOrdersCount = await tx.order.count({
        where: {
          deliveryUserId: riderId,
          status: { in: ACTIVE_ORDER_STATUSES },
        },
      });
      if (activeOrdersCount >= MAX_ACTIVE_ORDERS_PER_RIDER) {
        this.logger.warn(`[acceptDispatch] CONFLICT orderId=${orderId} riderId=${riderId} ya tiene ${activeOrdersCount} pedidos activos`);
        throw new ConflictException(MAX_ACTIVE_ORDERS_ERROR_MESSAGE);
      }

      await tx.orderDispatch.update({
        where: { id: dispatch.id },
        data: { status: DispatchStatus.ACCEPTED, respondedAt: new Date() },
      });

      const order = await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.ACEPTADO,
          deliveryUserId: riderId,
          takenAt: new Date(),
        },
        include: { business: true, deliveryUser: true },
      });

      this.logger.log(`[dispatch] ACCEPTED orderId=${orderId} riderId=${riderId}`);
      return order;
    });
  }

  async rejectDispatch(orderId: string, riderId: string) {
    const dispatch = await this.prisma.orderDispatch.findFirst({
      where: { orderId, riderId },
      orderBy: { sentAt: 'desc' },
      include: { order: { include: { business: true } } },
    });

    if (!dispatch) {
      throw new BadRequestException('No tenés una oferta de pedido pendiente de respuesta.');
    }

    if (dispatch.status !== DispatchStatus.SENT) {
      return { success: true, message: 'Oferta finalizada' };
    }

    await this.prisma.orderDispatch.update({
      where: { id: dispatch.id },
      data: { status: DispatchStatus.REJECTED, respondedAt: new Date() },
    });

    this.logger.log(`[dispatch] REJECTED orderId=${orderId} riderId=${riderId} attempt=${dispatch.attempt}`);

    if (dispatch.order) {
      await this.dispatchToNextRider(dispatch.order, dispatch.attempt + 1);
    }

    return { success: true, message: 'Oferta rechazada' };
  }
}

