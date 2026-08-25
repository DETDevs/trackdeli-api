import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseService } from './firebase.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private firebase: FirebaseService,
  ) {}

  async registerDeviceToken(
    userId: string,
    token: string,
    platform: 'android' | 'ios',
  ): Promise<void> {
    this.logger.log(`[Notifications] Device token registrado: userId=${userId}, platform=${platform}, token=${token.substring(0, 20)}...`);
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, updatedAt: new Date() },
    });
  }

  async removeDeviceToken(token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { token } });
  }

  async getUserTokens(userId: string): Promise<string[]> {
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    return tokens.map(t => t.token);
  }

  async sendAndSave(
    userId: string,
    orderId: string | null,
    type: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<void> {
    await this.prisma.notification.create({
      data: { userId, orderId, type, title, body },
    });

    const tokens = await this.getUserTokens(userId);

    if (tokens.length > 0) {
      try {
        await this.firebase.sendToMultiple(tokens, title, body, data);
        this.logger.log(`[Notifications] Push enviado: userId=${userId}, tipo=${type}, título="${title}"`);
      } catch (error: any) {
        this.logger.warn(`[Notifications] Error enviando push: userId=${userId}, error=${error.message}`);
      }
    } else {
      this.logger.debug(`[Notifications] Sin device tokens para userId=${userId} — notificación guardada pero no enviada por push`);
    }
  }

  async notifyOrderTaken(
    encargadoId: string,
    orderId: string,
    repartidorName: string,
    customerName: string,
  ): Promise<void> {
    await this.sendAndSave(
      encargadoId,
      orderId,
      'ORDER_TAKEN',
      '📦 Pedido tomado',
      `${repartidorName} tomó el pedido de ${customerName}`,
      { orderId, type: 'ORDER_TAKEN' },
    );
  }

  async notifyOrderDelivered(
    encargadoId: string,
    orderId: string,
    customerName: string,
  ): Promise<void> {
    await this.sendAndSave(
      encargadoId,
      orderId,
      'ORDER_DELIVERED',
      '✅ Pedido entregado',
      `El pedido de ${customerName} fue entregado exitosamente`,
      { orderId, type: 'ORDER_DELIVERED' },
    );
  }

  async notifyOrderOnWayToBusiness(
    encargadoId: string,
    orderId: string,
    repartidorName: string,
  ): Promise<void> {
    await this.sendAndSave(
      encargadoId,
      orderId,
      'ORDER_ON_WAY_TO_BUSINESS',
      '🛵 Repartidor en camino',
      `${repartidorName} va en camino a recoger el pedido`,
      { orderId, type: 'ORDER_ON_WAY_TO_BUSINESS' },
    );
  }

  async notifyOrderAtBusiness(
    encargadoId: string,
    orderId: string,
    repartidorName: string,
  ): Promise<void> {
    await this.sendAndSave(
      encargadoId,
      orderId,
      'ORDER_AT_BUSINESS',
      '📍 Repartidor en el negocio',
      `${repartidorName} llegó a tu negocio a recoger el pedido`,
      { orderId, type: 'ORDER_AT_BUSINESS' },
    );
  }

  async notifyOrderOnWay(
    encargadoId: string,
    orderId: string,
    customerName: string,
  ): Promise<void> {
    await this.sendAndSave(
      encargadoId,
      orderId,
      'ORDER_ON_WAY',
      '🚚 Pedido en camino al cliente',
      `El pedido de ${customerName} ya fue recogido y va en camino`,
      { orderId, type: 'ORDER_ON_WAY' },
    );
  }

  async notifyOrderIncident(
    encargadoId: string,
    orderId: string,
    customerName: string,
    notes?: string,
  ): Promise<void> {
    await this.sendAndSave(
      encargadoId,
      orderId,
      'ORDER_INCIDENT',
      '⚠️ Incidencia en pedido',
      `Problema con el pedido de ${customerName}${notes ? ': ' + notes : ''}`,
      { orderId, type: 'ORDER_INCIDENT' },
    );
  }

  async notifyNewOrderAvailable(
    repartidorId: string,
    orderId: string,
    customerName: string,
  ): Promise<void> {
    await this.sendAndSave(
      repartidorId,
      orderId,
      'NEW_ORDER',
      '🛵 Nuevo pedido disponible',
      `Pedido de ${customerName} esperando repartidor`,
      { orderId, type: 'NEW_ORDER' },
    );
  }

  async markAsRead(userId: string, notificationIds: string[]): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id: { in: notificationIds }, userId },
      data: { readAt: new Date() },
    });
  }

  async getUserNotifications(userId: string): Promise<any[]> {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
