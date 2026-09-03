import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TrackingGateway } from '../tracking/tracking.gateway';
import { haversineDistance } from '../../common/utils/pricing.util';
import { DispatchStatus, OrderStatus, UserRole } from '@prisma/client';

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly trackingGateway: TrackingGateway,
  ) {}

  /**
   * Inicia el flujo de despacho en cascada para un pedido.
   */
  async dispatchOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { business: true },
    });

    if (!order) {
      this.logger.warn(`[dispatchOrder] Pedido no encontrado: orderId=${orderId}`);
      return;
    }

    if (!order.business?.latitude || !order.business?.longitude) {
      this.logger.warn(`[dispatchOrder] Negocio sin ubicación configurada — orderId=${orderId}. Queda en PENDIENTE.`);
      return;
    }

    await this.dispatchToNextRider(order, 1);
  }

  /**
   * Intenta despachar el pedido al siguiente repartidor más cercano disponible.
   */
  async dispatchToNextRider(order: any, attempt: number): Promise<void> {
    // 1. Obtener IDs de repartidores ya intentados para este pedido
    const triedDispatches = await this.prisma.orderDispatch.findMany({
      where: { orderId: order.id },
      select: { riderId: true },
    });
    const triedRiderIds = triedDispatches.map((d) => d.riderId);

    // 2. Buscar repartidores disponibles no intentados
    const whereRider: any = {
      role: UserRole.REPARTIDOR,
      isActive: true,
      isAvailable: true,
      id: { notIn: triedRiderIds },
    };

    // Si el negocio es EMPRESA_RIDERS, priorizar sus propios riders
    if (order.business?.businessType === 'EMPRESA_RIDERS') {
      whereRider.businessId = order.businessId;
    }

    let riders = await this.prisma.user.findMany({
      where: {
        ...whereRider,
        lastLocationAt: {
          gte: new Date(Date.now() - 30 * 60 * 1000), // Activos en últimos 30 min
        },
      },
      select: {
        id: true,
        name: true,
        currentLatitude: true,
        currentLongitude: true,
      },
    });

    // Fallback: si no hay con ubicación reciente, buscar cualquier rider activo disponible
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

    // 3. Si no hay riders disponibles
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

    // 4. Ordenar candidatos por distancia Haversine al negocio de origen
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

    // 5. Calcular timeout
    const timeoutMinutes = order.business.dispatchTimeoutMin || 3;
    const timeoutAt = new Date(Date.now() + timeoutMinutes * 60 * 1000);

    // 6. Registrar el intento de dispatch
    const dispatch = await this.prisma.orderDispatch.create({
      data: {
        orderId: order.id,
        riderId: targetRider.id,
        attempt,
        status: DispatchStatus.SENT,
        timeoutAt,
      },
    });

    // 7. Cambiar estado del pedido a OFERTADO
    await this.prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.OFERTADO },
    });

    this.trackingGateway.emitOrderStatusChange(order.id, OrderStatus.OFERTADO);

    // 8. Notificar al rider seleccionado (Push + WebSocket)
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

    // 9. Programar timeout automático
    setTimeout(async () => {
      try {
        await this.handleTimeout(order.id, targetRider.id, attempt);
      } catch (err: any) {
        this.logger.error(`[handleTimeout] Error procesando timeout: ${err.message}`, err.stack);
      }
    }, timeoutMinutes * 60 * 1000);
  }

  /**
   * Maneja la expiración de tiempo de respuesta de un dispatch.
   */
  async handleTimeout(orderId: string, riderId: string, attempt: number): Promise<void> {
    const dispatch = await this.prisma.orderDispatch.findFirst({
      where: { orderId, riderId, attempt, status: DispatchStatus.SENT },
    });

    if (!dispatch) {
      return; // Ya fue aceptado o rechazado
    }

    await this.prisma.orderDispatch.update({
      where: { id: dispatch.id },
      data: { status: DispatchStatus.TIMEOUT, respondedAt: new Date() },
    });

    this.logger.warn(`[dispatch] TIMEOUT orderId=${orderId} riderId=${riderId} attempt=${attempt}`);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { business: true },
    });

    if (order && order.status === OrderStatus.OFERTADO) {
      await this.dispatchToNextRider(order, attempt + 1);
    }
  }

  /**
   * Repartidor acepta la asignación.
   */
  async acceptDispatch(orderId: string, riderId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Buscar si existe oferta para este rider en este pedido
      const dispatch = await tx.orderDispatch.findFirst({
        where: { orderId, riderId },
        orderBy: { sentAt: 'desc' },
      });

      if (!dispatch) {
        // Verificar si la oferta está activa para otro rider
        const activeOtherDispatch = await tx.orderDispatch.findFirst({
          where: { orderId, status: DispatchStatus.SENT },
        });
        if (activeOtherDispatch) {
          throw new BadRequestException('Esta oferta fue asignada a otro repartidor.');
        }
        throw new BadRequestException('No tenés una oferta de pedido pendiente de respuesta.');
      }

      // 2. Verificar estado de la oferta (con 10s de tolerancia para compensar latencia de red)
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

      // 3. Verificar estado del pedido
      const currentOrder = await tx.order.findUnique({
        where: { id: orderId },
      });
      if (!currentOrder) {
        throw new NotFoundException('Pedido no encontrado.');
      }
      if (currentOrder.status === OrderStatus.CANCELADO) {
        throw new BadRequestException('El pedido fue cancelado.');
      }
      if (currentOrder.deliveryUserId && currentOrder.deliveryUserId !== riderId) {
        throw new BadRequestException('El pedido ya fue tomado por otro repartidor.');
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

  /**
   * Repartidor rechaza la asignación.
   */
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
