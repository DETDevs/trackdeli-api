import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';
import { FirebaseMultipleSendResult, FirebaseService } from './firebase.service';
import { NotificationChannel, NotificationLogStatus, NotificationLog } from '@prisma/client';
import { NotificationsProcessor } from './processors/notifications.processor';
import { NotificationVariables } from './templates/notification-template.registry';

export interface DispatchNotificationDto {
  businessId?: string;
  channel: NotificationChannel;
  event: string;
  recipientContact: string;
  variables: NotificationVariables;
  relatedEntityType?: string;
  relatedEntityId?: string;
  awaitDirect?: boolean;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private firebase: FirebaseService,
    private processor: NotificationsProcessor,
    @Optional()
    @InjectQueue('notifications')
    private readonly notificationsQueue?: Queue,
  ) {}

  onModuleInit() {
    if (this.notificationsQueue) {
      this.notificationsQueue.on('error', (err) => {
        this.logger.warn(`[NotificationsService] Advertencia en cola Bull/Redis: ${err.message}`);
      });
    }
  }

  async registerDeviceToken(
    userId: string,
    token: string,
    platform: 'android' | 'ios',
  ): Promise<void> {
    this.logger.log(`[Notifications] Device token registrado: userId=${userId}, platform=${platform}, token=${token.substring(0, 20)}...`);
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, updatedAt: new Date() },
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
  ): Promise<{ saved: boolean; pushResult?: FirebaseMultipleSendResult }> {
    await this.prisma.notification.create({
      data: { userId, orderId, type, title, body },
    });

    const tokens = await this.getUserTokens(userId);

    if (tokens.length > 0) {
      try {
        const pushResult = await this.firebase.sendToMultiple(tokens, title, body, data);
        if (pushResult.sent > 0 && pushResult.failed === 0) {
          this.logger.log(
            `[sendAndSave] OK push enviado: userId=${userId}, tipo=${type}, título="${title}", enviados=${pushResult.sent}/${pushResult.total}`,
          );
        } else if (pushResult.sent > 0 && pushResult.failed > 0) {
          this.logger.warn(
            `[sendAndSave] Push PARCIAL para userId=${userId}: tipo=${type}, enviados=${pushResult.sent}/${pushResult.total}, fallidos=${pushResult.failed} | Errores: ${pushResult.errors.join('; ')}`,
          );
        } else {
          this.logger.error(
            `[sendAndSave] Push FALLÓ para userId=${userId}: tipo=${type}, dispositivos=${tokens.length} | Causa: ${pushResult.errors.join('; ') || 'Error desconocido en Firebase'}`,
          );
        }
        return { saved: true, pushResult };
      } catch (error: any) {
        this.logger.error(
          `[sendAndSave] ERROR no controlado enviando push: userId=${userId}, error=${error.message}`,
          error.stack,
        );
        return {
          saved: true,
          pushResult: {
            sent: 0,
            failed: tokens.length,
            total: tokens.length,
            results: [],
            errors: [error.message],
          },
        };
      }
    } else {
      this.logger.debug(
        `[sendAndSave] Sin device tokens para userId=${userId} — notificación guardada en BD pero no enviada por push`,
      );
      return { saved: true };
    }
  }

  async sendTestPush(userId: string): Promise<{ success: boolean; tokensCount: number; message: string }> {
    const tokens = await this.getUserTokens(userId);
    if (tokens.length === 0) {
      return {
        success: false,
        tokensCount: 0,
        message: 'No hay device tokens registrados para este usuario en la base de datos. Abre la app del rider habiendo iniciado sesión para registrar tu dispositivo.',
      };
    }

    const pushResult = await this.firebase.sendToMultiple(
      tokens,
      '🔔 Notificación de prueba',
      'El servicio de notificaciones Push de TrackDeli está funcionando correctamente.',
      { type: 'TEST', timestamp: new Date().toISOString() },
    );

    if (pushResult.sent === 0) {
      const errorDetail = pushResult.errors.join('; ') || 'Error de autenticación o envío en Firebase';
      this.logger.error(`[sendTestPush] Falló envío a todos los dispositivos de userId=${userId}: ${errorDetail}`);
      return {
        success: false,
        tokensCount: tokens.length,
        message: `Fallo al enviar push: ${errorDetail}`,
      };
    }

    if (pushResult.failed > 0) {
      this.logger.warn(`[sendTestPush] Envío parcial a userId=${userId}: ${pushResult.sent}/${pushResult.total} enviados`);
      return {
        success: true,
        tokensCount: pushResult.sent,
        message: `Push de prueba enviado a ${pushResult.sent} de ${tokens.length} dispositivo(s). Fallaron ${pushResult.failed}.`,
      };
    }

    return {
      success: true,
      tokensCount: pushResult.sent,
      message: `Push de prueba enviado exitosamente a ${pushResult.sent} dispositivo(s).`,
    };
  }

  async notifyUser(
    userId: string,
    options: { title: string; body: string; data?: Record<string, string> },
  ): Promise<void> {
    const type = options.data?.type || 'NOTIFICATION';
    const orderId = options.data?.orderId || null;
    await this.sendAndSave(userId, orderId, type, options.title, options.body, options.data);
  }

  async notifyBusiness(
    businessId: string,
    options: { title: string; body: string; data?: Record<string, string> },
  ): Promise<void> {
    const encargados = await this.prisma.user.findMany({
      where: { businessId, role: 'ENCARGADO', isActive: true },
      select: { id: true },
    });

    await Promise.allSettled(
      encargados.map(e => this.notifyUser(e.id, options)),
    );
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
      '📋 Pedido tomado',
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
      '🏪 Repartidor en el negocio',
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
      '📦 Pedido en camino al cliente',
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

  /**
   * Encola y gestiona el envío asíncrono de notificaciones multicanal (Email / WhatsApp)
   * registrando trazabilidad completa en NotificationLog.
   */
  async dispatchNotification(dto: DispatchNotificationDto): Promise<NotificationLog> {
    const {
      businessId,
      channel,
      event,
      recipientContact,
      variables,
      relatedEntityType,
      relatedEntityId,
    } = dto;

    // 1. Crear registro NotificationLog en estado inicial PENDING
    const log = await this.prisma.notificationLog.create({
      data: {
        businessId: businessId || null,
        channel,
        event,
        recipientContact,
        status: NotificationLogStatus.PENDING,
        relatedEntityType: relatedEntityType || null,
        relatedEntityId: relatedEntityId || null,
        metadata: variables as any,
      },
    });

    // Si se solicita awaitDirect (ej. confirmación inmediata para marcar autoSent),
    // procesar de forma directa y retornar el estado final registrado
    if (dto.awaitDirect) {
      try {
        await this.processor.processNotification(log.id, false);
      } catch (procErr: any) {
        this.logger.error(
          `[NotificationsService] Error en procesamiento directo de notificación ${log.id}: ${procErr.message}`,
        );
      }
      const updatedLog = await this.prisma.notificationLog.findUnique({
        where: { id: log.id },
      });
      return updatedLog || log;
    }

    // 2. Intentar encolar en Bull / Redis
    let enqueued = false;
    try {
      if (this.notificationsQueue) {
        await this.notificationsQueue.add(
          'send',
          { logId: log.id },
          {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
        enqueued = true;
      }
    } catch (err: any) {
      this.logger.warn(
        `[NotificationsService] ⚠ No se pudo encolar en Bull/Redis (${err.message}). Ejecutando en segundo plano de respaldo.`,
      );
    }

    // 3. Fallback asíncrono inmediato si Redis no está disponible, para no bloquear el endpoint ni fallar la transacción
    if (!enqueued) {
      setImmediate(async () => {
        try {
          await this.processor.processNotification(log.id, false);
        } catch (procErr: any) {
          this.logger.error(
            `[NotificationsService] Error en procesamiento en segundo plano (fallback): ${procErr.message}`,
          );
        }
      });
    }

    return log;
  }

  /**
   * Consulta registros de auditoría de notificaciones.
   */
  async getNotificationLogs(filter: {
    businessId?: string;
    channel?: NotificationChannel;
    status?: NotificationLogStatus;
    event?: string;
    relatedEntityType?: string;
    relatedEntityId?: string;
    take?: number;
  }): Promise<NotificationLog[]> {
    return this.prisma.notificationLog.findMany({
      where: {
        businessId: filter.businessId,
        channel: filter.channel,
        status: filter.status,
        event: filter.event,
        relatedEntityType: filter.relatedEntityType,
        relatedEntityId: filter.relatedEntityId,
      },
      orderBy: { createdAt: 'desc' },
      take: filter.take || 50,
    });
  }
}

