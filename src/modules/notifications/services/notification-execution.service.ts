import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationChannel, NotificationLogStatus } from '@prisma/client';
import { EmailChannel } from '../channels/email.channel';
import { WhatsAppChannel } from '../channels/whatsapp.channel';
import { NotificationTemplateRegistry } from '../templates/notification-template.registry';

@Injectable()
export class NotificationExecutionService {
  protected readonly logger = new Logger(NotificationExecutionService.name);

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly emailChannel: EmailChannel,
    protected readonly whatsappChannel: WhatsAppChannel,
    protected readonly templateRegistry: NotificationTemplateRegistry,
  ) {}

  /**
   * Ejecuta el envío de una notificación dado su ID de log.
   * Si shouldRethrow es true (ej. dentro de un job Bull), relanza errores para reintento automático.
   */
  async processNotification(logId: string, shouldRethrow = false): Promise<void> {
    const log = await this.prisma.notificationLog.findUnique({
      where: { id: logId },
    });

    if (!log) {
      this.logger.error(`[NotificationExecutionService] NotificationLog con ID ${logId} no encontrado.`);
      return;
    }

    // Idempotencia: si ya fue enviado o simulado con éxito, no duplicar
    if (
      log.status === NotificationLogStatus.SENT ||
      log.status === NotificationLogStatus.SIMULATED
    ) {
      this.logger.debug(
        `[NotificationExecutionService] Log ${logId} ya procesado (${log.status}). Omitiendo duplicado.`,
      );
      return;
    }

    const variables = (log.metadata as Record<string, any>) || {};
    const rendered = this.templateRegistry.render(log.event, log.channel, variables);

    let sendResult: {
      success: boolean;
      simulated: boolean;
      messageId?: string;
      error?: string;
    };

    if (log.channel === NotificationChannel.EMAIL) {
      sendResult = await this.emailChannel.send({
        to: log.recipientContact,
        subject: rendered.subject || `Notificación de ${variables.businessName || 'TrackDeli'}`,
        html: rendered.html || `<p>${rendered.text}</p>`,
        text: rendered.text,
        metadata: variables,
      });
    } else if (log.channel === NotificationChannel.WHATSAPP) {
      sendResult = await this.whatsappChannel.send({
        to: log.recipientContact,
        text: rendered.text,
        templateName: rendered.templateName,
        templateParams: rendered.templateParams,
        buttonSuffix: rendered.buttonSuffix,
        metadata: variables,
      });
    } else {
      this.logger.error(
        `[NotificationExecutionService] Canal no soportado: ${log.channel} para log ${logId}`,
      );
      sendResult = {
        success: false,
        simulated: false,
        error: `Canal no soportado: ${log.channel}`,
      };
    }

    if (sendResult.success) {
      const finalStatus = sendResult.simulated
        ? NotificationLogStatus.SIMULATED
        : NotificationLogStatus.SENT;

      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: finalStatus,
          sentAt: new Date(),
          errorMessage: null,
          metadata: {
            ...variables,
            ...(sendResult.messageId ? { wamid: sendResult.messageId } : {}),
          },
        },
      });

      this.logger.log(
        `[NotificationExecutionService] ✓ Notificación ${logId} procesada exitosamente como ${finalStatus} (${log.channel} → ${log.recipientContact})`,
      );
    } else {
      await this.prisma.notificationLog.update({
        where: { id: logId },
        data: {
          status: NotificationLogStatus.FAILED,
          errorMessage: sendResult.error || 'Error en envío',
        },
      });

      this.logger.warn(
        `[NotificationExecutionService] ⚠ Notificación ${logId} marcada como FAILED: ${sendResult.error}`,
      );

      if (shouldRethrow) {
        throw new Error(sendResult.error || 'Fallo en envío de notificación');
      }
    }
  }
}
